import { AccountError, randomId } from "./account.ts";
import { VultrError } from "./vultr.ts";
import type { Db } from "../db.ts";
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

export function isSharedNodeRegion(value: unknown): value is string {
  return typeof value === "string" && sharedNodeRegionPattern.test(value);
}

export interface SharedHostingNode {
  nodeId: string;
  region: string;
  status: SharedNodeStatus;
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

export interface SharedHostingServiceRecord {
  serviceId: string;
  accountId: string;
  subscriptionId: string;
  planId: SharedHostingPlan["planId"];
  status: SharedServiceStatus;
  workspace: SharedWorkspace;
  /** Selected only while stopped; the node receives it on the next restore. */
  runtimeContent?: SharedRuntimeContent;
  runtime?: {
    startedAt: string;
    settledHours: number;
  };
  storageOverageSince?: string;
  storageGraceEndsAt?: string;
  storageOverageNotifiedAt?: string;
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
 * Node agents own Docker and S3 credentials. The API only sends an idempotent
 * command with an object prefix, resource limits, and assignment ID.
 */
export interface SharedNodeCommandGateway {
  dispatch(command: SharedNodeCommand): Promise<void>;
}

/** Optional platform adapter that asks infrastructure to add a shared node. */
export interface SharedNodeProvisioner {
  requestCapacity(input: {
    requestId: string;
    region: string;
    minimumMemoryMiB: number;
    minimumSharedCpu: number;
    minimumWorkspaceGiB: number;
  }): Promise<void>;
}

export interface SharedHostingSchedulerOptions {
  /** The sole configured provider region for the current shared-node pool. */
  region: string;
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
  return {
    commandId: `${kind}:${value.assignmentId}`,
    kind,
    nodeId: value.nodeId,
    serviceId: value.serviceId,
    assignmentId: value.assignmentId,
    accountId: value.accountId,
    workspace: clone(value.workspace),
    ...(value.runtimeContent
      ? { runtimeContent: clone(value.runtimeContent) }
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
      capacityRequests: (value.capacityRequests ?? []).map((item) =>
        item.status === "processing" && !item.processingAt
          ? { ...item, processingAt: item.updatedAt }
          : item
      ),
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
  private readonly region: string;
  private provisioner?: SharedNodeProvisioner;
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
    this.region = options.region;
    if (
      !Number.isSafeInteger(this.nodeHeartbeatTimeoutMs) ||
      this.nodeHeartbeatTimeoutMs <= 0 ||
      !Number.isSafeInteger(this.capacityRequestTimeoutMs) ||
      this.capacityRequestTimeoutMs <= 0
    ) {
      throw new Error("SHARED_NODE_HEARTBEAT_TIMEOUT_MS is invalid");
    }
    if (!isSharedNodeRegion(this.region)) {
      throw new Error("VULTR_SHARED_NODE_REGION_ID is invalid");
    }
  }

  async listServices(accountId: string) {
    return (await this.repository.read()).services
      .filter((item) => item.accountId === accountId)
      .map(clone);
  }

  /**
   * Returns the account-owned service for a deployment adapter without exposing
   * node placement or object-store details to an HTTP route.
   */
  async getService(accountId: string, serviceId: string) {
    return await this.requireService(accountId, serviceId);
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

  attachProvisioner(provisioner: SharedNodeProvisioner) {
    this.provisioner = provisioner;
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
          current.status = error instanceof VultrError &&
              error.outcome === "definitive"
            ? "failed"
            : "queued";
          current.lastError = error instanceof Error
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
        if (existing.region !== this.region) {
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
      if (node.region !== this.region) {
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
        item.nodeId === nodeId && item.region === this.region
      ),
    );
  }

  isPoolRegion(region: string) {
    return isSharedNodeRegion(region) && region === this.region;
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
      if (existing) throw new AccountError(409, "shared_service_exists");
      const serviceId = this.createId("shared_service");
      const created: SharedHostingServiceRecord = {
        serviceId,
        accountId: input.accountId,
        subscriptionId: subscription.subscriptionId,
        planId: subscription.planId,
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
      if (!["ready", "queued", "failed"].includes(value.status)) {
        throw new AccountError(409, "shared_service_not_startable");
      }
      state.idempotency.push({
        accountId,
        key: scope,
        fingerprint: requestFingerprint,
        serviceId,
      });
      return this.assignOrQueue(state, value, now);
    });
    await this.dispatch(outcome.command ? [outcome.command] : []);
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
    const runtime = existing.runtime && this.subscriptions.settleRuntime
      ? await this.subscriptions.settleRuntime({
        accountId: existing.accountId,
        serviceId: existing.serviceId,
        subscriptionId: existing.subscriptionId,
        planId: existing.planId,
        assignmentId: existing.assignmentId,
        startedAt: existing.runtime.startedAt,
        settledHours: existing.runtime.settledHours,
        settledAt: now,
      })
      : undefined;
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
      value.status = "ready";
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
      value.statusReason = runtime?.status === "payment_due"
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
    const node = selectNode(state, selected, this.region);
    if (!node) {
      const shouldRequestCapacity = !value.capacityRequestedAt;
      value.status = "queued";
      value.statusReason = "capacity_wait";
      value.capacityRequestedAt ??= now;
      value.updatedAt = now;
      if (shouldRequestCapacity) {
        state.capacityRequests.push({
          requestId: `shared-capacity:${value.serviceId}`,
          region: this.region,
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
    value.status = "starting";
    value.statusReason = "workspace_restore_requested";
    value.capacityRequestedAt = undefined;
    value.updatedAt = now;
    return {
      service: clone(value),
      command: commandFor(
        value,
        selected,
        "workspace.restore_and_start",
      ),
      capacityRequest: undefined,
    };
  }

  private async dispatch(commands: SharedNodeCommand[]) {
    for (const command of commands) await this.nodes.dispatch(command);
  }

  private validateNode(node: Omit<SharedHostingNode, "lastHeartbeatAt">) {
    if (
      !node.nodeId || !this.isPoolRegion(node.region) ||
      !["ready", "draining", "offline"].includes(node.status) ||
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
