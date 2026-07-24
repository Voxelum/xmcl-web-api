import type { Db } from "../db.ts";
import {
  isSharedNodeRegion,
  type SharedHostingScheduler,
  type SharedNodeProvisioner as SharedNodeProvisionerContract,
} from "./sharedHostingScheduler.ts";
import type {
  SharedNodeVolumeProvider,
  VultrAdapter,
  VultrInstance,
  VultrVolume,
} from "./vultr.ts";
import { VultrError as ProviderError } from "./vultr.ts";
import {
  hashSharedNodeToken,
  type SharedNodeEnrollmentRepository,
  type SharedNodeExpectedCapacity,
} from "./sharedNodeTransport.ts";

export interface SharedNodeVmProfile {
  profileId: string;
  providerPlan: string;
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
}

export const DEFAULT_SHARED_NODE_PROFILE: SharedNodeVmProfile = {
  profileId: "shared-standard",
  providerPlan: "vc2-4c-16gb",
  totalMemoryMiB: 12 * 1024,
  totalSharedCpu: 8,
  totalWorkspaceGiB: 128,
};

export const SHARED_NODE_BLOCK_STORAGE_TYPES = [
  "high_perf",
  "storage_opt",
] as const;

export type SharedNodeVolumeStatus =
  | "creating"
  | "attaching"
  | "attached"
  | "detaching"
  | "deleted"
  | "unknown";

type SharedNodeInstanceStatus =
  | "not_created"
  | "creating"
  | "created"
  | "deleting"
  | "deleted"
  | "unknown";

export interface SharedNodeProvisioningRecord {
  requestId: string;
  nodeId: string;
  label: string;
  profileId: string;
  firewallGroupId: string;
  instanceId?: string;
  instanceStatus: SharedNodeInstanceStatus;
  instanceCreationAttempted: boolean;
  volumeId?: string;
  volumeLabel: string;
  volumeRegion: string;
  volumeSizeGiB: number;
  volumeBlockType: string;
  volumeStatus: SharedNodeVolumeStatus;
  volumeCreationAttempted: boolean;
  status:
    | "creating"
    | "ready"
    | "draining"
    | "failed"
    | "deleted"
    | "unknown";
  failureOutcome?: "definitive" | "unknown";
  updatedAt: string;
}

export interface SharedNodeProvisioningRepository {
  find(requestId: string): Promise<SharedNodeProvisioningRecord | undefined>;
  findByNodeId(
    nodeId: string,
  ): Promise<SharedNodeProvisioningRecord | undefined>;
  save(record: SharedNodeProvisioningRecord): Promise<void>;
}

