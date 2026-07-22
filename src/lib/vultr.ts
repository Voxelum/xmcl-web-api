export interface VultrInstance {
  id: string;
  region: string;
  plan: string;
  label: string;
  status: string;
  powerStatus: string;
  serverStatus: string;
  address?: string;
}

export interface CreateVultrInstance {
  serverId: string;
  plan: string;
  userData: string;
}

export interface VultrAdapter {
  validateCapacity(plan: string): Promise<void>;
  createInstance(input: CreateVultrInstance): Promise<VultrInstance>;
  reconcileCreate(serverId: string): Promise<VultrInstance | undefined>;
  getInstance(instanceId: string): Promise<VultrInstance | undefined>;
  start(instanceId: string): Promise<void>;
  halt(instanceId: string): Promise<void>;
  reboot(instanceId: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
}

export class VultrError extends Error {
  constructor(
    readonly code:
      | "provider_rejected"
      | "provider_unavailable"
      | "provider_unknown"
      | "invalid_provider_response"
      | "capacity_unavailable",
    readonly outcome: "definitive" | "unknown",
    readonly status?: number,
  ) {
    super(code);
  }
}

interface VultrClientOptions {
  token: string;
  taipeiRegionId: string;
  allowedPlans: readonly string[];
  imageId: string | number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

interface VultrInstanceJson {
  id?: unknown;
  region?: unknown;
  plan?: unknown;
  label?: unknown;
  status?: unknown;
  power_status?: unknown;
  server_status?: unknown;
  main_ip?: unknown;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VultrError(
      "invalid_provider_response",
      "unknown",
    );
  }
  return value;
}

function instance(value: VultrInstanceJson): VultrInstance {
  const address = typeof value.main_ip === "string" &&
      value.main_ip !== "0.0.0.0" && value.main_ip.length > 0
    ? value.main_ip
    : undefined;
  return {
    id: string(value.id),
    region: string(value.region),
    plan: string(value.plan),
    label: string(value.label),
    status: string(value.status),
    powerStatus: string(value.power_status),
    serverStatus: string(value.server_status),
    address,
  };
}

export class VultrV2Adapter implements VultrAdapter {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly allowedPlans: Set<string>;
  private readonly imageId: number;

  constructor(private readonly options: VultrClientOptions) {
    if (!options.token.trim()) throw new Error("VULTR_API_TOKEN is not set");
    if (!options.taipeiRegionId.trim()) {
      throw new Error("VULTR_TAIPEI_REGION_ID is not set");
    }
    this.imageId = Number(options.imageId);
    if (!Number.isSafeInteger(this.imageId) || this.imageId <= 0) {
      throw new Error("VULTR_IMAGE_ID is invalid");
    }
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = (options.baseUrl ?? "https://api.vultr.com/v2").replace(
      /\/$/,
      "",
    );
    this.allowedPlans = new Set(options.allowedPlans);
  }

  async validateCapacity(plan: string): Promise<void> {
    if (!this.allowedPlans.has(plan)) {
      throw new VultrError("capacity_unavailable", "definitive");
    }
    const [regions, plans] = await Promise.all([
      this.json("/regions?per_page=500"),
      this.json("/plans?per_page=500"),
    ]);
    const regionList = Array.isArray(regions.regions) ? regions.regions : [];
    const regionExists = regionList.some((region) =>
      region && typeof region === "object" &&
      (region as { id?: unknown }).id === this.options.taipeiRegionId
    );
    const planList = Array.isArray(plans.plans) ? plans.plans : [];
    const planAvailable = planList.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as {
        id?: unknown;
        locations?: unknown;
        type?: unknown;
      };
      return value.id === plan &&
        Array.isArray(value.locations) &&
        value.locations.includes(this.options.taipeiRegionId) &&
        value.type !== "vhf";
    });
    if (!regionExists || !planAvailable) {
      throw new VultrError("capacity_unavailable", "definitive");
    }
  }

  async createInstance(input: CreateVultrInstance): Promise<VultrInstance> {
    await this.validateCapacity(input.plan);
    try {
      const body = await this.json("/instances", {
        method: "POST",
        body: JSON.stringify({
          region: this.options.taipeiRegionId,
          plan: input.plan,
          os_id: this.imageId,
          label: input.serverId,
          tags: [`xmcl-server:${input.serverId}`],
          user_data: input.userData,
        }),
      });
      if (!body.instance || typeof body.instance !== "object") {
        throw new VultrError("invalid_provider_response", "unknown");
      }
      return instance(body.instance as VultrInstanceJson);
    } catch (error) {
      if (error instanceof VultrError && error.outcome === "definitive") {
        throw error;
      }
      const reconciled = await this.reconcileCreate(input.serverId).catch(
        () => undefined,
      );
      if (reconciled) return reconciled;
      throw new VultrError("provider_unknown", "unknown");
    }
  }

  async reconcileCreate(serverId: string): Promise<VultrInstance | undefined> {
    const body = await this.json(
      `/instances?label=${encodeURIComponent(serverId)}&per_page=500`,
    );
    const instances = Array.isArray(body.instances) ? body.instances : [];
    const matches = instances.filter((candidate) =>
      candidate && typeof candidate === "object" &&
      (candidate as { label?: unknown }).label === serverId
    );
    if (matches.length > 1) {
      throw new VultrError("invalid_provider_response", "unknown");
    }
    return matches[0] ? instance(matches[0] as VultrInstanceJson) : undefined;
  }

  async getInstance(instanceId: string): Promise<VultrInstance | undefined> {
    try {
      const body = await this.json(
        `/instances/${encodeURIComponent(instanceId)}`,
      );
      if (!body.instance || typeof body.instance !== "object") {
        throw new VultrError("invalid_provider_response", "unknown");
      }
      return instance(body.instance as VultrInstanceJson);
    } catch (error) {
      if (error instanceof VultrError && error.status === 404) return undefined;
      throw error;
    }
  }

  start(instanceId: string): Promise<void> {
    return this.empty(`/instances/${encodeURIComponent(instanceId)}/start`, {
      method: "POST",
    });
  }

  halt(instanceId: string): Promise<void> {
    return this.empty(`/instances/${encodeURIComponent(instanceId)}/halt`, {
      method: "POST",
    });
  }

  reboot(instanceId: string): Promise<void> {
    return this.empty(`/instances/${encodeURIComponent(instanceId)}/reboot`, {
      method: "POST",
    });
  }

  async delete(instanceId: string): Promise<void> {
    try {
      await this.empty(`/instances/${encodeURIComponent(instanceId)}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof VultrError && error.status === 404) return;
      throw error;
    }
  }

  private async empty(path: string, init: RequestInit): Promise<void> {
    await this.request(path, init);
  }

  private async json(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request(path, init);
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("invalid");
      }
      return body as Record<string, unknown>;
    } catch {
      throw new VultrError("invalid_provider_response", "unknown");
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Authorization": `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (response.ok) return response;
      const unknown = response.status === 408 || response.status === 429 ||
        response.status >= 500;
      throw new VultrError(
        unknown ? "provider_unavailable" : "provider_rejected",
        unknown ? "unknown" : "definitive",
        response.status,
      );
    } catch (error) {
      if (error instanceof VultrError) throw error;
      throw new VultrError("provider_unavailable", "unknown");
    } finally {
      clearTimeout(timer);
    }
  }
}
