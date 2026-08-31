import { AccountError, randomId } from "./account.ts";
import type { Db } from "./db.ts";
import {
  InfrastructureError,
  infrastructureErrorDiagnostic,
  type SharedNodeProvisioner,
  type SharedNodeWorkloadClass,
} from "./sharedNodeInfrastructure.ts";
export type {
  SharedNodeCapacityDemand,
  SharedNodeProvisioner,
  SharedNodeWorkloadClass,
} from "./sharedNodeInfrastructure.ts";
import type {
  PublicSharedHostingSubscription,
  SharedHostingPlan,
  SharedHostingRuntimeCharge,
  SharedHostingRuntimeSettlementInput,
} from "./sharedHosting.ts";
import {
  SHARED_HOSTING_PLANS,
  SHARED_HOSTING_STORAGE_GRACE_PERIOD_MS,
} from "./sharedHosting.ts";

export type SharedNodeStatus = "ready" | "draining" | "offline";
export type SharedServiceStatus =
  | "ready"
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "retained"
  | "failed"
  | "deleted";

const sharedNodeRegionPattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function validateRuntimeContent(content: SharedRuntimeContent) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(content.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(content.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(content.sha256) ||
    !Number.isSafeInteger(content.compressedSize) ||
    content.compressedSize <= 0 ||
    !Number.isSafeInteger(content.logicalSize) || content.logicalSize < 0 ||
    content.paths.length === 0 || content.paths.length > 100_000 ||
    typeof content.eulaAccepted !== "boolean" ||
    !content.key.startsWith("shared-hosting/") ||
    !content.key.endsWith(".tar.zst") ||
    content.paths.some((path) =>
      !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
  ) {
    throw new AccountError(422, "invalid_runtime_content");
  }
}

function validateInitialWorld(world: SharedInitialWorld) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(world.seedId) ||
    !/^[a-f0-9]{64}$/.test(world.sha256) ||
    !Number.isSafeInteger(world.sizeBytes) || world.sizeBytes < 1 ||
    typeof world.worldName !== "string" || !world.worldName.trim() ||
    world.worldName.length > 255
  ) {
    throw new AccountError(422, "invalid_initial_world");
  }
}

export function isSharedNodeRegion(value: unknown): value is string {
  return typeof value === "string" && sharedNodeRegionPattern.test(value);
}

export interface SharedHostingNode {
  nodeId: string;
  region: string;
  status: SharedNodeStatus;
  workloadClasses?: readonly SharedNodeWorkloadClass[];
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
  lastHeartbeatAt: string;
}

export interface SharedWorkspace {
  objectPrefix: string;
  revision: number;
  sizeBytes: number;
  physicalBytes?: number;
  sha256?: string;
  syncedAt?: string;
}

/**
 * An immutable compiler-owned content archive. This deliberately carries no
 * image, command, environment, URL, or storage credential chosen by a user.
 */
export interface SharedRuntimeContent {
  deploymentId: string;
  manifestSha256: string;
  key: string;
  sha256: string;
  compressedSize: number;
  logicalSize: number;
  paths: readonly string[];
  /** Set by the server-side terms policy adapter, never compiler/customer data. */
  eulaAccepted: boolean;
}

/** Immutable local-world archive selected only before the service's first start. */
export interface SharedInitialWorld {
  seedId: string;
  sha256: string;
  sizeBytes: number;
  worldName: string;
}

