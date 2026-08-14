import {
  InfrastructureError,
  type InfrastructureErrorCode,
} from "./sharedNodeInfrastructure.ts";

export const LIGHTNODE_MVP_REGIONS = {
  mow: {
    regionCode: "ru-moscow-1",
    zoneCode: "ru-moscow-1-a",
  },
  tpe: {
    regionCode: "cn-taiwan-2",
    zoneCode: "cn-taiwan-2-a",
  },
} as const;

export type LightNodeMvpRegion = keyof typeof LIGHTNODE_MVP_REGIONS;

export interface LightNodeRegion {
  regionCode: string;
  regionName: string;
  zones: readonly {
    zoneCode: string;
    zoneName: string;
  }[];
}

export interface LightNodePackage {
  packageCode: string;
  regionCode: string;
  zoneCode: string;
  cpu: number;
  memoryGiB: number;
  systemDiskGiB: number;
  dataDiskGiB: number;
  bandwidthMbps?: number;
  freeFlowGiB?: number;
  publicIpChargeMode: string;
}

export interface LightNodeImage {
  imageResourceUUID: string;
  imageName: string;
  imageType: string;
  osVersion: string;
  osVersionDetail: string;
}

export interface LightNodeFirewall {
  firewallUUID: string;
  firewallName: string;
  firewallStatus: string;
  regionCode: string;
}

export interface LightNodeInstance {
  id: string;
  name: string;
  regionCode: string;
  zoneCode: string;
  cpu: number;
  memoryGiB: number;
  systemDiskGiB: number;
  dataDiskGiB: number;
  status: string;
  pendingStatus: string;
  address?: string;
  imageResourceUUID?: string;
}

export interface CreateLightNodeInstance {
  packageCode: string;
  regionCode: string;
  zoneCode: string;
  instanceName: string;
  imageResourceUUID: string;
  firewallUUID: string;
  sshKeyUUID?: string;
  password?: string;
}

export class LightNodeError extends InfrastructureError {
  constructor(
    code: InfrastructureErrorCode,
    outcome: "definitive" | "unknown",
    status?: number,
    diagnostic?: "timeout" | "network",
  ) {
    super(code, outcome, "lightnode", status, diagnostic);
  }
}

interface LightNodeClientOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  taskTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function nonEmptyString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  return value;
}

function positiveInteger(value: unknown) {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
  ) {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  return value;
}

function nonNegativeInteger(value: unknown) {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  return value;
}

function optionalPositiveInteger(value: unknown) {
  return value === undefined || value === null
    ? undefined
    : positiveInteger(value);
}

function resourceId(value: string, prefix: string) {
  return value.startsWith(prefix) &&
    /^[A-Za-z0-9-]+$/.test(value);
}