export class MemorySharedNodeProvisioningRepository
  implements SharedNodeProvisioningRepository {
  private readonly records = new Map<string, SharedNodeProvisioningRecord>();

  find(requestId: string) {
    const record = this.records.get(requestId);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  findByNodeId(nodeId: string) {
    const record = [...this.records.values()].find((candidate) =>
      candidate.nodeId === nodeId
    );
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  requestIds() {
    return Promise.resolve([...this.records.keys()]);
  }

  save(record: SharedNodeProvisioningRecord) {
    this.records.set(record.requestId, structuredClone(record));
    return Promise.resolve();
  }
}

export class MongoSharedNodeProvisioningRepository
  implements SharedNodeProvisioningRepository {
  constructor(private readonly db: Db) {}

  async find(requestId: string) {
    return await this.db.collection("shared_node_provisioning").findOne({
      _id: requestId,
    }) as SharedNodeProvisioningRecord | undefined;
  }

  async findByNodeId(nodeId: string) {
    return await this.db.collection("shared_node_provisioning").findOne({
      nodeId,
    }) as SharedNodeProvisioningRecord | undefined;
  }

  async save(record: SharedNodeProvisioningRecord) {
    await this.db.collection("shared_node_provisioning").replaceOne(
      { _id: record.requestId },
      { ...structuredClone(record), _id: record.requestId },
      { upsert: true },
    );
  }
}

export interface SharedNodeProvisioningConfig {
  providerPlan?: string;
  firewallGroupId: string;
  releaseUrl: string;
  releaseSha256: string;
  quotaHelperReleaseUrl: string;
  quotaHelperReleaseSha256: string;
  controlPlaneUrl: string;
  region: string;
  blockStorageSizeGiB: number;
  blockStorageType: string;
  objectStorageEndpoint?: string;
  objectStorageRegion?: string;
  objectStorageBucket?: string;
  containerImage?: string;
  workspaceRoot?: string;
  rconStopTimeoutSeconds?: number;
  xfsProjectBase?: number;
}

export interface SharedNodeRegistrationWaiter {
  isRegistered(nodeId: string): Promise<boolean>;
  waitForRegistration?(nodeId: string): Promise<void>;
}

export interface SharedNodeProvisionerOptions {
  provider: VultrAdapter;
  volumeProvider: SharedNodeVolumeProvider;
  scheduler: SharedHostingScheduler;
  repository: SharedNodeProvisioningRepository;
  enrollmentRepository: SharedNodeEnrollmentRepository;
  registration: SharedNodeRegistrationWaiter;
  config: SharedNodeProvisioningConfig;
  profiles?: readonly SharedNodeVmProfile[];
  now?: () => Date;
  createId?: (prefix: string) => string;
  registrationTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  drainTimeoutMs?: number;
  enrollmentTtlMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class VultrSharedNodeProvisioner
  implements SharedNodeProvisionerContract {
  private readonly now: () => Date;
  private readonly profiles: readonly SharedNodeVmProfile[];
  private readonly registrationTimeoutMs: number;
  private readonly attachmentTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly enrollmentTtlMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: SharedNodeProvisionerOptions) {
    validateConfig(options.config);
    this.now = options.now ?? (() => new Date());
    this.profiles = options.profiles ?? [{
      ...DEFAULT_SHARED_NODE_PROFILE,
      ...(options.config.providerPlan
        ? { providerPlan: options.config.providerPlan }
        : {}),
    }];
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? 10 * 60_000;
    this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? 5 * 60_000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 30 * 60_000;
    this.enrollmentTtlMs = options.enrollmentTtlMs ?? 30 * 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.sleep = options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async requestCapacity(
    input: Parameters<SharedNodeProvisionerContract["requestCapacity"]>[0],
  ) {
    const existing = this.inFlight.get(input.requestId);
    if (existing) return await existing;
    const operation = this.provisionCapacity(input);
    this.inFlight.set(input.requestId, operation);
    try {
      await operation;
    } finally {
      this.inFlight.delete(input.requestId);
    }
  }

  private async provisionCapacity(
    input: Parameters<SharedNodeProvisionerContract["requestCapacity"]>[0],
  ) {
    const profile = this.selectProfile(input);
    this.validateVolumeCapacity(profile);
    let record = await this.options.repository.find(input.requestId);
    if (!record) {
      record = this.newRecord(input.requestId, profile);
      await this.save(record);
    } else {
      try {
        this.validateExistingRecord(record, profile);
      } catch (error) {
        await this.recordFailure(record, error);
        throw providerError(error);
      }
    }

    if (record.status === "deleted") return;
    if (record.status === "ready" && record.volumeStatus === "attached") return;
    if (record.status === "failed" && record.failureOutcome === "definitive") {
      throw new ProviderError("provider_rejected", "definitive");
    }

    try {
      const volume = await this.ensureVolume(record);
      const instance = await this.ensureInstance(record, profile);
      await this.ensureAttachment(record, volume, instance);
      await this.finishCreation(record, instance);
    } catch (error) {
      await this.recordFailure(record, error);
      throw providerError(error);
    }
  }

  async drainNode(nodeId: string) {
    const record = await this.options.repository.findByNodeId(nodeId);
    if (!record || record.status === "deleted") return;
    if (
      record.status !== "ready" && record.status !== "draining" ||
      !record.instanceId ||
      !record.volumeId ||
      record.volumeStatus !== "attached"
    ) {
      await this.markUnknown(record);
      throw new ProviderError("provider_unknown", "unknown");
    }

    await this.options.scheduler.drainNode(nodeId);
    record.status = "draining";
    record.failureOutcome = undefined;
    await this.save(record);

    try {
      await this.waitForNoActiveServices(nodeId);
      await this.deleteInstance(record);
      await this.detachAndDeleteVolume(record);
      await this.options.scheduler.removeNode(nodeId);
      record.status = "deleted";
      record.instanceStatus = "deleted";
      record.volumeStatus = "deleted";
      record.failureOutcome = undefined;
      await this.save(record);
    } catch (error) {
      await this.markUnknown(record);
      throw providerError(error);
    }
  }

  private selectProfile(
    input: Parameters<SharedNodeProvisionerContract["requestCapacity"]>[0],
  ) {
    const profile = this.profiles.find((candidate) =>
      candidate.totalMemoryMiB >= input.minimumMemoryMiB &&
      candidate.totalSharedCpu >= input.minimumSharedCpu &&
      candidate.totalWorkspaceGiB >= input.minimumWorkspaceGiB
    );
    if (!profile) {
      throw new ProviderError("capacity_unavailable", "definitive");
    }
    return profile;
  }

  private newRecord(
    requestId: string,
    profile: SharedNodeVmProfile,
  ): SharedNodeProvisioningRecord {
    const safeRequest = safeRequestId(requestId);
    return {
      requestId,
      nodeId: `shared-node-${safeRequest}`,
      label: `xmcl-shared-${safeRequest}`,
      profileId: profile.profileId,
      firewallGroupId: this.options.config.firewallGroupId,
      instanceStatus: "not_created",
      instanceCreationAttempted: false,
      volumeLabel: `xmcl-shared-volume-${safeRequest}`,
      volumeRegion: this.options.config.region,
      volumeSizeGiB: this.options.config.blockStorageSizeGiB,
      volumeBlockType: this.options.config.blockStorageType,
      volumeStatus: "creating",
      volumeCreationAttempted: false,
      status: "creating",
      updatedAt: this.now().toISOString(),
    };
  }

  private validateExistingRecord(
    record: SharedNodeProvisioningRecord,
    profile: SharedNodeVmProfile,
  ) {
    if (
      record.profileId !== profile.profileId ||
      !isSharedNodeFirewallGroupId(record.firewallGroupId) ||
      !record.volumeLabel ||
      !record.volumeRegion ||
      !Number.isSafeInteger(record.volumeSizeGiB) ||
      record.volumeSizeGiB <= 0 ||
      !isBlockStorageType(record.volumeBlockType) ||
      typeof record.instanceCreationAttempted !== "boolean" ||
      typeof record.volumeCreationAttempted !== "boolean" ||
      !record.instanceStatus ||
      !record.volumeStatus
    ) {
      throw new ProviderError("provider_unknown", "unknown");
    }
    if (
      record.firewallGroupId !== this.options.config.firewallGroupId ||
      record.volumeRegion !== this.options.config.region ||
      record.volumeSizeGiB !== this.options.config.blockStorageSizeGiB ||
      record.volumeBlockType !== this.options.config.blockStorageType
    ) {
      throw new ProviderError("provider_rejected", "definitive");
    }
  }

  private validateVolumeCapacity(profile: SharedNodeVmProfile) {
    if (
      this.options.config.blockStorageSizeGiB < profile.totalWorkspaceGiB
    ) {
      throw new ProviderError("capacity_unavailable", "definitive");
    }
  }

  private async ensureVolume(record: SharedNodeProvisioningRecord) {
    let volume: VultrVolume | undefined;
    if (record.volumeId) {
      volume = await this.options.volumeProvider.getVolume(record.volumeId);
      if (!volume) {
        await this.markUnknown(record);
        throw new ProviderError("provider_unknown", "unknown");
      }
    } else {
      volume = await this.options.volumeProvider.reconcileVolume(
        record.volumeLabel,
      );
      if (!volume) {
        if (record.volumeCreationAttempted) {
          await this.markUnknown(record);
          throw new ProviderError("provider_unknown", "unknown");
        }
        record.volumeCreationAttempted = true;
        record.volumeStatus = "creating";
        await this.save(record);
        try {
          volume = await this.options.volumeProvider.createVolume({
            region: record.volumeRegion,
            sizeGiB: record.volumeSizeGiB,
            label: record.volumeLabel,
            blockType: record.volumeBlockType,
          });
        } catch (error) {
          if (providerError(error).outcome === "unknown") {
            record.volumeStatus = "unknown";
          }
          await this.save(record);
          throw error;
        }
      }
    }

    this.validateVolume(record, volume);
    record.volumeId = volume.id;
    if (record.volumeStatus !== "attached") record.volumeStatus = "creating";
    record.status = "creating";
    record.failureOutcome = undefined;
    await this.save(record);
    return volume;
  }

  private async ensureInstance(
    record: SharedNodeProvisioningRecord,
    profile: SharedNodeVmProfile,
  ) {
    let instance: VultrInstance | undefined;
    if (record.instanceId) {
      instance = await this.options.provider.getInstance(record.instanceId);
      if (!instance) {
        await this.markUnknown(record);
        throw new ProviderError("provider_unknown", "unknown");
      }
    } else {
      instance = await this.options.provider.reconcileCreate(record.label);
      if (!instance) {
        if (record.instanceCreationAttempted) {
          await this.markUnknown(record);
          throw new ProviderError("provider_unknown", "unknown");
        }
        instance = await this.createInstance(record, profile);
      }
    }

    this.validateInstance(record, profile, instance);
    record.instanceId = instance.id;
    record.instanceStatus = "created";
    record.status = "creating";
    record.failureOutcome = undefined;
    await this.save(record);
    return instance;
  }

  private async createInstance(
    record: SharedNodeProvisioningRecord,
    profile: SharedNodeVmProfile,
  ) {
    const enrollmentToken = crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    const expectedCapacity: SharedNodeExpectedCapacity = {
      totalMemoryMiB: profile.totalMemoryMiB,
      totalSharedCpu: profile.totalSharedCpu,
      totalWorkspaceGiB: profile.totalWorkspaceGiB,
    };
    await this.options.enrollmentRepository.saveEnrollment({
      nodeId: record.nodeId,
      provisioningRequestId: record.requestId,
      instanceId: record.label,
      expectedCapacity,
      oneTimeTokenHash: await hashSharedNodeToken(enrollmentToken),
      expiresAt: new Date(
        this.now().getTime() + this.enrollmentTtlMs,
      ).toISOString(),
    });
    record.instanceCreationAttempted = true;
    record.instanceStatus = "creating";
    await this.save(record);
    try {
      return await this.options.provider.createInstance({
        serverId: record.label,
        label: record.label,
        plan: profile.providerPlan,
        tags: [
          "xmcl-environment:production",
          `xmcl-region:${this.options.config.region}`,
          "xmcl-node-pool:shared",
          `xmcl-capacity-request:${safeRequestId(record.requestId)}`,
        ],
        firewallGroupId: record.firewallGroupId,
        userData: renderSharedNodeCloudInit({
          nodeId: record.nodeId,
          ...this.options.config,
          volumeId: record.volumeId!,
          controlPlaneCredential: enrollmentToken,
          totalMemoryMiB: profile.totalMemoryMiB,
          totalSharedCpu: profile.totalSharedCpu,
          totalWorkspaceGiB: profile.totalWorkspaceGiB,
        }),
      });
    } catch (error) {
      record.instanceStatus = "unknown";
      await this.save(record);
      throw error;
    }
  }

  private async ensureAttachment(
    record: SharedNodeProvisioningRecord,
    expectedVolume: VultrVolume,
    instance: VultrInstance,
  ) {
    const volume = await this.options.volumeProvider.getVolume(expectedVolume.id);
    if (!volume) {
      await this.markUnknown(record);
      throw new ProviderError("provider_unknown", "unknown");
    }
    this.validateVolume(record, volume);
    if (volume.attachedToInstance === instance.id) {
      record.volumeStatus = "attached";
      await this.save(record);
      return;
    }
    if (volume.attachedToInstance) {
      record.volumeStatus = "unknown";
      await this.save(record);
      throw new ProviderError("provider_rejected", "definitive");
    }
    if (
      record.volumeStatus === "attaching" ||
      record.volumeStatus === "unknown"
    ) {
      await this.markUnknown(record);
      throw new ProviderError("provider_unknown", "unknown");
    }

    record.volumeStatus = "attaching";
    await this.save(record);
    try {
      await this.options.volumeProvider.attachVolume(volume.id, instance.id);
    } catch (error) {
      record.volumeStatus = "unknown";
      await this.save(record);
      throw error;
    }
    await this.waitForAttachment(record, instance.id);
  }

  private async waitForAttachment(
    record: SharedNodeProvisioningRecord,
    instanceId: string,
  ) {
    const deadline = Date.now() + this.attachmentTimeoutMs;
    while (true) {
      const volume = await this.options.volumeProvider.getVolume(record.volumeId!);
      if (!volume) {
        await this.markUnknown(record);
        throw new ProviderError("provider_unknown", "unknown");
      }
      this.validateVolume(record, volume);
      if (volume.attachedToInstance === instanceId) {
        record.volumeStatus = "attached";
        await this.save(record);
        return;
      }
      if (volume.attachedToInstance) {
        record.volumeStatus = "unknown";
        await this.save(record);
        throw new ProviderError("provider_rejected", "definitive");
      }
      if (Date.now() >= deadline) {
        await this.markUnknown(record);
        throw new ProviderError("provider_unavailable", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async finishCreation(
    record: SharedNodeProvisioningRecord,
    instance: VultrInstance,
  ) {
    if (record.volumeStatus !== "attached") {
      throw new ProviderError("provider_unknown", "unknown");
    }
    record.instanceId = instance.id;
    record.instanceStatus = "created";
    record.status = "creating";
    record.failureOutcome = undefined;
    await this.save(record);
    await this.waitForRegistration(record.nodeId);
    record.status = "ready";
    await this.save(record);
  }

  private async waitForRegistration(nodeId: string) {
    if (this.options.registration.waitForRegistration) {
      await this.options.registration.waitForRegistration(nodeId);
      return;
    }
    const deadline = Date.now() + this.registrationTimeoutMs;
    while (!(await this.options.registration.isRegistered(nodeId))) {
      if (Date.now() >= deadline) {
        throw new ProviderError("provider_unavailable", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async waitForNoActiveServices(nodeId: string) {
    const deadline = Date.now() + this.drainTimeoutMs;
    while ((await this.options.scheduler.activeServicesOnNode(nodeId)).length) {
      if (Date.now() >= deadline) {
        throw new ProviderError("provider_unavailable", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async deleteInstance(record: SharedNodeProvisioningRecord) {
    const instance = await this.options.provider.getInstance(record.instanceId!);
    if (!instance) {
      record.instanceStatus = "deleted";
      await this.save(record);
      return;
    }
    this.validateInstance(
      record,
      this.profiles.find((profile) => profile.profileId === record.profileId)!,
      instance,
    );
    record.instanceStatus = "deleting";
    await this.save(record);
    await this.options.provider.delete(instance.id);
    const deadline = Date.now() + this.drainTimeoutMs;
    while (true) {
      const current = await this.options.provider.getInstance(instance.id);
      if (!current) {
        record.instanceStatus = "deleted";
        await this.save(record);
        return;
      }
      this.validateInstance(
        record,
        this.profiles.find((profile) => profile.profileId === record.profileId)!,
        current,
      );
      if (Date.now() >= deadline) {
        throw new ProviderError("provider_unavailable", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async detachAndDeleteVolume(record: SharedNodeProvisioningRecord) {
    let volume = await this.options.volumeProvider.getVolume(record.volumeId!);
    if (!volume) {
      record.volumeStatus = "deleted";
      await this.save(record);
      return;
    }
    this.validateVolume(record, volume);
    if (volume.attachedToInstance) {
      if (volume.attachedToInstance !== record.instanceId) {
        throw new ProviderError("provider_unknown", "unknown");
      }
      record.volumeStatus = "detaching";
      await this.save(record);
      await this.options.volumeProvider.detachVolume(volume.id);
      const deadline = Date.now() + this.drainTimeoutMs;
      while (true) {
        volume = await this.options.volumeProvider.getVolume(record.volumeId!);
        if (!volume) {
          record.volumeStatus = "deleted";
          await this.save(record);
          return;
        }
        this.validateVolume(record, volume);
        if (!volume.attachedToInstance) break;
        if (volume.attachedToInstance !== record.instanceId) {
          throw new ProviderError("provider_unknown", "unknown");
        }
        if (Date.now() >= deadline) {
          throw new ProviderError("provider_unavailable", "unknown");
        }
        await this.sleep(this.pollIntervalMs);
      }
    }

    record.volumeStatus = "detaching";
    await this.save(record);
    await this.options.volumeProvider.deleteVolume(record.volumeId!);
    const deadline = Date.now() + this.drainTimeoutMs;
    while (true) {
      const current = await this.options.volumeProvider.getVolume(record.volumeId!);
      if (!current) {
        record.volumeStatus = "deleted";
        await this.save(record);
        return;
      }
      this.validateVolume(record, current);
      if (Date.now() >= deadline) {
        throw new ProviderError("provider_unavailable", "unknown");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private validateVolume(
    record: SharedNodeProvisioningRecord,
    volume: VultrVolume,
  ) {
    if (
      (record.volumeId && volume.id !== record.volumeId) ||
      volume.label !== record.volumeLabel ||
      volume.region !== record.volumeRegion ||
      volume.sizeGiB !== record.volumeSizeGiB ||
      volume.blockType !== record.volumeBlockType
    ) {
      throw new ProviderError("provider_rejected", "definitive");
    }
  }

  private validateInstance(
    record: SharedNodeProvisioningRecord,
    profile: SharedNodeVmProfile,
    instance: VultrInstance,
  ) {
    if (instance.firewallGroupId === undefined) {
      throw new ProviderError("invalid_provider_response", "unknown");
    }
    if (
      (record.instanceId && instance.id !== record.instanceId) ||
      instance.label !== record.label ||
      instance.plan !== profile.providerPlan ||
      instance.region !== record.volumeRegion ||
      instance.firewallGroupId !== record.firewallGroupId
    ) {
      throw new ProviderError("provider_rejected", "definitive");
    }
  }

  private async recordFailure(
    record: SharedNodeProvisioningRecord,
    error: unknown,
  ) {
    const provider = providerError(error);
    record.status = provider.outcome === "definitive" ? "failed" : "unknown";
    record.failureOutcome = provider.outcome;
    await this.save(record);
  }

  private async markUnknown(record: SharedNodeProvisioningRecord) {
    record.status = "unknown";
    record.failureOutcome = "unknown";
    await this.save(record);
  }

  private async save(record: SharedNodeProvisioningRecord) {
    record.updatedAt = this.now().toISOString();
    await this.options.repository.save(record);
  }
}

export function renderSharedNodeCloudInit(input: {
  nodeId: string;
  releaseUrl: string;
  releaseSha256: string;
  quotaHelperReleaseUrl: string;
  quotaHelperReleaseSha256: string;
  controlPlaneUrl: string;
  controlPlaneCredential: string;
  volumeId: string;
  region: string;
  objectStorageEndpoint?: string;
  objectStorageRegion?: string;
  objectStorageBucket?: string;
  containerImage?: string;
  workspaceRoot?: string;
  rconStopTimeoutSeconds?: number;
  xfsProjectBase?: number;
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
}) {
  validateCloudInitInput(input);
  const config = [
    `XMCL_SHARED_NODE_ID=${shellValue(input.nodeId)}`,
    `XMCL_CONTROL_PLANE_URL=${shellValue(input.controlPlaneUrl)}`,
    `XMCL_CONTROL_PLANE_CREDENTIAL=${shellValue(input.controlPlaneCredential)}`,
    `XMCL_SHARED_NODE_VOLUME_ID=${shellValue(input.volumeId)}`,
    `XMCL_SHARED_NODE_REGION=${shellValue(input.region)}`,
    `XMCL_VULTR_OBJECT_STORAGE_ENDPOINT=${
      shellValue(input.objectStorageEndpoint ?? "https://sgp1.vultrobjects.com")
    }`,
    `XMCL_VULTR_OBJECT_STORAGE_REGION=${
      shellValue(input.objectStorageRegion ?? "sgp")
    }`,
    `XMCL_VULTR_OBJECT_STORAGE_BUCKET=${
      shellValue(input.objectStorageBucket ?? "xmcl-shared-hosting")
    }`,
    `XMCL_WORKSPACE_ROOT=${
      shellValue(input.workspaceRoot ?? "/var/lib/xmcl-shared/workspaces")
    }`,
    "XMCL_STATE_ROOT='/var/lib/xmcl-shared/state'",
    `XMCL_CONTAINER_IMAGE=${
      shellValue(
        input.containerImage ?? "ghcr.io/voxelum/xmcl-minecraft:stable",
      )
    }`,
    `XMCL_RCON_STOP_TIMEOUT_SECONDS=${input.rconStopTimeoutSeconds ?? 60}`,
    "XMCL_QUOTA_MOUNT_PATH='/var/lib/xmcl-shared'",
    `XMCL_QUOTA_PROJECT_BASE=${input.xfsProjectBase ?? 100000}`,
    `XMCL_TOTAL_MEMORY_MIB=${input.totalMemoryMiB}`,
    `XMCL_TOTAL_SHARED_CPU=${input.totalSharedCpu}`,
    `XMCL_TOTAL_WORKSPACE_GIB=${input.totalWorkspaceGiB}`,
    "XMCL_METRICS_ADDR='127.0.0.1:9464'",
  ].join("\n") + "\n";
  const quotaConfig = JSON.stringify({
    workspaceRoot: input.workspaceRoot ?? "/var/lib/xmcl-shared/workspaces",
    mountPath: "/var/lib/xmcl-shared",
    projectBase: input.xfsProjectBase ?? 100000,
  }, undefined, 2);
  const volumeSetupService = `[Unit]
Description=XMCL shared node Block Storage setup
After=local-fs.target
Before=xmcl-shared-node-agent.service

[Service]
Type=oneshot
EnvironmentFile=/etc/xmcl/shared-node-agent.env
ExecStart=/usr/local/libexec/xmcl-shared-volume-setup
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
  const agentService = `[Unit]
Description=XMCL shared node agent
After=docker.service xmcl-shared-volume-setup.service
Requires=docker.service xmcl-shared-volume-setup.service

[Service]
Type=simple
User=xmcl-node-agent
Group=xmcl-node-agent
SupplementaryGroups=docker
EnvironmentFile=/etc/xmcl/shared-node-agent.env
ExecStart=/usr/local/bin/xmcl-shared-node-agent
Restart=always
RestartSec=5
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/xmcl-shared /run
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
NoNewPrivileges=false
CapabilityBoundingSet=CAP_SYS_ADMIN
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
`;
  const volumeSetupScript = `#!/usr/bin/env bash
set -euo pipefail

mount=/var/lib/xmcl-shared
volume_id="\${XMCL_SHARED_NODE_VOLUME_ID:-}"
[[ "$volume_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || {
  echo "unsafe or missing XMCL_SHARED_NODE_VOLUME_ID" >&2
  exit 1
}

deadline=$((SECONDS + 300))
shopt -s nullglob
expected_link="/dev/disk/by-id/scsi-0Vultr_Block_Storage_$volume_id"
matches=("$expected_link"*)
while (( \${#matches[@]} != 1 )); do
  if (( SECONDS >= deadline )); then
    echo "expected Block Storage device did not appear exactly once" >&2
    exit 1
  fi
  sleep 2
  matches=("$expected_link"*)
done
link="\${matches[0]}"
[[ "$link" == "$expected_link" ]] || {
  echo "Block Storage by-id entries are ambiguous" >&2
  exit 1
}
device=$(readlink -f "$link")
[[ -b "$device" && "$device" == /dev/* ]] || {
  echo "Block Storage symlink has an unsafe target" >&2
  exit 1
}

root_source=$(findmnt -n -o SOURCE --target /)
root_device=$(readlink -f "$root_source" 2>/dev/null || true)
[[ -b "$root_device" ]] || {
  echo "could not resolve the root filesystem device" >&2
  exit 1
}
root_devices=("$root_device")
parent="$root_device"
while [[ -n "$parent" ]]; do
  parent=$(lsblk -no PKNAME "$parent" 2>/dev/null | head -n 1 || true)
  [[ -n "$parent" ]] || break
  parent="/dev/$parent"
  root_devices+=("$parent")
done
for root_candidate in "\${root_devices[@]}"; do
  [[ "$device" != "$root_candidate" ]] || {
    echo "refusing to use the root filesystem device" >&2
    exit 1
  }
done

existing_target=$(findmnt -rn -S "$device" -o TARGET 2>/dev/null || true)
[[ -z "$existing_target" || "$existing_target" == "$mount" ]] || {
  echo "Block Storage device is mounted outside its expected mount path" >&2
  exit 1
}
install -d -o root -g root -m 0750 "$mount"
if mountpoint -q "$mount"; then
  mounted_source=$(findmnt -n -o SOURCE --target "$mount")
  [[ "$(readlink -f "$mounted_source")" == "$device" ]] || {
    echo "expected mount path is occupied by another device" >&2
    exit 1
  }
fi

filesystem=$(blkid -s TYPE -o value "$device" 2>/dev/null || true)
marker="$mount/.xmcl-shared-volume"
mounted_read_only=false
if [[ "$filesystem" == xfs ]]; then
  if ! mountpoint -q "$mount"; then
    mount -o ro "$device" "$mount"
    mounted_read_only=true
  fi
  [[ -f "$marker" && ! -L "$marker" ]] || {
    echo "existing XFS volume has no ownership marker" >&2
    exit 1
  }
  [[ "$(stat -c '%u:%g:%a' "$marker")" == "0:0:600" ]] || {
    echo "existing XFS volume marker is not root-owned and private" >&2
    exit 1
  }
  grep -Fqx "volume_id=$volume_id" "$marker"
  grep -Fqx "mount_path=$mount" "$marker"
  if "$mounted_read_only"; then umount "$mount"; fi
elif [[ -n "$filesystem" ]] || [[ -n "$(wipefs -n "$device")" ]] ||
  [[ "$(lsblk -n -o NAME "$device" | wc -l)" -ne 1 ]]; then
  echo "refusing to format a non-empty or partitioned Block Storage device" >&2
  exit 1
else
  mkfs.xfs "$device"
fi

uuid=$(blkid -s UUID -o value "$device")
[[ "$uuid" =~ ^[A-Fa-f0-9-]+$ ]] || {
  echo "Block Storage device has no safe filesystem UUID" >&2
  exit 1
}
fstab_line="UUID=$uuid $mount xfs defaults,pquota 0 2"
if grep -Eq "[[:space:]]$mount[[:space:]]" /etc/fstab &&
  ! grep -Fqx "$fstab_line" /etc/fstab; then
  echo "expected mount path has an unrecognized fstab entry" >&2
  exit 1
fi
grep -Fqx "$fstab_line" /etc/fstab || printf '%s\n' "$fstab_line" >> /etc/fstab
mountpoint -q "$mount" || mount "$mount"
findmnt -n -o FSTYPE --target "$mount" | grep -qx xfs
mount -o remount,pquota "$mount"
install -d -o root -g root -m 0750 "$mount/.bootstrap"
install -o root -g root -m 0600 /dev/null "$marker"
printf 'volume_id=%s\nmount_path=%s\n' "$volume_id" "$mount" > "$marker"
install -d -o xmcl-node-agent -g xmcl-node-agent -m 0750 \
  "$mount/workspaces" "$mount/state"
`;
  const agentUrl = shellValue(input.releaseUrl);
  const quotaHelperUrl = shellValue(input.quotaHelperReleaseUrl);
  return `#cloud-config
package_update: true
packages:
  - docker.io
  - curl
  - ca-certificates
  - jq
  - xfsprogs
users:
  - name: xmcl-node-agent
    system: true
    shell: /usr/sbin/nologin
    lock_passwd: true
write_files:
  - path: /etc/xmcl/shared-node-agent.env
    owner: root:root
    permissions: "0600"
    content: |
${indentBlock(config)}
  - path: /etc/xmcl-shared-node-agent/quota-helper.json
    owner: root:root
    permissions: "0600"
    content: |
${indentBlock(quotaConfig)}
  - path: /usr/local/libexec/xmcl-shared-volume-setup
    owner: root:root
    permissions: "0700"
    content: |
${indentBlock(volumeSetupScript)}
  - path: /etc/systemd/system/xmcl-shared-volume-setup.service
    owner: root:root
    permissions: "0644"
    content: |
${indentBlock(volumeSetupService)}
  - path: /etc/systemd/system/xmcl-shared-node-agent.service
    owner: root:root
    permissions: "0644"
    content: |
${indentBlock(agentService)}
runcmd:
  - [bash, -ceu, "install -d -o root -g root -m 0750 /etc/xmcl /etc/xmcl-shared-node-agent /usr/local/libexec /var/lib/xmcl-bootstrap; ingress=$(curl --fail --silent --show-error --retry 5 --retry-connrefused http://169.254.169.254/v1.json | jq -er '.instance.v4.main'); case \"$ingress\" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;; *) exit 1;; esac; printf \"XMCL_SHARED_NODE_INGRESS_HOST='%s'\\n\" \"$ingress\" >> /etc/xmcl/shared-node-agent.env; systemctl enable --now docker"]
  - [bash, -ceu, "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o /var/lib/xmcl-bootstrap/xmcl-shared-node-agent.download ${agentUrl}; echo '${input.releaseSha256}  /var/lib/xmcl-bootstrap/xmcl-shared-node-agent.download' | sha256sum --check --status; install -o root -g root -m 0755 /var/lib/xmcl-bootstrap/xmcl-shared-node-agent.download /usr/local/bin/xmcl-shared-node-agent; rm -f /var/lib/xmcl-bootstrap/xmcl-shared-node-agent.download"]
  - [bash, -ceu, "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o /var/lib/xmcl-bootstrap/xmcl-quota-helper.download ${quotaHelperUrl}; echo '${input.quotaHelperReleaseSha256}  /var/lib/xmcl-bootstrap/xmcl-quota-helper.download' | sha256sum --check --status; install -o root -g root -m 4755 /var/lib/xmcl-bootstrap/xmcl-quota-helper.download /usr/local/libexec/xmcl-quota-helper; rm -f /var/lib/xmcl-bootstrap/xmcl-quota-helper.download"]
  - [bash, -ceu, "systemctl daemon-reload; systemctl enable --now xmcl-shared-node-agent"]
`;
}

export function isBlockStorageType(value: string) {
  return (SHARED_NODE_BLOCK_STORAGE_TYPES as readonly string[]).includes(value);
}

export function hasValidSharedNodeBlockStorageSettings(
  sizeGiB: string | undefined,
  blockType: string | undefined,
  minimumSizeGiB = DEFAULT_SHARED_NODE_PROFILE.totalWorkspaceGiB,
) {
  if (!sizeGiB || !blockType || !/^[1-9][0-9]*$/.test(sizeGiB)) return false;
  const size = Number(sizeGiB);
  return Number.isSafeInteger(size) &&
    size >= minimumSizeGiB &&
    isBlockStorageType(blockType);
}

export function isSharedNodeFirewallGroupId(value: string | undefined) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function hasValidSharedNodeFirewallSettings(
  firewallGroupId: string | undefined,
  portMin: string | undefined,
  portMax: string | undefined,
) {
  if (
    !isSharedNodeFirewallGroupId(firewallGroupId) ||
    !portMin ||
    !portMax ||
    !/^(?:[1-9][0-9]{0,4})$/.test(portMin) ||
    !/^(?:[1-9][0-9]{0,4})$/.test(portMax)
  ) {
    return false;
  }
  const minimum = Number(portMin);
  const maximum = Number(portMax);
  return Number.isSafeInteger(minimum) &&
    Number.isSafeInteger(maximum) &&
    minimum >= 1024 &&
    maximum <= 65535 &&
    minimum <= maximum;
}

function validateConfig(input: SharedNodeProvisioningConfig) {
  if (
    !/^https:\/\//.test(input.releaseUrl) ||
    !/^https:\/\//.test(input.quotaHelperReleaseUrl) ||
    !/^https:\/\//.test(input.controlPlaneUrl) ||
    !/^[a-f0-9]{64}$/i.test(input.releaseSha256) ||
    !/^[a-f0-9]{64}$/i.test(input.quotaHelperReleaseSha256) ||
    !isSharedNodeRegion(input.region) ||
    !isSharedNodeFirewallGroupId(input.firewallGroupId) ||
    !Number.isSafeInteger(input.blockStorageSizeGiB) ||
    input.blockStorageSizeGiB <= 0 ||
    !isBlockStorageType(input.blockStorageType) ||
    !validWorkspaceRoot(input.workspaceRoot)
  ) {
    throw new Error("shared node provisioning configuration is invalid");
  }
}

function validateCloudInitInput(input: {
  nodeId: string;
  releaseUrl: string;
  releaseSha256: string;
  quotaHelperReleaseUrl: string;
  quotaHelperReleaseSha256: string;
  controlPlaneUrl: string;
  controlPlaneCredential: string;
  volumeId: string;
  region: string;
  workspaceRoot?: string;
}) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.volumeId) ||
    !input.nodeId
  ) {
    throw new Error("shared node cloud-init configuration is invalid");
  }
  validateConfig({
    ...input,
    firewallGroupId: "validation-only",
    region: input.region,
    blockStorageSizeGiB: 1,
    blockStorageType: "high_perf",
  });
}

function validWorkspaceRoot(value: string | undefined) {
  return value === undefined ||
    (
      value.startsWith("/var/lib/xmcl-shared/") &&
      !value.split("/").includes("..")
    );
}

function safeRequestId(value: string) {
  const result = value.replace(/[^A-Za-z0-9_.:-]/g, "-");
  if (!result || result.length > 96) {
    throw new Error("shared capacity request ID is invalid");
  }
  return result;
}

function shellValue(value: string) {
  if (!value || /[\r\n'"]/.test(value)) {
    throw new Error("shared node cloud-init value is invalid");
  }
  return `'${value}'`;
}

function indentBlock(value: string) {
  return value.split("\n").map((line) => `      ${line}`).join("\n");
}

function providerError(error: unknown) {
  return error instanceof ProviderError
    ? error
    : new ProviderError("provider_unknown", "unknown");
}