export interface SharedHostingServiceRecord {
  serviceId: string;
  accountId: string;
  subscriptionId: string;
  planId: SharedHostingPlan["planId"];
  regionId?: string;
  status: SharedServiceStatus;
  workspace: SharedWorkspace;
  /** Selected only while stopped; the node receives it on the next restore. */
  runtimeContent?: SharedRuntimeContent;
  /** Selected only before first start; the node restores it with the first workspace. */
  initialWorld?: SharedInitialWorld;
  /** Set once its first-start command has carried the seed; never resend it. */
  initialWorldSent?: true;
  /** Durable first-start fence: a seed must never replace a runtime world. */
  hasStarted?: true;
  runtime?: {
    startedAt: string;
    settledHours: number;
    stoppedAt?: string;
  };
  storageOverageSince?: string;
  storageGraceEndsAt?: string;
  storageOverageNotifiedAt?: string;
  retentionStartedAt?: string;
  retentionEndsAt?: string;
  nodeId?: string;
  assignmentId?: string;
  capacityRequestedAt?: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface SchedulerIdempotency {
  accountId: string;
  key: string;
  fingerprint: string;
  serviceId: string;
}

export interface SharedHostingSchedulerState {
  revision: number;
  nodes: SharedHostingNode[];
  services: SharedHostingServiceRecord[];
  idempotency: SchedulerIdempotency[];
  capacityRequests: SharedCapacityRequest[];
}

export interface SharedCapacityRequest {
  requestId: string;
  region: string;
  workloadClass: SharedNodeWorkloadClass;
  minimumMemoryMiB: number;
  minimumSharedCpu: number;
  minimumWorkspaceGiB: number;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  lastError?: string;
  processingAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedHostingSchedulerRepository {
  read(): Promise<SharedHostingSchedulerState>;
  transact<T>(mutation: (state: SharedHostingSchedulerState) => T): Promise<T>;
}

export interface SharedHostingSubscriptionLookup {
  activeSubscription(
    accountId: string,
    subscriptionId: string,
  ): Promise<PublicSharedHostingSubscription>;
  settleRuntime?(
    input: SharedHostingRuntimeSettlementInput,
  ): Promise<SharedHostingRuntimeCharge>;
}

export interface SharedNodeCommand {
  commandId: string;
  kind: "workspace.restore_and_start" | "workspace.stop_and_sync";
  nodeId: string;
  serviceId: string;
  assignmentId: string;
  accountId: string;
  workspace: SharedWorkspace;
  runtimeContent?: SharedRuntimeContent;
  initialWorld?: SharedInitialWorld;
  eulaAccepted?: true;
  resources: {
    memoryMiB: number;
    sharedCpu: number;
    burstCpu: number;
    workspaceGiB: number;
  };
  /** Assigned by the control-plane ingress reservation before durable dispatch. */
  connection?: {
    host: string;
    hostPort: number;
  };
}

/**
 * Node agents own Docker but no Azure storage credentials. The API sends an idempotent
 * command with an object prefix, resource limits, and assignment ID.
 */
export interface SharedNodeCommandGateway {
  dispatch(command: SharedNodeCommand): Promise<void>;
}

export interface SharedHostingSchedulerOptions {
  /** Backward-compatible default region for records created before region selection. */
  region: string;
  /** Every region this scheduler is allowed to place or provision into. */
  regions?: readonly string[];
  now?: () => Date;
  createId?: (prefix: string) => string;
  nodeHeartbeatTimeoutMs?: number;
  capacityRequestTimeoutMs?: number;
  notifyStorageOverage?: (input: {
    accountId: string;
    serviceId: string;
    logicalBytes: number;
    physicalBytes: number;
    quotaBytes: number;
    graceEndsAt: string;
  }) => Promise<void>;
}

export type SharedRetentionPurger = (
  service: SharedHostingServiceRecord,
) => Promise<void>;

function emptyState(): SharedHostingSchedulerState {
  return {
    revision: 0,
    nodes: [],
    services: [],
    idempotency: [],
    capacityRequests: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function plan(planId: string) {
  const result = SHARED_HOSTING_PLANS.find((item) => item.planId === planId);
  if (!result) throw new AccountError(422, "shared_plan_not_available");
  return result;
}

function workloadClass(planId: SharedHostingPlan["planId"]) {
  return planId === "shared-large" ? "large" : "standard";
}

function service(state: SharedHostingSchedulerState, serviceId: string) {
  return state.services.find((item) => item.serviceId === serviceId);
}

function fingerprint(value: unknown) {
  return JSON.stringify(value);
}

function workspacePrefix(accountId: string, serviceId: string) {
  return `shared-hosting/${accountId}/${serviceId}/`;
}

function activeOnNode(status: SharedServiceStatus) {
  return ["starting", "running", "stopping"].includes(status);
}

function nodeUsage(state: SharedHostingSchedulerState, nodeId: string) {
  let memoryMiB = 0;
  let sharedCpu = 0;
  let workspaceGiB = 0;
  for (const value of state.services) {
    if (value.nodeId !== nodeId || !activeOnNode(value.status)) continue;
    const selected = plan(value.planId);
    memoryMiB += selected.memoryMiB;
    sharedCpu += selected.sharedCpu;
    workspaceGiB += selected.persistentStorageGiB;
  }
  return { memoryMiB, sharedCpu, workspaceGiB };
}

function selectNode(
  state: SharedHostingSchedulerState,
  selected: SharedHostingPlan,
  region: string,
) {
  return state.nodes
    .filter((node) => node.status === "ready" && node.region === region)
    .filter((node) =>
      !node.workloadClasses ||
      node.workloadClasses.includes(workloadClass(selected.planId))
    )
    .map((node) => ({ node, usage: nodeUsage(state, node.nodeId) }))
    .filter(({ node, usage }) =>
      node.totalMemoryMiB - usage.memoryMiB >= selected.memoryMiB &&
      node.totalSharedCpu - usage.sharedCpu >= selected.sharedCpu &&
      node.totalWorkspaceGiB - usage.workspaceGiB >=
        selected.persistentStorageGiB
    )
    .sort((left, right) =>
      (left.node.totalMemoryMiB - left.usage.memoryMiB - selected.memoryMiB) -
        (right.node.totalMemoryMiB - right.usage.memoryMiB -
          selected.memoryMiB) ||
      (left.node.totalWorkspaceGiB - left.usage.workspaceGiB -
          selected.persistentStorageGiB) -
        (right.node.totalWorkspaceGiB - right.usage.workspaceGiB -
          selected.persistentStorageGiB) ||
      left.node.nodeId.localeCompare(right.node.nodeId)
    )[0]?.node;
}

function commandFor(
  value: SharedHostingServiceRecord,
  selected: SharedHostingPlan,
  kind: SharedNodeCommand["kind"],
): SharedNodeCommand {
  if (!value.nodeId || !value.assignmentId) {
    throw new Error("Shared service has no assigned node");
  }
  const workspace = clone(value.workspace);
  if (
    kind === "workspace.restore_and_start" &&
    value.runtimeContent &&
    workspace.sizeBytes === 0
  ) {
    workspace.revision = 0;
    workspace.physicalBytes = undefined;
    workspace.sha256 = undefined;
    workspace.syncedAt = undefined;
  }
  return {
    commandId: `${kind}:${value.assignmentId}`,
    kind,
    nodeId: value.nodeId,
    serviceId: value.serviceId,
    assignmentId: value.assignmentId,
    accountId: value.accountId,
    workspace,
    ...(value.runtimeContent
      ? { runtimeContent: clone(value.runtimeContent) }
      : {}),
    ...(value.initialWorld && !value.initialWorldSent
      ? { initialWorld: clone(value.initialWorld) }
      : {}),
    ...(value.runtimeContent?.eulaAccepted ? { eulaAccepted: true } : {}),
    resources: {
      memoryMiB: selected.memoryMiB,
      sharedCpu: selected.sharedCpu,
      burstCpu: selected.burstCpu,
      workspaceGiB: selected.persistentStorageGiB,
    },
  };
}

export class MemorySharedHostingSchedulerRepository
  implements SharedHostingSchedulerRepository {
  private state = emptyState();
  private tail: Promise<void> = Promise.resolve();

  async read() {
    await this.tail;
    return clone(this.state);
  }

  async transact<T>(mutation: (state: SharedHostingSchedulerState) => T) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = clone(this.state);
      const result = mutation(draft);
      draft.revision += 1;
      this.state = draft;
      return clone(result);
    } finally {
      release();
    }
  }
}

interface StoredSchedulerState extends SharedHostingSchedulerState {
  _id: string;
  mutationIds: string[];
}

function persistedState(
  value?: StoredSchedulerState | null,
): StoredSchedulerState {
  if (value) {
    return {
      ...value,
      capacityRequests: (value.capacityRequests ?? []).map((item) => ({
        ...item,
        workloadClass: item.workloadClass ??
          (item.minimumMemoryMiB >= 8 * 1024 &&
              item.minimumSharedCpu >= 4 &&
              item.minimumWorkspaceGiB >= 64
            ? "large"
            : "standard"),
        ...(item.status === "processing" && !item.processingAt
          ? { processingAt: item.updatedAt }
          : {}),
      })),
    };
  }
  return {
    _id: "shared-hosting-scheduler-v1",
    ...emptyState(),
    mutationIds: [],
  };
}

/**
 * A single regional scheduler aggregate. Revision CAS ensures node capacity is
 * never oversubscribed by concurrent API requests.
 */
export class MongoSharedHostingSchedulerRepository
  implements SharedHostingSchedulerRepository {
  constructor(private readonly db: Db, private readonly maxAttempts = 8) {}

  async read() {
    const found = await this.collection().findOne({
      _id: "shared-hosting-scheduler-v1",
    }) as StoredSchedulerState | null;
    const { _id: _, mutationIds: __, ...state } = persistedState(found);
    return clone(state);
  }

  async transact<T>(mutation: (state: SharedHostingSchedulerState) => T) {
    const collection = this.collection();
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const current = await collection.findOne({
        _id: "shared-hosting-scheduler-v1",
      }) as StoredSchedulerState | null;
      const stored = persistedState(current);
      const draft = clone(stored);
      const result = mutation(draft);
      const mutationId = crypto.randomUUID();
      draft.revision = stored.revision + 1;
      draft.mutationIds = [...stored.mutationIds.slice(-63), mutationId];
      try {
        if (current) {
          await collection.replaceOne(
            { _id: stored._id, revision: stored.revision },
            draft as unknown as Record<string, unknown>,
          );
        } else {
          await collection.updateOne(
            { _id: stored._id, revision: { $exists: false } },
            { $setOnInsert: draft as unknown as Record<string, unknown> },
            { upsert: true },
          );
        }
      } catch {
        continue;
      }
      const verified = await collection.findOne({ _id: stored._id }) as
        | StoredSchedulerState
        | null;
      if (verified?.mutationIds.includes(mutationId)) return clone(result);
    }
    throw new Error("shared_hosting_scheduler_conflict");
  }