function instance(value: unknown): LightNodeInstance {
  if (!value || typeof value !== "object") {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  const input = value as Record<string, unknown>;
  const id = nonEmptyString(input.ecsResourceUUID);
  if (!resourceId(id, "ecs-")) {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  const address = input.publicIpAddress === undefined ||
      input.publicIpAddress === null ||
      input.publicIpAddress === ""
    ? undefined
    : nonEmptyString(input.publicIpAddress);
  const imageResourceUUID = input.imageResourceUUID === undefined ||
      input.imageResourceUUID === null
    ? undefined
    : nonEmptyString(input.imageResourceUUID);
  return {
    id,
    name: nonEmptyString(input.instanceName),
    regionCode: nonEmptyString(input.regionCode),
    zoneCode: nonEmptyString(input.zoneCode),
    cpu: positiveInteger(input.cpu),
    memoryGiB: positiveInteger(input.memory),
    systemDiskGiB: positiveInteger(input.systemDiskSize),
    dataDiskGiB: nonNegativeInteger(input.dataDiskSize ?? 0),
    status: nonEmptyString(input.ecsStatus),
    pendingStatus: nonEmptyString(input.ecsPendingStatus),
    address,
    imageResourceUUID,
  };
}

function validateCreateInput(input: CreateLightNodeInstance) {
  if (
    !resourceId(input.imageResourceUUID, "img-") ||
    !resourceId(input.firewallUUID, "fw-") ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(input.instanceName) ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.regionCode) ||
    !/^[a-z0-9][a-z0-9-]{1,65}$/.test(input.zoneCode) ||
    !input.packageCode ||
    Boolean(input.sshKeyUUID) === Boolean(input.password)
  ) {
    throw new Error("LightNode instance configuration is invalid");
  }
  if (
    input.sshKeyUUID && !resourceId(input.sshKeyUUID, "key-")
  ) {
    throw new Error("LightNode SSH key is invalid");
  }
  if (
    input.password &&
    (
      input.password.length < 8 ||
      input.password.length > 30 ||
      !/[A-Za-z]/.test(input.password) ||
      !/[0-9]/.test(input.password) ||
      !/[()~!@#$*+\-={}\[\]:;,.?/]/.test(input.password)
    )
  ) {
    throw new Error("LightNode password is invalid");
  }
}

export class LightNodeOpenApiClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly taskTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LightNodeClientOptions) {
    if (!options.token.trim()) {
      throw new Error("LIGHTNODE_API_TOKEN is not set");
    }
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://openapi.lightnode.com")
      .replace(/\/$/, "");
    if (!/^https:\/\//.test(this.baseUrl)) {
      throw new Error("LIGHTNODE_API_BASE_URL must use HTTPS");
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.sleep = options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listRegions(): Promise<readonly LightNodeRegion[]> {
    const body = await this.json("/region/list");
    if (!Array.isArray(body.regions)) {
      throw new LightNodeError("invalid_provider_response", "unknown");
    }
    return body.regions.map((value) => {
      if (!value || typeof value !== "object") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      const region = value as Record<string, unknown>;
      if (!Array.isArray(region.zones)) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      return {
        regionCode: nonEmptyString(region.regionCode),
        regionName: nonEmptyString(region.regionName),
        zones: region.zones.map((zone) => {
          if (!zone || typeof zone !== "object") {
            throw new LightNodeError("invalid_provider_response", "unknown");
          }
          const candidate = zone as Record<string, unknown>;
          return {
            zoneCode: nonEmptyString(candidate.zoneCode),
            zoneName: nonEmptyString(candidate.zoneName),
          };
        }),
      };
    });
  }

  async validateMvpRegion(region: LightNodeMvpRegion) {
    const expected = LIGHTNODE_MVP_REGIONS[region];
    const actual = (await this.listRegions()).find((candidate) =>
      candidate.regionCode === expected.regionCode
    );
    if (
      !actual ||
      !actual.zones.some((zone) => zone.zoneCode === expected.zoneCode)
    ) {
      throw new LightNodeError("capacity_unavailable", "definitive");
    }
    return expected;
  }

  async listPackages(regionCode: string, zoneCode: string) {
    const body = await this.json("/package/list", {
      regionCode,
      zoneCode,
    });
    if (!Array.isArray(body.packages)) {
      throw new LightNodeError("invalid_provider_response", "unknown");
    }
    return body.packages.map((value): LightNodePackage => {
      if (!value || typeof value !== "object") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      const item = value as Record<string, unknown>;
      return {
        packageCode: nonEmptyString(item.packageCode),
        regionCode: nonEmptyString(item.regionCode),
        zoneCode: nonEmptyString(item.zoneCode),
        cpu: positiveInteger(item.cpu),
        memoryGiB: positiveInteger(item.memory),
        systemDiskGiB: positiveInteger(item.systemDiskSize),
        dataDiskGiB: nonNegativeInteger(item.dataDiskSize ?? 0),
        bandwidthMbps: optionalPositiveInteger(item.bandwidth),
        freeFlowGiB: optionalPositiveInteger(item.freeFlow),
        publicIpChargeMode: nonEmptyString(item.publicIpChargeMode),
      };
    });
  }

  async listImages(regionCode: string): Promise<readonly LightNodeImage[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const body = await this.json("/image/list", {
        page,
        pageSize: 50,
        regionCode,
      });
      if (!Array.isArray(body.images)) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      values.push(...body.images);
      const rowCount = nonNegativeInteger(body.rowCount);
      if (values.length >= rowCount || body.images.length === 0) break;
      if (page === 100) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
    }
    return values.map((value) => {
      if (!value || typeof value !== "object") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      const item = value as Record<string, unknown>;
      return {
        imageResourceUUID: nonEmptyString(item.imageResourceUUID),
        imageName: nonEmptyString(item.imageName),
        imageType: nonEmptyString(item.imageType),
        osVersion: nonEmptyString(item.osVersion),
        osVersionDetail: nonEmptyString(item.osVersionDetail),
      };
    });
  }

  async listFirewalls(
    regionCode: string,
  ): Promise<readonly LightNodeFirewall[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const body = await this.json("/firewall/list", {
        page,
        pageSize: 50,
        regionCode,
      });
      if (!Array.isArray(body.firewalls)) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      values.push(...body.firewalls);
      const rowCount = nonNegativeInteger(body.rowCount);
      if (values.length >= rowCount || body.firewalls.length === 0) break;
      if (page === 100) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
    }
    return values.map((value) => {
      if (!value || typeof value !== "object") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      const item = value as Record<string, unknown>;
      return {
        firewallUUID: nonEmptyString(item.firewallUUID),
        firewallName: nonEmptyString(item.firewallName),
        firewallStatus: nonEmptyString(item.firewallStatus),
        regionCode: nonEmptyString(item.regionCode),
      };
    });
  }

  async validateInstanceConfig(input: CreateLightNodeInstance) {
    validateCreateInput(input);
    const [packages, images, firewalls] = await Promise.all([
      this.listPackages(input.regionCode, input.zoneCode),
      this.listImages(input.regionCode),
      this.listFirewalls(input.regionCode),
    ]);
    const selectedPackage = packages.find((candidate) =>
      candidate.packageCode === input.packageCode &&
      candidate.regionCode === input.regionCode &&
      candidate.zoneCode === input.zoneCode
    );
    if (
      !selectedPackage ||
      !images.some((candidate) =>
        candidate.imageResourceUUID === input.imageResourceUUID
      ) ||
      !firewalls.some((candidate) =>
        candidate.firewallUUID === input.firewallUUID &&
        candidate.regionCode === input.regionCode &&
        candidate.firewallStatus === "AVAILABLE"
      )
    ) {
      throw new LightNodeError("capacity_unavailable", "definitive");
    }
    return selectedPackage;
  }

  async listInstances(regionCode: string, zoneCode: string) {
    const instances: LightNodeInstance[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const body = await this.json("/instance/list", {
        regionCode,
        zoneCode,
        page,
        pageSize: 50,
      });
      if (!Array.isArray(body.instances)) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      instances.push(...body.instances.map(instance));
      const rowCount = nonNegativeInteger(body.rowCount);
      if (instances.length >= rowCount || body.instances.length === 0) break;
      if (page === 100) {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
    }
    return instances;
  }

  async reconcileInstance(input: CreateLightNodeInstance) {
    const expectedPackage = await this.validateInstanceConfig(input);
    const matches = (await this.listInstances(
      input.regionCode,
      input.zoneCode,
    )).filter((candidate) => candidate.name === input.instanceName);
    if (matches.length > 1) {
      throw new LightNodeError("provider_unknown", "unknown");
    }
    const match = matches[0];
    if (!match) return undefined;
    if (
      match.cpu !== expectedPackage.cpu ||
      match.memoryGiB !== expectedPackage.memoryGiB ||
      match.systemDiskGiB !== expectedPackage.systemDiskGiB ||
      match.dataDiskGiB !== expectedPackage.dataDiskGiB ||
      match.imageResourceUUID !== undefined &&
        match.imageResourceUUID !== input.imageResourceUUID
    ) {
      throw new LightNodeError("provider_rejected", "definitive");
    }
    return match;
  }

  async createInstance(input: CreateLightNodeInstance) {
    const existing = await this.reconcileInstance(input);
    if (existing) return existing;
    let accepted: { asyncTaskUUID: string; instanceId: string };
    try {
      const body = await this.json("/instance/create", undefined, {
        method: "POST",
        body: JSON.stringify({
          packageConfig: {
            packageCode: input.packageCode,
            regionCode: input.regionCode,
            zoneCode: input.zoneCode,
            instanceName: input.instanceName,
            imageResourceUUID: input.imageResourceUUID,
            sshKeyUUID: input.sshKeyUUID ?? null,
            firewallUUID: input.firewallUUID,
            ...(input.password ? { password: input.password } : {}),
          },
        }),
      });
      accepted = asyncTask(body);
    } catch (error) {
      if (error instanceof LightNodeError && error.outcome === "definitive") {
        throw error;
      }
      const reconciled = await this.reconcileInstance(input);
      if (reconciled) return reconciled;
      throw error;
    }
    await this.waitForTask(accepted.asyncTaskUUID);
    const created = await this.getInstance(accepted.instanceId);
    if (!created) {
      throw new LightNodeError("provider_unknown", "unknown");
    }
    return created;
  }

  async getInstance(instanceId: string) {
    if (!resourceId(instanceId, "ecs-")) {
      throw new Error("LightNode instance id is invalid");
    }
    const body = await this.json(
      "/instance/detail",
      { ecsResourceUUID: instanceId },
      undefined,
      true,
    );
    return body === undefined ? undefined : instance(body.instance);
  }

  async deleteInstance(instanceId: string) {
    if (!resourceId(instanceId, "ecs-")) {
      throw new Error("LightNode instance id is invalid");
    }
    const existing = await this.getInstance(instanceId);
    if (!existing) return;
    const body = await this.json("/instance/release", undefined, {
      method: "POST",
      body: JSON.stringify({ ecsResourceUUID: instanceId }),
    });
    await this.waitForTask(asyncTask(body).asyncTaskUUID);
  }

  private async waitForTask(asyncTaskUUID: string) {
    const deadline = Date.now() + this.taskTimeoutMs;
    while (Date.now() < deadline) {
      const body = await this.json("/asynctask/getResult", { asyncTaskUUID });
      const info = body.asyncTaskInfo;
      if (!info || typeof info !== "object") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      const task = info as Record<string, unknown>;
      const status = nonEmptyString(task.taskStatus);
      const result = nonEmptyString(task.processResult);
      if (status === "FINISHED" && result === "SUCCESS") return;
      if (status === "FINISHED") {
        throw new LightNodeError("provider_rejected", "definitive");
      }
      if (status !== "PROCESSING") {
        throw new LightNodeError("invalid_provider_response", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new LightNodeError(
      "provider_unknown",
      "unknown",
      undefined,
      "timeout",
    );
  }

  private json(
    path: string,
    query?: Record<string, string | number>,
    init?: RequestInit,
    allowNotFound?: false,
  ): Promise<Record<string, unknown>>;
  private json(
    path: string,
    query: Record<string, string | number> | undefined,
    init: RequestInit | undefined,
    allowNotFound: true,
  ): Promise<Record<string, unknown> | undefined>;
  private async json(
    path: string,
    query?: Record<string, string | number>,
    init?: RequestInit,
    allowNotFound = false,
  ): Promise<Record<string, unknown> | undefined> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-open-token": this.options.token,
          ...init?.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new LightNodeError(
        "provider_unknown",
        "unknown",
        undefined,
        error instanceof DOMException && error.name === "AbortError"
          ? "timeout"
          : "network",
      );
    } finally {
      clearTimeout(timer);
    }
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new LightNodeError(
        response.status === 400 ? "provider_rejected" : "provider_unavailable",
        response.status === 400 ? "definitive" : "unknown",
        response.status,
      );
    }
    try {
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid response");
      }
      return value as Record<string, unknown>;
    } catch {
      throw new LightNodeError("invalid_provider_response", "unknown");
    }
  }
}

function asyncTask(body: Record<string, unknown> | undefined) {
  const info = body?.asyncTaskInfo;
  if (!info || typeof info !== "object") {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  const value = info as Record<string, unknown>;
  const asyncTaskUUID = nonEmptyString(value.asyncTaskUUID);
  const instanceId = nonEmptyString(value.ecsResourceUUID);
  if (
    !/^[A-Za-z0-9-]+$/.test(asyncTaskUUID) ||
    !resourceId(instanceId, "ecs-")
  ) {
    throw new LightNodeError("invalid_provider_response", "unknown");
  }
  return { asyncTaskUUID, instanceId };
}
