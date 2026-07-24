export interface VultrInstance {
  id: string;
  region: string;
  plan: string;
  label: string;
  status: string;
  powerStatus: string;
  serverStatus: string;
  address?: string;
  firewallGroupId?: string;
}

export interface CreateVultrInstance {
  serverId: string;
  plan: string;
  userData: string;
  snapshotId?: string;
  label?: string;
  tags?: readonly string[];
  firewallGroupId?: string;
}

/**
 * Kept separate from `VultrAdapter` so dedicated-server adapters and their
 * fakes do not acquire shared-node Block Storage responsibilities.
 */
export interface SharedNodeVolumeProvider {
  createVolume(input: CreateVultrVolume): Promise<VultrVolume>;
  getVolume(volumeId: string): Promise<VultrVolume | undefined>;
  reconcileVolume(label: string): Promise<VultrVolume | undefined>;
  attachVolume(volumeId: string, instanceId: string): Promise<void>;
  detachVolume(volumeId: string): Promise<void>;
  deleteVolume(volumeId: string): Promise<void>;
}

export interface CreateVultrVolume {
  region: string;
  sizeGiB: number;
  label: string;
  blockType: string;
}

export interface VultrVolume {
  id: string;
  region: string;
  sizeGiB: number;
  label: string;
  blockType: string;
  status: string;
  attachedToInstance?: string;
}

export interface VultrAdapter {
  validateCapacity(plan: string): Promise<void>;
  createInstance(input: CreateVultrInstance): Promise<VultrInstance>;
  createSnapshot(
    instanceId: string,
    description: string,
  ): Promise<{ snapshotId: string }>;
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
  regionId: string;
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
  firewall_group_id?: unknown;
}

interface VultrVolumeJson {
  id?: unknown;
  region?: unknown;
  size_gb?: unknown;
  label?: unknown;
  block_type?: unknown;
  status?: unknown;
  attached_to_instance?: unknown;
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
  let firewallGroupId: string | undefined;
  if (value.firewall_group_id === null || value.firewall_group_id === undefined) {
    firewallGroupId = undefined;
  } else if (
    typeof value.firewall_group_id === "string" &&
    value.firewall_group_id.length > 0
  ) {
    firewallGroupId = value.firewall_group_id;
  } else {
    throw new VultrError("invalid_provider_response", "unknown");
  }
  return {
    id: string(value.id),
    region: string(value.region),
    plan: string(value.plan),
    label: string(value.label),
    status: string(value.status),
    powerStatus: string(value.power_status),
    serverStatus: string(value.server_status),
    address,
    firewallGroupId,
  };
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
  ) {
    throw new VultrError("invalid_provider_response", "unknown");
  }
  return value;
}

function volume(value: VultrVolumeJson): VultrVolume {
  let attachedToInstance: string | undefined;
  if (value.attached_to_instance === null) {
    attachedToInstance = undefined;
  } else if (typeof value.attached_to_instance === "string" &&
    value.attached_to_instance.length > 0) {
    attachedToInstance = value.attached_to_instance;
  } else {
    throw new VultrError("invalid_provider_response", "unknown");
  }
  return {
    id: string(value.id),
    region: string(value.region),
    sizeGiB: positiveInteger(value.size_gb),
    label: string(value.label),
    blockType: string(value.block_type),
    status: string(value.status),
    attachedToInstance,
  };
}

export class VultrV2Adapter
  implements VultrAdapter, SharedNodeVolumeProvider {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly allowedPlans: Set<string>;
  private readonly imageId: number;

  constructor(private readonly options: VultrClientOptions) {
    if (!options.token.trim()) throw new Error("VULTR_API_TOKEN is not set");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(options.regionId)) {
      throw new Error("VULTR_SHARED_NODE_REGION_ID is invalid");
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
      (region as { id?: unknown }).id === this.options.regionId
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
        value.locations.includes(this.options.regionId) &&
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
          region: this.options.regionId,
          plan: input.plan,
          ...(input.snapshotId
            ? { snapshot_id: input.snapshotId }
            : { os_id: this.imageId }),
          label: input.label ?? input.serverId,
          tags: input.tags ?? [`xmcl-server:${input.serverId}`],
          user_data: input.userData,
          ...(input.firewallGroupId === undefined
            ? {}
            : {
              firewall_group_id: input.firewallGroupId,
              enable_ipv6: false,
            }),
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

  async createSnapshot(
    instanceId: string,
    description: string,
  ): Promise<{ snapshotId: string }> {
    const body = await this.json("/snapshots", {
      method: "POST",
      body: JSON.stringify({
        instance_id: instanceId,
        description,
      }),
    });
    const snapshot = body.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new VultrError("invalid_provider_response", "unknown");
    }
    return { snapshotId: string((snapshot as { id?: unknown }).id) };
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

  async createVolume(input: CreateVultrVolume): Promise<VultrVolume> {
    if (
      input.region !== this.options.regionId ||
      !input.label ||
      !input.blockType ||
      !Number.isSafeInteger(input.sizeGiB) ||
      input.sizeGiB <= 0
    ) {
      throw new VultrError("provider_rejected", "definitive");
    }
    const body = await this.json("/block-storage", {
      method: "POST",
      body: JSON.stringify({
        region: this.options.regionId,
        size_gb: input.sizeGiB,
        label: input.label,
        block_type: input.blockType,
      }),
    });
    if (!body.block_storage || typeof body.block_storage !== "object") {
      throw new VultrError("invalid_provider_response", "unknown");
    }
    return volume(body.block_storage as VultrVolumeJson);
  }

  async getVolume(volumeId: string): Promise<VultrVolume | undefined> {
    try {
      const body = await this.json(
        `/block-storage/${encodeURIComponent(volumeId)}`,
      );
      if (!body.block_storage || typeof body.block_storage !== "object") {
        throw new VultrError("invalid_provider_response", "unknown");
      }
      return volume(body.block_storage as VultrVolumeJson);
    } catch (error) {
      if (error instanceof VultrError && error.status === 404) return undefined;
      throw error;
    }
  }

  async reconcileVolume(label: string): Promise<VultrVolume | undefined> {
    const body = await this.json(
      `/block-storage?label=${encodeURIComponent(label)}&per_page=500`,
    );
    if (!Array.isArray(body.block_storages)) {
      throw new VultrError("invalid_provider_response", "unknown");
    }
    const volumes = body.block_storages;
    const matches = volumes.filter((candidate) =>
      candidate && typeof candidate === "object" &&
      (candidate as { label?: unknown }).label === label
    );
    if (matches.length > 1) {
      throw new VultrError("invalid_provider_response", "unknown");
    }
    return matches[0] ? volume(matches[0] as VultrVolumeJson) : undefined;
  }

  attachVolume(volumeId: string, instanceId: string): Promise<void> {
    return this.empty(
      `/block-storage/${encodeURIComponent(volumeId)}/attach`,
      {
        method: "POST",
        // The VM has already booted cloud-init and is waiting for this volume.
        body: JSON.stringify({ instance_id: instanceId, live: true }),
      },
    );
  }

  detachVolume(volumeId: string): Promise<void> {
    return this.empty(
      `/block-storage/${encodeURIComponent(volumeId)}/detach`,
      {
        method: "POST",
        body: JSON.stringify({ live: false }),
      },
    );
  }

  async deleteVolume(volumeId: string): Promise<void> {
    try {
      await this.empty(`/block-storage/${encodeURIComponent(volumeId)}`, {
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