  private collection() {
    return this.db.collection("shared_hosting_scheduler");
  }
}

export class SharedHostingScheduler {
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly nodeHeartbeatTimeoutMs: number;
  private readonly capacityRequestTimeoutMs: number;
  private readonly defaultRegion: string;
  private readonly regions: ReadonlySet<string>;
  private provisioner?: SharedNodeProvisioner;
  private retentionPurger?: SharedRetentionPurger;
  private readonly notifyStorageOverage?: SharedHostingSchedulerOptions[
    "notifyStorageOverage"
  ];

  constructor(
    private readonly repository: SharedHostingSchedulerRepository,
    private readonly subscriptions: SharedHostingSubscriptionLookup,
    private readonly nodes: SharedNodeCommandGateway,
    provisioner: SharedNodeProvisioner | undefined,
    options: SharedHostingSchedulerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
    this.provisioner = provisioner;
    this.notifyStorageOverage = options.notifyStorageOverage;
    this.nodeHeartbeatTimeoutMs = options.nodeHeartbeatTimeoutMs ?? 90_000;
    this.capacityRequestTimeoutMs = options.capacityRequestTimeoutMs ??
      10 * 60_000;
    this.defaultRegion = options.region;
    this.regions = new Set(options.regions ?? [options.region]);
    if (
      !Number.isSafeInteger(this.nodeHeartbeatTimeoutMs) ||
      this.nodeHeartbeatTimeoutMs <= 0 ||
      !Number.isSafeInteger(this.capacityRequestTimeoutMs) ||
      this.capacityRequestTimeoutMs <= 0
    ) {
      throw new Error("SHARED_NODE_HEARTBEAT_TIMEOUT_MS is invalid");
    }
    if (
      !isSharedNodeRegion(this.defaultRegion) ||
      this.regions.size === 0 ||
      !this.regions.has(this.defaultRegion) ||
      [...this.regions].some((region) => !isSharedNodeRegion(region))
    ) {
      throw new Error("shared node region is invalid");
    }
  }

  async listServices(accountId: string) {
    return (await this.repository.read()).services
      .filter((item) => item.accountId === accountId)
      .map(clone);
  }

  async listAllServices() {
    return (await this.repository.read()).services.map(clone);
  }

  /**
   * Returns the account-owned service for a deployment adapter without exposing
   * node placement or object-store details to an HTTP route.
   */
  async getService(accountId: string, serviceId: string) {
    return await this.requireService(accountId, serviceId);
  }

  async findService(accountId: string, serviceId: string) {
    const value = (await this.repository.read()).services.find((item) =>
      item.serviceId === serviceId && item.accountId === accountId
    );
    return value ? clone(value) : undefined;
  }

  async findServiceById(serviceId: string) {
    const value = (await this.repository.read()).services.find((item) =>
      item.serviceId === serviceId
    );
    return value ? clone(value) : undefined;
  }

  async assertInitialWorldEligible(accountId: string, serviceId: string) {
    const value = await this.requireService(accountId, serviceId);
    await this.subscriptions.activeSubscription(
      accountId,
      value.subscriptionId,
    );
    if (
      value.status !== "ready" || value.hasStarted ||
      value.workspace.revision !== 0
    ) {
      throw new AccountError(409, "shared_initial_world_not_selectable");
    }
    return value;
  }

  /**
   * Swaps an already-published compiler content layer only while the service is
   * stopped. World/config revisions are intentionally not touched.
   */
  async selectRuntimeContent(input: {
    accountId: string;
    serviceId: string;
    content: SharedRuntimeContent;
    idempotencyKey: string;
  }) {
    validateRuntimeContent(input.content);
    const now = this.now().toISOString();
    return await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (!value || value.accountId !== input.accountId) {
        throw new AccountError(404, "shared_service_not_found");
      }
      if (value.status !== "ready") {
        throw new AccountError(409, "shared_service_must_be_stopped");
      }
      const key = `${input.accountId}:runtime-content:${input.idempotencyKey}`;
      const requestFingerprint = fingerprint({
        serviceId: input.serviceId,
        content: input.content,
      });
      const replay = state.idempotency.find((item) => item.key === key);
      if (replay) {
        if (replay.fingerprint !== requestFingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return clone(service(state, replay.serviceId)!);
      }
      value.runtimeContent = clone(input.content);
      value.statusReason = "runtime_content_selected";
      value.updatedAt = now;
      state.idempotency.push({
        accountId: input.accountId,
        key,
        fingerprint: requestFingerprint,
        serviceId: input.serviceId,
      });
      return clone(value);
    });
  }

  /**
   * A world seed is a first-start-only pointer. Runtime stop/sync revisions
   * remain authoritative once this service has ever been assigned.
   */
  async selectInitialWorld(input: {
    accountId: string;
    serviceId: string;
    world: SharedInitialWorld;
    idempotencyKey: string;
  }) {
    validateInitialWorld(input.world);
    await this.assertInitialWorldEligible(input.accountId, input.serviceId);
    const now = this.now().toISOString();
    return await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (!value || value.accountId !== input.accountId) {
        throw new AccountError(404, "shared_service_not_found");
      }
      if (
        value.status !== "ready" || value.hasStarted ||
        value.workspace.revision !== 0
      ) {
        throw new AccountError(409, "shared_initial_world_not_selectable");
      }
      const key = `${input.accountId}:initial-world:${input.idempotencyKey}`;
      const requestFingerprint = fingerprint({
        serviceId: input.serviceId,
        world: input.world,
      });
      const replay = state.idempotency.find((item) => item.key === key);
      if (replay) {
        if (replay.fingerprint !== requestFingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return clone(service(state, replay.serviceId)!);
      }
      value.initialWorld = clone(input.world);
      value.statusReason = "initial_world_selected";
      value.updatedAt = now;
      state.idempotency.push({
        accountId: input.accountId,
        key,
        fingerprint: requestFingerprint,
        serviceId: input.serviceId,
      });
      return clone(value);
    });
  }

  attachProvisioner(provisioner: SharedNodeProvisioner) {
    this.provisioner = provisioner;
  }

  attachRetentionPurger(purger: SharedRetentionPurger) {
    this.retentionPurger = purger;
  }

  async purgeExpiredRetentions(at = this.now()) {
    if (!this.retentionPurger) {
      return { deleted: [] as string[], failed: [] as string[] };
    }
    const candidates = (await this.repository.read()).services
      .filter((service) =>
        service.status === "retained" &&
        service.retentionEndsAt !== undefined &&
        Date.parse(service.retentionEndsAt) <= at.getTime()
      )
      .sort((left, right) =>
        left.retentionEndsAt!.localeCompare(right.retentionEndsAt!) ||
        left.serviceId.localeCompare(right.serviceId)
      );
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const candidate of candidates) {
      try {
        await this.retentionPurger(clone(candidate));
        await this.repository.transact((state) => {
          const current = service(state, candidate.serviceId);
          if (
            current?.status === "retained" &&
            current.retentionEndsAt === candidate.retentionEndsAt
          ) {
            current.status = "deleted";
            current.statusReason = "retention_expired";
            current.updatedAt = at.toISOString();
          }
        });
        deleted.push(candidate.serviceId);
      } catch {
        failed.push(candidate.serviceId);
      }
    }
    return { deleted, failed };
  }

  async processCapacityRequests(limit = 4) {
    if (!this.provisioner) {
      throw new Error("shared node provisioner unavailable");
    }

    let processed = 0;
    while (processed < limit) {
      const request = await this.repository.transact((state) => {
        const now = this.now();
        const candidate = state.capacityRequests
          .filter((item) =>
            item.status === "queued" ||
            (
              item.status === "processing" &&
              Date.parse(item.processingAt ?? "") +
                    this.capacityRequestTimeoutMs <= now.getTime()
            )
          )
          .sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt)
          )[0];
        if (!candidate) return undefined;
        candidate.status = "processing";
        candidate.attempts += 1;
        candidate.processingAt = now.toISOString();
        candidate.updatedAt = candidate.processingAt;
        return clone(candidate);
      });
      if (!request) break;
      try {
        await this.provisioner.requestCapacity(request);
        await this.repository.transact((state) => {
          const current = state.capacityRequests.find((item) =>
            item.requestId === request.requestId
          );
          if (current) {
            current.status = "completed";
            current.processingAt = undefined;
            current.updatedAt = this.now().toISOString();
          }
        });
        await this.scheduleQueued();
      } catch (error) {
        await this.repository.transact((state) => {
          const current = state.capacityRequests.find((item) =>
            item.requestId === request.requestId
          );
          if (!current) return;
          current.status = error instanceof InfrastructureError &&
              error.outcome === "definitive"
            ? "failed"
            : "queued";
          current.lastError = error instanceof InfrastructureError
            ? infrastructureErrorDiagnostic(error)
            : error instanceof Error
            ? error.message
            : "unknown";
          current.processingAt = undefined;
          current.updatedAt = this.now().toISOString();
        });
      }
      processed += 1;
    }
    return processed;
  }

  async reconciliationServices() {
    return (await this.repository.read()).services.map(clone);
  }

  async enforcePaymentDue(subscriptionIds: readonly string[]) {
    const wanted = new Set(subscriptionIds);
    const commands = await this.repository.transact((state) => {
      const result: SharedNodeCommand[] = [];
      for (const value of state.services) {
        if (
          !wanted.has(value.subscriptionId) ||
          !["starting", "running"].includes(value.status)
        ) continue;
        value.status = "stopping";
        value.statusReason = "payment_due";
        value.updatedAt = this.now().toISOString();
        result.push(
          commandFor(value, plan(value.planId), "workspace.stop_and_sync"),
        );
      }

      return result;
    });
    await this.dispatch(commands);
    return commands.map((command) => command.serviceId);
  }

  async beginCancellationRetention(
    retentions: readonly {
      subscriptionId: string;
      retentionStartedAt: string;
      retentionEndsAt: string;
    }[],
  ) {
    const bySubscription = new Map(
      retentions.map((retention) => [retention.subscriptionId, retention]),
    );
    const commands = await this.repository.transact((state) => {
      const result: SharedNodeCommand[] = [];
      for (const value of state.services) {
        const retention = bySubscription.get(value.subscriptionId);
        if (!retention || value.status === "deleted") continue;
        value.retentionStartedAt = retention.retentionStartedAt;
        value.retentionEndsAt = retention.retentionEndsAt;
        value.updatedAt = this.now().toISOString();
        if (["starting", "running"].includes(value.status)) {
          value.status = "stopping";
          value.statusReason = "cancellation_sync";
          result.push(
            commandFor(value, plan(value.planId), "workspace.stop_and_sync"),
          );
        } else if (value.status !== "stopping") {
          value.nodeId = undefined;
          value.assignmentId = undefined;
          value.runtime = undefined;
          value.status = "retained";
          value.statusReason = "cancellation_retention";
        }
      }
      return result;
    });
    await this.dispatch(commands);
    return commands.map((command) => command.serviceId);
  }

  async settleRunningRuntime(at = this.now()) {
    const candidates = (await this.repository.read()).services.filter((value) =>
      value.status === "running" && value.runtime
    );
    const settled: string[] = [];
    const paymentDue: string[] = [];
    for (const candidate of candidates) {
      const runtime = candidate.runtime!;
      if (!this.subscriptions.settleRuntime) continue;
      const charge = await this.subscriptions.settleRuntime({
        accountId: candidate.accountId,
        serviceId: candidate.serviceId,
        subscriptionId: candidate.subscriptionId,
        planId: candidate.planId,
        assignmentId: candidate.assignmentId!,
        startedAt: runtime.startedAt,
        settledHours: runtime.settledHours,
        settledAt: at.toISOString(),
      });
      if (charge.status === "payment_due") {
        const commands = await this.enforcePaymentDue([
          candidate.subscriptionId,
        ]);
        if (commands.includes(candidate.serviceId)) {
          paymentDue.push(candidate.serviceId);
        }
        continue;
      }
      if (charge.chargedHours <= runtime.settledHours) continue;
      await this.repository.transact((state) => {
        const value = service(state, candidate.serviceId);
        if (
          value?.status === "running" &&
          value.assignmentId === candidate.assignmentId &&
          value.runtime
        ) {
          value.runtime.settledHours = Math.max(
            value.runtime.settledHours,
            charge.chargedHours,
          );
          value.updatedAt = at.toISOString();
        }
      });
      settled.push(candidate.serviceId);
    }
    return { settled, paymentDue };
  }

  async registerNode(input: Omit<SharedHostingNode, "lastHeartbeatAt">) {
    this.validateNode(input);
    const now = this.now().toISOString();
    await this.repository.transact((state) => {
      const existing = state.nodes.find((item) => item.nodeId === input.nodeId);
      if (existing) {
        if (existing.region !== input.region) {
          throw new AccountError(422, "invalid_shared_node");
        }
        Object.assign(existing, input, { lastHeartbeatAt: now });
      } else {
        state.nodes.push({ ...input, lastHeartbeatAt: now });
      }
    });
    await this.scheduleQueued();
  }

  async heartbeatNode(
    nodeId: string,
    reportedStatus: "ready" | "draining" = "ready",
  ) {
    const now = this.now().toISOString();
    await this.repository.transact((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) throw new AccountError(404, "shared_node_not_found");
      if (!this.isPoolRegion(node.region)) {
        throw new AccountError(422, "invalid_shared_node");
      }
      node.lastHeartbeatAt = now;
      // A node may self-drain after a local safety failure. Readiness is only
      // restored by explicit control-plane reconciliation, never a later beat.
      if (reportedStatus === "draining" && node.status !== "offline") {
        node.status = "draining";
      }
    });
  }

  async hasNode(nodeId: string) {
    return Boolean(
      (await this.repository.read()).nodes.find((item) =>
        item.nodeId === nodeId && this.isPoolRegion(item.region)
      ),
    );
  }

  isPoolRegion(region: string) {
    return isSharedNodeRegion(region) && this.regions.has(region);
  }

  async markNodeDraining(nodeId: string) {
    await this.repository.transact((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) throw new AccountError(404, "shared_node_not_found");
      if (node.status !== "offline") node.status = "draining";
    });
  }

  async activeServicesOnNode(nodeId: string) {
    return (await this.repository.read()).services
      .filter((item) => item.nodeId === nodeId && activeOnNode(item.status))
      .map(clone);
  }

  async removeNode(nodeId: string) {
    await this.repository.transact((state) => {
      const index = state.nodes.findIndex((item) => item.nodeId === nodeId);
      if (index < 0) throw new AccountError(404, "shared_node_not_found");
      if (
        state.services.some((item) =>
          item.nodeId === nodeId && activeOnNode(item.status)
        )
      ) {
        throw new AccountError(409, "shared_node_has_active_services");
      }
      state.nodes.splice(index, 1);
    });
  }

  async drainNode(nodeId: string) {
    const commands = await this.repository.transact((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) throw new AccountError(404, "shared_node_not_found");
      if (node.status !== "offline") node.status = "draining";
      const result: SharedNodeCommand[] = [];
      for (const value of state.services) {
        if (
          value.nodeId !== nodeId ||
          !["starting", "running"].includes(value.status)
        ) continue;
        value.status = "stopping";
        value.statusReason = "node_draining";
        value.updatedAt = this.now().toISOString();
        result.push(
          commandFor(value, plan(value.planId), "workspace.stop_and_sync"),
        );
      }
      return result;
    });
    await this.dispatch(commands);
  }

  async sweepStaleNodes(
    timeoutMs = this.nodeHeartbeatTimeoutMs,
    at = this.now(),
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("shared node heartbeat timeout is invalid");
    }
    const cutoff = at.getTime() - timeoutMs;
    await this.repository.transact((state) => {
      for (const node of state.nodes) {
        if (
          node.status === "ready" &&
          Date.parse(node.lastHeartbeatAt) < cutoff
        ) {
          node.status = "offline";
        }
      }
    });
  }

  async createService(input: {
    accountId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }) {
    const subscription = await this.subscriptions.activeSubscription(
      input.accountId,
      input.subscriptionId,
    );
    const regionId = subscription.regionId ?? this.defaultRegion;
    if (!this.isPoolRegion(regionId)) {
      throw new AccountError(503, "shared_region_unavailable");
    }
    const now = this.now().toISOString();
    return await this.repository.transact((state) => {
      const scope = `${input.accountId}:create:${input.idempotencyKey}`;
      const requestFingerprint = fingerprint({
        subscriptionId: input.subscriptionId,
      });
      const replay = state.idempotency.find((item) => item.key === scope);
      if (replay) {
        if (replay.fingerprint !== requestFingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return clone(service(state, replay.serviceId)!);
      }
      const existing = state.services.find((item) =>
        item.subscriptionId === subscription.subscriptionId &&
        item.status !== "deleted"
      );
      if (existing) {
        state.idempotency.push({
          accountId: input.accountId,
          key: scope,
          fingerprint: requestFingerprint,
          serviceId: existing.serviceId,
        });
        return clone(existing);
      }
      const serviceId = this.createId("shared_service");
      const created: SharedHostingServiceRecord = {
        serviceId,
        accountId: input.accountId,
        subscriptionId: subscription.subscriptionId,
        planId: subscription.planId,
        regionId,
        status: "ready",
        workspace: {
          objectPrefix: workspacePrefix(input.accountId, serviceId),
          revision: 0,
          sizeBytes: 0,
        },
        createdAt: now,
        updatedAt: now,
      };
      state.services.push(created);
      state.idempotency.push({
        accountId: input.accountId,
        key: scope,
        fingerprint: requestFingerprint,
        serviceId,
      });
      return clone(created);
    });
  }

  async start(
    accountId: string,
    serviceId: string,
    idempotencyKey: string,
  ) {
    const current = await this.requireService(accountId, serviceId);
    await this.subscriptions.activeSubscription(
      accountId,
      current.subscriptionId,
    );
    this.assertStorageStartable(current);
    const now = this.now().toISOString();
    const outcome = await this.repository.transact((state) => {
      const value = service(state, serviceId);
      if (!value || value.accountId !== accountId) {
        throw new AccountError(404, "shared_service_not_found");
      }
      const scope = `${accountId}:start:${idempotencyKey}`;
      const requestFingerprint = fingerprint({ serviceId });
      const replay = state.idempotency.find((item) => item.key === scope);
      if (replay) {
        if (replay.fingerprint !== requestFingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return {
          service: clone(service(state, replay.serviceId)!),
          command: undefined,
          capacityRequest: undefined,
        };
      }
      if (value.status === "starting" && value.assignmentId && value.nodeId) {
        state.idempotency.push({
          accountId,
          key: scope,
          fingerprint: requestFingerprint,
          serviceId,
        });
        return {
          service: clone(value),
          command: commandFor(
            value,
            plan(value.planId),
            "workspace.restore_and_start",
          ),
          capacityRequest: undefined,
        };
      }
      if (!["ready", "queued", "failed"].includes(value.status)) {
        throw new AccountError(409, "shared_service_not_startable");
      }
      if (value.status === "ready") value.hasStarted = true;
      state.idempotency.push({
        accountId,
        key: scope,
        fingerprint: requestFingerprint,
        serviceId,
      });
      return this.assignOrQueue(state, value, now);
    });
    try {
      await this.dispatch(outcome.command ? [outcome.command] : []);
    } catch (error) {
      if (outcome.command) {
        await this.repository.transact((state) => {
          const value = service(state, serviceId);
          if (
            value?.status === "starting" &&
            value.assignmentId === outcome.command?.assignmentId &&
            !value.runtime
          ) {
            value.nodeId = undefined;
            value.assignmentId = undefined;
            value.status = "ready";
            value.statusReason = "command_dispatch_failed";
            value.updatedAt = this.now().toISOString();
          }
        });
      }
      throw error;
    }
    return outcome.service;
  }

  async stop(accountId: string, serviceId: string, idempotencyKey: string) {
    const now = this.now().toISOString();
    const command = await this.repository.transact((state) => {
      const value = service(state, serviceId);
      if (!value || value.accountId !== accountId) {
        throw new AccountError(404, "shared_service_not_found");
      }
      const scope = `${accountId}:stop:${idempotencyKey}`;
      const requestFingerprint = fingerprint({ serviceId });
      const replay = state.idempotency.find((item) => item.key === scope);
      if (replay) return undefined;
      if (!["starting", "running"].includes(value.status)) {
        throw new AccountError(409, "shared_service_not_stoppable");
      }
      state.idempotency.push({
        accountId,
        key: scope,
        fingerprint: requestFingerprint,
        serviceId,
      });
      value.status = "stopping";
      value.updatedAt = now;
      return commandFor(value, plan(value.planId), "workspace.stop_and_sync");
    });
    await this.dispatch(command ? [command] : []);
    return await this.requireService(accountId, serviceId);
  }

  async reportStarted(input: {
    nodeId: string;
    serviceId: string;
    assignmentId: string;
  }) {
    const now = this.now().toISOString();
    const current = await this.repository.read();
    const starting = service(current, input.serviceId);
    if (
      !starting || starting.nodeId !== input.nodeId ||
      starting.assignmentId !== input.assignmentId ||
      starting.status !== "starting"
    ) {
      throw new AccountError(409, "shared_assignment_conflict");
    }
    const runtime = this.subscriptions.settleRuntime
      ? await this.subscriptions.settleRuntime({
        accountId: starting.accountId,
        serviceId: starting.serviceId,
        subscriptionId: starting.subscriptionId,
        planId: starting.planId,
        assignmentId: starting.assignmentId,
        startedAt: now,
        settledHours: 0,
        settledAt: now,
      })
      : undefined;
    const stopCommand = await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (
        !value || value.nodeId !== input.nodeId ||
        value.assignmentId !== input.assignmentId || value.status !== "starting"
      ) {
        throw new AccountError(409, "shared_assignment_conflict");
      }
      // Dispatch is at-least-once; retain the exact selected seed on every
      // retry until the node has actually completed a healthy start.
      if (value.initialWorld) value.initialWorldSent = true;
      if (runtime?.status === "payment_due") {
        value.status = "stopping";
        value.statusReason = "runtime_payment_due";
        value.updatedAt = now;
        return commandFor(value, plan(value.planId), "workspace.stop_and_sync");
      }
      value.status = "running";
      value.statusReason = "node_healthy";
      value.runtime = {
        startedAt: now,
        settledHours: runtime?.chargedHours ?? 0,
      };
      value.updatedAt = now;
      return undefined;
    });
    await this.dispatch(stopCommand ? [stopCommand] : []);
  }

  async reportStoppedAndSynced(input: {
    nodeId: string;
    serviceId: string;
    assignmentId: string;
    workspace: Omit<SharedWorkspace, "objectPrefix">;
  }) {
    if (
      !Number.isSafeInteger(input.workspace.revision) ||
      input.workspace.revision < 0 ||
      !Number.isSafeInteger(input.workspace.sizeBytes) ||
      input.workspace.sizeBytes < 0 ||
      input.workspace.physicalBytes !== undefined &&
        (!Number.isSafeInteger(input.workspace.physicalBytes) ||
          input.workspace.physicalBytes < 0)
    ) {
      throw new AccountError(422, "invalid_shared_workspace");
    }
    const now = this.now().toISOString();
    const current = await this.repository.read();
    const existing = service(current, input.serviceId);
    if (
      !existing || existing.nodeId !== input.nodeId ||
      existing.assignmentId !== input.assignmentId ||
      existing.status !== "stopping"
    ) {
      throw new AccountError(409, "shared_assignment_conflict");
    }
    if (existing.runtime && !existing.runtime.stoppedAt) {
      throw new AccountError(409, "shared_runtime_stop_not_reported");
    }
    const outcome = await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (
        !value || value.nodeId !== input.nodeId ||
        value.assignmentId !== input.assignmentId || value.status !== "stopping"
      ) {
        throw new AccountError(409, "shared_assignment_conflict");
      }
      if (input.workspace.revision < value.workspace.revision) {
        throw new AccountError(409, "shared_workspace_out_of_order");
      }
      value.workspace = {
        ...input.workspace,
        objectPrefix: value.workspace.objectPrefix,
        syncedAt: now,
      };
      value.nodeId = undefined;
      value.assignmentId = undefined;
      value.status = value.retentionEndsAt ? "retained" : "ready";
      value.runtime = undefined;
      const selected = plan(value.planId);
      const quotaBytes = selected.persistentStorageGiB * 1024 ** 3;
      if (value.workspace.sizeBytes > quotaBytes) {
        value.storageOverageSince ??= now;
        value.storageGraceEndsAt ??= new Date(
          Date.parse(value.storageOverageSince) +
            SHARED_HOSTING_STORAGE_GRACE_PERIOD_MS,
        ).toISOString();
      } else {
        value.storageOverageSince = undefined;
        value.storageGraceEndsAt = undefined;
        value.storageOverageNotifiedAt = undefined;
      }
      value.statusReason = value.retentionEndsAt
        ? "cancellation_retention"
        : value.statusReason === "runtime_payment_due"
        ? "runtime_payment_due"
        : value.storageGraceEndsAt
        ? "storage_overage_grace"
        : "workspace_synced";
      value.updatedAt = now;
      return {
        notify: Boolean(
          value.storageGraceEndsAt && !value.storageOverageNotifiedAt,
        ),
        graceEndsAt: value.storageGraceEndsAt,
        quotaBytes,
      };
    });
    if (
      outcome.notify && outcome.graceEndsAt && this.notifyStorageOverage
    ) {
      await this.notifyStorageOverage({
        accountId: existing.accountId,
        serviceId: existing.serviceId,
        logicalBytes: input.workspace.sizeBytes,
        physicalBytes: input.workspace.physicalBytes ??
          input.workspace.sizeBytes,
        quotaBytes: outcome.quotaBytes,
        graceEndsAt: outcome.graceEndsAt,
      });
      await this.repository.transact((state) => {
        const value = service(state, input.serviceId);
        if (value && value.storageGraceEndsAt === outcome.graceEndsAt) {
          value.storageOverageNotifiedAt = now;
        }
      });
    }
    await this.scheduleQueued();
  }

  async reportStopped(input: {
    nodeId: string;
    serviceId: string;
    assignmentId: string;
  }) {
    const reportedAt = this.now().toISOString();
    const stopped = await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (
        !value || value.nodeId !== input.nodeId ||
        value.assignmentId !== input.assignmentId ||
        value.status !== "stopping"
      ) {
        throw new AccountError(409, "shared_assignment_conflict");
      }
      if (!value.runtime) {
        value.nodeId = undefined;
        value.assignmentId = undefined;
        value.status = value.retentionEndsAt ? "retained" : "ready";
        value.statusReason = value.retentionEndsAt
          ? "cancellation_retention"
          : "workspace_synced";
        value.updatedAt = reportedAt;
        return { syncRequired: false as const };
      }
      value.runtime.stoppedAt ??= reportedAt;
      value.updatedAt = reportedAt;
      return {
        syncRequired: true as const,
        accountId: value.accountId,
        serviceId: value.serviceId,
        subscriptionId: value.subscriptionId,
        planId: value.planId,
        assignmentId: value.assignmentId,
        startedAt: value.runtime.startedAt,
        settledHours: value.runtime.settledHours,
        stoppedAt: value.runtime.stoppedAt,
      };
    });
    if (!stopped.syncRequired) {
      await this.scheduleQueued();
      return false;
    }
    if (!this.subscriptions.settleRuntime) return true;
    const runtime = await this.subscriptions.settleRuntime({
      accountId: stopped.accountId,
      serviceId: stopped.serviceId,
      subscriptionId: stopped.subscriptionId,
      planId: stopped.planId,
      assignmentId: stopped.assignmentId,
      startedAt: stopped.startedAt,
      settledHours: stopped.settledHours,
      settledAt: stopped.stoppedAt,
    });
    await this.repository.transact((state) => {
      const value = service(state, input.serviceId);
      if (
        !value || value.nodeId !== input.nodeId ||
        value.assignmentId !== input.assignmentId ||
        value.status !== "stopping" || !value.runtime ||
        value.runtime.stoppedAt !== stopped.stoppedAt
      ) {
        throw new AccountError(409, "shared_assignment_conflict");
      }
      value.runtime.settledHours = Math.max(
        value.runtime.settledHours,
        runtime.chargedHours,
      );
      if (runtime.status === "payment_due") {
        value.statusReason = "runtime_payment_due";
      }
      value.updatedAt = reportedAt;
    });
    return true;
  }

  async finalizeUnstartedStops() {
    const now = this.now().toISOString();
    const finalized = await this.repository.transact((state) => {
      const serviceIds: string[] = [];
      for (const value of state.services) {
        if (value.status !== "stopping" || value.runtime) continue;
        value.nodeId = undefined;
        value.assignmentId = undefined;
        value.status = value.retentionEndsAt ? "retained" : "ready";
        value.statusReason = value.retentionEndsAt
          ? "cancellation_retention"
          : "workspace_synced";
        value.updatedAt = now;
        serviceIds.push(value.serviceId);
      }
      return serviceIds;
    });
    if (finalized.length) await this.scheduleQueued();
    return finalized;
  }

  private async requireService(accountId: string, serviceId: string) {
    const value = (await this.repository.read()).services.find((item) =>
      item.serviceId === serviceId && item.accountId === accountId
    );
    if (!value) throw new AccountError(404, "shared_service_not_found");
    return value;
  }

  private assertStorageStartable(value: SharedHostingServiceRecord) {
    if (
      value.storageGraceEndsAt &&
      Date.parse(value.storageGraceEndsAt) <= this.now().getTime()
    ) {
      throw new AccountError(409, "shared_storage_over_quota");
    }
  }

  private async scheduleQueued() {
    const queued = (await this.repository.read()).services
      .filter((item) => item.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const candidate of queued) {
      try {
        await this.subscriptions.activeSubscription(
          candidate.accountId,
          candidate.subscriptionId,
        );
      } catch {
        continue;
      }
      const now = this.now().toISOString();
      const outcome = await this.repository.transact((state) => {
        const value = service(state, candidate.serviceId);
        if (!value || value.status !== "queued") {
          return {
            command: undefined,
            capacityRequest: undefined,
          };
        }
        return this.assignOrQueue(state, value, now);
      });
      await this.dispatch(outcome.command ? [outcome.command] : []);
    }
  }

  private assignOrQueue(
    state: SharedHostingSchedulerState,
    value: SharedHostingServiceRecord,
    now: string,
  ) {
    const selected = plan(value.planId);
    const region = value.regionId ?? this.defaultRegion;
    if (!this.isPoolRegion(region)) {
      throw new AccountError(503, "shared_region_unavailable");
    }
    const node = selectNode(state, selected, region);
    if (!node) {
      const shouldRequestCapacity = !value.capacityRequestedAt;
      value.status = "queued";
      value.statusReason = "capacity_wait";
      value.capacityRequestedAt ??= now;
      value.updatedAt = now;
      if (shouldRequestCapacity) {
        state.capacityRequests.push({
          requestId: `shared-capacity:${value.serviceId}`,
          region,
          workloadClass: workloadClass(value.planId),
          minimumMemoryMiB: selected.memoryMiB,
          minimumSharedCpu: selected.sharedCpu,
          minimumWorkspaceGiB: selected.persistentStorageGiB,
          status: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      return {
        service: clone(value),
        command: undefined,
        capacityRequest: undefined,
      };
    }
    value.nodeId = node.nodeId;
    value.assignmentId = this.createId("assignment");
    value.hasStarted = true;
    value.status = "starting";
    value.statusReason = "workspace_restore_requested";
    value.capacityRequestedAt = undefined;
    value.updatedAt = now;
    const command = commandFor(
      value,
      selected,
      "workspace.restore_and_start",
    );
    return {
      service: clone(value),
      command,
      capacityRequest: undefined,
    };
  }

  private async dispatch(commands: SharedNodeCommand[]) {
    for (const command of commands) {
      try {
        await this.nodes.dispatch(command);
      } catch (error) {
        console.error({
          event: "shared_hosting.command_dispatch_failed",
          commandId: command.commandId,
          kind: command.kind,
          nodeId: command.nodeId,
          serviceId: command.serviceId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  private validateNode(node: Omit<SharedHostingNode, "lastHeartbeatAt">) {
    if (
      !node.nodeId || !this.isPoolRegion(node.region) ||
      !["ready", "draining", "offline"].includes(node.status) ||
      node.workloadClasses !== undefined &&
        (node.workloadClasses.length === 0 ||
          node.workloadClasses.some((value) =>
            value !== "standard" && value !== "large"
          )) ||
      !Number.isSafeInteger(node.totalMemoryMiB) ||
      !Number.isSafeInteger(node.totalSharedCpu) ||
      !Number.isSafeInteger(node.totalWorkspaceGiB) ||
      node.totalMemoryMiB <= 0 || node.totalSharedCpu <= 0 ||
      node.totalWorkspaceGiB <= 0
    ) {
      throw new AccountError(422, "invalid_shared_node");
    }
  }
}
