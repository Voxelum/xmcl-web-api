import type {
  AdminOperationCompleted,
  AdminOperationRequested,
  BillingAuthorizationGateway,
  ServerControlEvent,
  ServerControlWorkerEvent,
  WorkerBalanceStopRequired,
  WorkerGateway,
  WorkerRuntimeStoppedEvent,
  WorldBackupDeletionGateway,
} from "./serverControlProposals.ts";
import {
  type AccountServerState,
  type ConsumedEventRecord,
  findLease,
  findServer,
  findTask,
  type ServerLease,
  type ServerOperation,
  type ServerRecord,
  type ServerRepository,
  type ServerStatus,
  type ServerTask,
} from "./serverRepository.ts";
import type { VultrAdapter, VultrInstance } from "./vultr.ts";
import { VultrError } from "./vultr.ts";

export class ServerControlError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "conflict"
      | "idempotency_conflict"
      | "insufficient_balance"
      | "forbidden"
      | "deletion_blocked"
      | "provider_unavailable"
      | "provider_unknown",
    message: string = code,
  ) {
    super(message);
  }
}

export interface MutationMeta {
  idempotencyKey: string;
  requestId: string;
}

export interface ServerControlOptions {
  repository: ServerRepository;
  provider: VultrAdapter;
  authorizations: BillingAuthorizationGateway;
  worker: WorkerGateway;
  deletion: WorldBackupDeletionGateway;
  now?: () => string;
  id?: (prefix: "server" | "task" | "lease") => string;
  forcedStopTimeoutMs?: number;
  rateVersion?: number;
  bootstrapUserData?: (serverId: string) => string;
}

export type EventResult = "applied" | "duplicate" | "out_of_order" | "ignored";
export interface SweepResult {
  accountId: string;
  taskId: string;
  status: "forced" | "skipped";
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function requireText(value: string, name: string) {
  if (!value.trim() || value.length > 255) {
    throw new ServerControlError("invalid_request", `${name} is invalid`);
  }
}

function setStatus(
  server: ServerRecord,
  status: ServerStatus,
  desiredStatus: ServerRecord["desiredStatus"],
  reason: string,
  source: ServerRecord["commandSource"],
  taskId: string,
  now: string,
) {
  server.status = status;
  server.desiredStatus = desiredStatus;
  server.statusVersion += 1;
  server.statusReason = reason;
  server.commandSource = source;
  server.taskId = taskId;
  server.updatedAt = now;
}

function taskError(
  task: ServerTask,
  code: string,
  message: string,
  now: string,
) {
  task.status = "failed";
  task.error = {
    error: code,
    message,
    requestId: task.requestId,
  };
  task.updatedAt = now;
}

function eventClaim(
  state: AccountServerState,
  event: { eventId: string; sequence?: number },
  source: ConsumedEventRecord["source"],
  now: string,
): "new" | "duplicate" {
  const eventFingerprint = fingerprint(event);
  const existing = state.consumedEvents.find((item) =>
    item.eventId === event.eventId
  );
  if (existing?.fingerprint === eventFingerprint) return "duplicate";
  if (existing) {
    throw new ServerControlError(
      "conflict",
      "eventId was reused with different content",
    );
  }
  state.consumedEvents.push({
    eventId: event.eventId,
    fingerprint: eventFingerprint,
    source,
    sequence: event.sequence ?? 0,
    consumedAt: now,
  });
  return "new";
}

function activeLease(state: AccountServerState, server: ServerRecord) {
  return findLease(state, server.leaseId);
}

function closeLease(
  state: AccountServerState,
  server: ServerRecord,
  now: string,
): ServerLease | undefined {
  const lease = activeLease(state, server);
  if (lease && (lease.status === "active" || lease.status === "reserved")) {
    lease.status = "released";
    lease.endedAt = now;
  }
  server.leaseId = undefined;
  return lease;
}

export class ServerControlService {
  private readonly repository: ServerRepository;
  private readonly provider: VultrAdapter;
  private readonly authorizations: BillingAuthorizationGateway;
  private readonly worker: WorkerGateway;
  private readonly deletion: WorldBackupDeletionGateway;
  private readonly now: () => string;
  private readonly id: (prefix: "server" | "task" | "lease") => string;
  private readonly forcedStopTimeoutMs: number;
  private readonly rateVersion: number;
  private readonly bootstrapUserData: (serverId: string) => string;

  constructor(options: ServerControlOptions) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.authorizations = options.authorizations;
    this.worker = options.worker;
    this.deletion = options.deletion;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
    this.forcedStopTimeoutMs = options.forcedStopTimeoutMs ?? 300_000;
    this.rateVersion = options.rateVersion ?? 1;
    if (!Number.isSafeInteger(this.rateVersion) || this.rateVersion <= 0) {
      throw new Error("SERVER_CONTROL_RATE_VERSION is invalid");
    }
    this.bootstrapUserData = options.bootstrapUserData ??
      ((serverId) => `#cloud-config\nwrite_files: []\n# ${serverId}`);
  }

  async list(accountId: string): Promise<ServerRecord[]> {
    return (await this.repository.read(accountId)).servers;
  }

  async get(accountId: string, serverId: string): Promise<ServerRecord> {
    const server = findServer(await this.repository.read(accountId), serverId);
    if (!server) throw new ServerControlError("not_found");
    return server;
  }

  async getTask(accountId: string, taskId: string): Promise<ServerTask> {
    const task = findTask(await this.repository.read(accountId), taskId);
    if (!task) throw new ServerControlError("not_found");
    return task;
  }

  async create(
    accountId: string,
    input: { plan: string },
    meta: MutationMeta,
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    requireText(input.plan, "plan");
    const requestFingerprint = fingerprint({ operation: "create", input });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;

    const serverId = this.id("server");
    const authorization = await this.authorize(
      accountId,
      serverId,
      meta.idempotencyKey,
    );
    const now = this.now();
    return await this.repository.transact(accountId, (state) => {
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      const task = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        "create",
        serverId,
        now,
        authorization.authorizationId,
      );
      state.tasks.push(task);
      state.servers.push({
        serverId,
        accountId,
        provider: "vultr",
        region: "taipei",
        plan: input.plan,
        status: "creating",
        desiredStatus: "stopped",
        statusVersion: 1,
        statusReason: "create_requested",
        commandSource: "user",
        taskId: task.taskId,
        lastWorkerSequence: 0,
        lastM3Sequence: 0,
        lastM7Sequence: 0,
        createdAt: now,
        updatedAt: now,
      });
      return task;
    });
  }

  start(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    return this.startLike(accountId, serverId, meta, "start");
  }

  restart(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    return this.startLike(accountId, serverId, meta, "restart");
  }

  async stop(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    const requestFingerprint = fingerprint({ operation: "stop", serverId });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;
    const now = this.now();
    const deadline = new Date(
      Date.parse(now) + this.forcedStopTimeoutMs,
    ).toISOString();
    const task = await this.repository.transact(accountId, (state) => {
      const server = findServer(state, serverId);
      if (!server) throw new ServerControlError("not_found");
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      if (!["running", "starting"].includes(server.status)) {
        throw new ServerControlError("conflict", "server cannot be stopped");
      }
      const created = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        "stop",
        serverId,
        now,
      );
      created.status = "running";
      state.tasks.push(created);
      setStatus(
        server,
        "stopping",
        "stopped",
        "stop_requested",
        "user",
        created.taskId,
        now,
      );
      server.stopDeadline = deadline;
      return created;
    });
    await this.requestGracefulStop(task, deadline);
    return task;
  }

  async archive(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    const requestFingerprint = fingerprint({ operation: "archive", serverId });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;
    const now = this.now();
    return await this.repository.transact(accountId, (state) => {
      const server = findServer(state, serverId);
      if (!server) throw new ServerControlError("not_found");
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      if (server.status !== "stopped" || !server.providerResourceId) {
        throw new ServerControlError(
          "conflict",
          "server must be stopped before it can be archived",
        );
      }
      const task = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        "archive",
        serverId,
        now,
      );
      state.tasks.push(task);
      setStatus(
        server,
        "archiving",
        "archived",
        "archive_requested",
        "user",
        task.taskId,
        now,
      );
      return task;
    });
  }

  async restore(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    const requestFingerprint = fingerprint({ operation: "restore", serverId });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;
    const server = await this.get(accountId, serverId);
    if (server.status !== "archived" || !server.snapshotId) {
      throw new ServerControlError(
        "conflict",
        "server must be archived before it can be restored",
      );
    }
    const authorization = await this.authorize(
      accountId,
      serverId,
      meta.idempotencyKey,
    );
    const now = this.now();
    return await this.repository.transact(accountId, (state) => {
      const current = findServer(state, serverId);
      if (!current) throw new ServerControlError("not_found");
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      if (current.status !== "archived" || !current.snapshotId) {
        throw new ServerControlError("conflict");
      }
      const task = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        "restore",
        serverId,
        now,
        authorization.authorizationId,
      );
      state.tasks.push(task);
      state.leases.push({
        leaseId: this.id("lease"),
        serverId,
        accountId,
        authorizationId: authorization.authorizationId,
        startedAt: now,
        status: "reserved",
      });
      const lease = state.leases.at(-1)!;
      current.leaseId = lease.leaseId;
      current.address = undefined;
      setStatus(
        current,
        "restoring",
        "running",
        "restore_requested",
        "user",
        task.taskId,
        now,
      );
      return task;
    });
  }

  async delete(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    const requestFingerprint = fingerprint({ operation: "delete", serverId });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;
    await this.get(accountId, serverId);
    if (
      await this.deletion.confirmServerDeletion({
        accountId,
        serverId,
        idempotencyKey: meta.idempotencyKey,
      }) !== "confirmed"
    ) {
      throw new ServerControlError("deletion_blocked");
    }
    const now = this.now();
    const released: ServerLease[] = [];
    const task = await this.repository.transact(accountId, (state) => {
      const server = findServer(state, serverId);
      if (!server) throw new ServerControlError("not_found");
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      if (["deleting", "deleted"].includes(server.status)) {
        throw new ServerControlError("conflict", "server is already deleting");
      }
      const created = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        "delete",
        serverId,
        now,
      );
      state.tasks.push(created);
      const lease = closeLease(state, server, now);
      if (lease) released.push(lease);
      setStatus(
        server,
        "deleting",
        "deleted",
        "delete_requested",
        "user",
        created.taskId,
        now,
      );
      return created;
    });
    await this.releaseLeases(released, task.taskId);
    return task;
  }

  async executeTask(accountId: string, taskId: string): Promise<ServerTask> {
    const execution = await this.repository.transact(accountId, (state) => {
      const value = findTask(state, taskId);
      if (!value) throw new ServerControlError("not_found");
      if (value.status === "queued") {
        value.status = "running";
        value.updatedAt = this.now();
        return { task: value, shouldExecute: true };
      }
      return { task: value, shouldExecute: false };
    });
    const task = execution.task;
    if (task.status !== "running") return task;
    if (!execution.shouldExecute) {
      return await this.reconcileTask(accountId, taskId);
    }

    try {
      if (task.operation === "create") await this.executeCreate(task);
      else if (task.operation === "start") await this.executeStart(task, false);
      else if (task.operation === "restart") {
        await this.executeStart(task, true);
      } else if (task.operation === "delete") await this.executeDelete(task);
      else if (task.operation === "archive") await this.executeArchive(task);
      else if (task.operation === "restore") await this.executeRestore(task);
    } catch (error) {
      await this.handleProviderFailure(task, error);
    }
    return await this.getTask(accountId, taskId);
  }

  async reconcileTask(accountId: string, taskId: string): Promise<ServerTask> {
    const task = await this.getTask(accountId, taskId);
    if (task.status !== "running") return task;
    const server = await this.get(accountId, task.resource.id);
    let providerResourceId = server.providerResourceId;
    if (!providerResourceId && task.operation === "create") {
      const found = await this.provider.reconcileCreate(server.serverId);
      if (found) {
        providerResourceId = found.id;
        await this.repository.transact(accountId, (state) => {
          const current = findServer(state, server.serverId);
          if (current && !current.providerResourceId) {
            current.providerResourceId = found.id;
            current.updatedAt = this.now();
          }
        });
      }
    }
    if (!providerResourceId) return task;
    let provider = await this.provider.getInstance(providerResourceId);
    if (
      task.operation === "create" && provider?.status === "active" &&
      provider.powerStatus !== "stopped"
    ) {
      await this.provider.halt(providerResourceId);
      provider = await this.provider.getInstance(providerResourceId);
    }
    const now = this.now();
    await this.repository.transact(accountId, (state) => {
      const currentTask = findTask(state, taskId);
      const currentServer = findServer(state, server.serverId);
      if (!currentTask || !currentServer || currentTask.status !== "running") {
        return;
      }
      if (task.operation === "delete" && !provider) {
        setStatus(
          currentServer,
          "deleted",
          "deleted",
          "provider_delete_confirmed",
          "reconciler",
          taskId,
          now,
        );
        currentTask.status = "succeeded";
        currentTask.result = { serverId: server.serverId };
        currentTask.error = undefined;
        currentTask.updatedAt = now;
      } else if (
        task.operation === "create" && provider &&
        provider.status === "active" && provider.powerStatus === "stopped"
      ) {
        setStatus(
          currentServer,
          "stopped",
          "stopped",
          "provider_ready",
          "reconciler",
          taskId,
          now,
        );
        currentTask.status = "succeeded";
        currentTask.result = { serverId: server.serverId };
        currentTask.error = undefined;
        currentTask.updatedAt = now;
      } else if (provider) {
        currentServer.statusReason = "provider_reconciled_waiting_worker";
        currentServer.updatedAt = now;
        currentTask.error = undefined;
      }
    });
    const reconciled = await this.getTask(accountId, taskId);
    if (
      reconciled.status === "succeeded" &&
      reconciled.operation === "create" &&
      reconciled.authorizationId
    ) {
      await this.authorizations.release(
        reconciled.authorizationId,
        `m4-release:${reconciled.taskId}`,
      );
    }
    return reconciled;
  }

  async handleWorkerEvent(
    event: ServerControlWorkerEvent,
  ): Promise<EventResult> {
    this.validateEvent(event);
    const before = await this.get(event.accountId, event.serverId);
    let observed: VultrInstance | undefined;
    if (event.type === "worker.healthy") {
      if (!before.providerResourceId) return "ignored";
      observed = await this.provider.getInstance(before.providerResourceId);
      if (!observed?.address) return "ignored";
    } else if (before.providerResourceId) {
      await this.provider.halt(before.providerResourceId);
    }
    const now = this.now();
    const released: ServerLease[] = [];
    const result = await this.repository.transact(event.accountId, (state) => {
      if (eventClaim(state, event, "worker", now) === "duplicate") {
        return "duplicate" as const;
      }
      const server = findServer(state, event.serverId);
      if (!server) throw new ServerControlError("not_found");
      if (event.sequence <= server.lastWorkerSequence) {
        return "out_of_order" as const;
      }
      server.lastWorkerSequence = event.sequence;
      if (
        event.type === "worker.healthy" &&
        ["starting", "restoring"].includes(server.status) &&
        server.desiredStatus === "running"
      ) {
        const lease = activeLease(state, server);
        if (!lease || lease.status !== "reserved") {
          throw new ServerControlError("conflict", "reserved lease is missing");
        }
        lease.status = "active";
        lease.startedAt = event.observedAt;
        server.address = observed?.address;
        setStatus(
          server,
          "running",
          "running",
          "worker_healthy",
          "worker",
          server.taskId,
          now,
        );
        this.succeedCurrentTask(state, server, now);
        return "applied" as const;
      }
      if (
        event.type === "worker.stopped" &&
        ["stopping", "suspended", "billing_blocked", "deleting"].includes(
          server.status,
        )
      ) {
        const lease = closeLease(state, server, event.observedAt);
        if (lease) released.push(lease);
        server.address = undefined;
        server.stopDeadline = undefined;
        if (server.status === "stopping") {
          setStatus(
            server,
            "stopped",
            "stopped",
            "worker_stopped",
            "worker",
            server.taskId,
            now,
          );
        } else {
          server.statusVersion += 1;
          server.statusReason = "worker_stopped";
          server.commandSource = "worker";
          server.updatedAt = now;
        }
        this.succeedCurrentTask(state, server, now);
        return "applied" as const;
      }
      return "ignored" as const;
    });
    await this.releaseLeases(released, event.eventId);
    return result;
  }

  async forceStopAfterTimeout(
    accountId: string,
    taskId: string,
    at = this.now(),
  ): Promise<ServerTask> {
    const task = await this.getTask(accountId, taskId);
    const server = await this.get(accountId, task.resource.id);
    if (
      !server.stopDeadline || Date.parse(at) < Date.parse(server.stopDeadline)
    ) {
      throw new ServerControlError(
        "conflict",
        "forced-stop deadline not reached",
      );
    }
    if (server.providerResourceId) {
      await this.provider.halt(server.providerResourceId);
    }
    const released: ServerLease[] = [];
    await this.repository.transact(accountId, (state) => {
      const current = findServer(state, server.serverId);
      const currentTask = findTask(state, taskId);
      if (!current || !currentTask) throw new ServerControlError("not_found");
      if (
        !["stopping", "suspended", "billing_blocked"].includes(current.status)
      ) {
        return;
      }
      const lease = closeLease(state, current, at);
      if (lease) released.push(lease);
      if (current.status === "stopping") {
        setStatus(
          current,
          "stopped",
          "stopped",
          "worker_unresponsive",
          "reconciler",
          taskId,
          at,
        );
      } else {
        current.statusVersion += 1;
        current.statusReason = "worker_unresponsive";
        current.commandSource = "reconciler";
        current.updatedAt = at;
      }
      current.address = undefined;
      current.stopDeadline = undefined;
      currentTask.status = "succeeded";
      currentTask.result = { serverId: current.serverId };
      currentTask.updatedAt = at;
    });
    await this.releaseLeases(released, taskId);
    return await this.getTask(accountId, taskId);
  }

  /** Runs deterministic, account/task-sorted D5 stop escalations from a durable scanner. */
  async sweepExpiredStops(
    candidates: readonly { accountId: string; taskId: string }[],
    at = this.now(),
  ): Promise<SweepResult[]> {
    const unique = new Map<string, { accountId: string; taskId: string }>();
    for (const candidate of candidates) {
      requireText(candidate.accountId, "accountId");
      requireText(candidate.taskId, "taskId");
      unique.set(`${candidate.accountId}\u0000${candidate.taskId}`, candidate);
    }
    const results: SweepResult[] = [];
    for (
      const candidate of [...unique.values()].sort((left, right) =>
        left.accountId.localeCompare(right.accountId) ||
        left.taskId.localeCompare(right.taskId)
      )
    ) {
      try {
        await this.forceStopAfterTimeout(
          candidate.accountId,
          candidate.taskId,
          at,
        );
        results.push({ ...candidate, status: "forced" });
      } catch (error) {
        if (
          error instanceof ServerControlError &&
          (error.code === "conflict" || error.code === "not_found")
        ) {
          results.push({ ...candidate, status: "skipped" });
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  /**
   * Starts D5's 300-second escalation window from the trusted Billing-to-Worker
   * settlement observation. Worker's published runtime.stopped.v1 then completes
   * the stop through handleRuntimeStopped.
   */
  async recordBalanceStopRequired(
    accountId: string,
    observation: WorkerBalanceStopRequired,
  ): Promise<EventResult> {
    requireText(accountId, "accountId");
    requireText(observation.serverId, "serverId");
    requireText(observation.leaseId, "leaseId");
    requireText(observation.settlementId, "settlementId");
    if (!Number.isFinite(Date.parse(observation.occurredAt))) {
      throw new ServerControlError("invalid_request", "settlement is invalid");
    }
    const now = this.now();
    const deadline = new Date(
      Date.parse(observation.occurredAt) + this.forcedStopTimeoutMs,
    ).toISOString();
    let stopTask: ServerTask | undefined;
    const result = await this.repository.transact(accountId, (state) => {
      const eventId = `settlement:${observation.settlementId}`;
      const existing = state.consumedEvents.find((item) =>
        item.eventId === eventId
      );
      const eventFingerprint = fingerprint(observation);
      if (existing?.fingerprint === eventFingerprint) {
        return "duplicate" as const;
      }
      if (existing) {
        throw new ServerControlError(
          "conflict",
          "settlementId was reused with different content",
        );
      }
      state.consumedEvents.push({
        eventId,
        fingerprint: eventFingerprint,
        source: "m5",
        sequence: 0,
        consumedAt: now,
      });
      const server = findServer(state, observation.serverId);
      if (!server) throw new ServerControlError("not_found");
      if (server.leaseId !== observation.leaseId) {
        throw new ServerControlError(
          "conflict",
          "settlement lease does not match",
        );
      }
      if (server.status !== "running") return "ignored" as const;
      const task = this.newTask(
        accountId,
        this.id("task"),
        observation.settlementId,
        "forced_stop",
        server.serverId,
        now,
      );
      task.status = "running";
      state.tasks.push(task);
      stopTask = task;
      setStatus(
        server,
        "billing_blocked",
        "stopped",
        "balance_exhausted",
        "m3",
        task.taskId,
        now,
      );
      server.stopDeadline = deadline;
      return "applied" as const;
    });
    if (stopTask) await this.requestGracefulStop(stopTask, deadline);
    return result;
  }

  /** Consumes the exact shared `runtime.stopped.v1` balance-exhaustion event. */
  async handleRuntimeStopped(
    accountId: string,
    event: WorkerRuntimeStoppedEvent,
  ): Promise<EventResult> {
    requireText(accountId, "accountId");
    requireText(event.eventId, "eventId");
    requireText(event.serverId, "serverId");
    requireText(event.leaseId, "leaseId");
    requireText(event.settlementId, "settlementId");
    if (
      event.eventType !== "runtime.stopped.v1" || event.schemaVersion !== 1 ||
      event.reason !== "balance_exhausted" ||
      !Number.isFinite(Date.parse(event.occurredAt))
    ) {
      throw new ServerControlError(
        "invalid_request",
        "runtime stop is invalid",
      );
    }
    const now = this.now();
    const released: ServerLease[] = [];
    let providerResourceId: string | undefined;
    const result = await this.repository.transact(accountId, (state) => {
      if (
        eventClaim(
          state,
          { eventId: event.eventId, sequence: 0 },
          "m5",
          now,
        ) === "duplicate"
      ) {
        return "duplicate" as const;
      }
      const server = findServer(state, event.serverId);
      if (!server) throw new ServerControlError("not_found");
      if (server.leaseId !== event.leaseId) {
        throw new ServerControlError(
          "conflict",
          "runtime stop lease does not match",
        );
      }
      if (server.status !== "billing_blocked") return "ignored" as const;
      const lease = closeLease(state, server, event.occurredAt);
      if (lease) released.push(lease);
      providerResourceId = server.providerResourceId;
      server.address = undefined;
      server.stopDeadline = undefined;
      setStatus(
        server,
        "stopped",
        "stopped",
        "balance_exhausted",
        "m5",
        server.taskId,
        now,
      );
      this.succeedCurrentTask(state, server, now);
      return "applied" as const;
    });
    if (result === "applied" && providerResourceId) {
      await this.provider.halt(providerResourceId);
    }
    await this.releaseLeases(released, event.eventId);
    return result;
  }

  /** Consumes D6's exact request and persists one ServerControl completion per operation. */
  async handleAdminOperation(
    accountId: string,
    event: AdminOperationRequested,
  ): Promise<AdminOperationCompleted> {
    requireText(accountId, "accountId");
    requireText(event.eventId, "eventId");
    requireText(event.operationId, "operationId");
    requireText(event.requestedBy, "requestedBy");
    requireText(event.reason, "reason");
    if (
      event.eventType !== "admin.operation.requested.v1" ||
      event.schemaVersion !== 1 ||
      !["server_suspend", "server_restore"].includes(event.action) ||
      event.target.resourceType !== "server" ||
      !Number.isFinite(Date.parse(event.occurredAt))
    ) {
      throw new ServerControlError(
        "invalid_request",
        "admin operation is invalid",
      );
    }
    const existing = (await this.repository.read(accountId))
      .adminOperationCompletions
      .find((item) => item.operationId === event.operationId);
    if (existing) return existing.completion;

    const result = await this.handleControlEvent({
      eventId: event.eventId,
      schemaVersion: event.schemaVersion,
      accountId,
      serverId: event.target.resourceId,
      sequence: Date.parse(event.occurredAt),
      source: "m7",
      action: event.action === "server_suspend" ? "suspend" : "restore",
      reason: event.reason,
      occurredAt: event.occurredAt,
    });
    const now = this.now();
    const completion: AdminOperationCompleted = {
      eventType: "admin.operation.completed.v1",
      eventId: `admin-completed:${event.operationId}`,
      schemaVersion: 1,
      operationId: event.operationId,
      owner: "m4",
      status: result === "ignored" ? "rejected" : "succeeded",
      ...(result === "ignored"
        ? { error: { error: "server_state_conflict" } }
        : { result: { serverId: event.target.resourceId } }),
      completedAt: now,
    };
    return await this.repository.transact(accountId, (state) => {
      const saved = state.adminOperationCompletions.find((item) =>
        item.operationId === event.operationId
      );
      if (saved) return saved.completion;
      state.adminOperationCompletions.push({
        operationId: event.operationId,
        requestEventId: event.eventId,
        completion,
      });
      return completion;
    });
  }

  async handleControlEvent(
    event: ServerControlEvent,
  ): Promise<EventResult> {
    this.validateEvent(event);
    if (
      event.source !== "m7" || !["suspend", "restore"].includes(event.action)
    ) {
      throw new ServerControlError("invalid_request", "invalid event action");
    }
    const now = this.now();
    const deadline = new Date(
      Date.parse(now) + this.forcedStopTimeoutMs,
    ).toISOString();
    let stopTask: ServerTask | undefined;
    const result = await this.repository.transact(event.accountId, (state) => {
      if (eventClaim(state, event, event.source, now) === "duplicate") {
        return "duplicate" as const;
      }
      const server = findServer(state, event.serverId);
      if (!server) throw new ServerControlError("not_found");
      if (event.sequence <= server.lastM7Sequence) {
        return "out_of_order" as const;
      }
      server.lastM7Sequence = event.sequence;

      if (event.action === "restore") {
        if (!["suspended", "billing_blocked"].includes(server.status)) {
          return "ignored" as const;
        }
        const lease = activeLease(state, server);
        if (
          server.stopDeadline ||
          lease?.status === "active" ||
          lease?.status === "reserved"
        ) {
          return "ignored" as const;
        }
        setStatus(
          server,
          "stopped",
          "stopped",
          event.reason,
          "m7",
          event.eventId,
          now,
        );
        server.stopDeadline = undefined;
        return "applied" as const;
      }
      if (["deleted", "deleting", "stopped"].includes(server.status)) {
        return "ignored" as const;
      }
      const task = this.newTask(
        event.accountId,
        this.id("task"),
        event.eventId,
        "forced_stop",
        server.serverId,
        now,
      );
      task.status = "running";
      state.tasks.push(task);
      stopTask = task;
      setStatus(
        server,
        "suspended",
        "stopped",
        event.reason,
        event.source,
        task.taskId,
        now,
      );
      server.stopDeadline = deadline;
      return "applied" as const;
    });
    if (stopTask) await this.requestGracefulStop(stopTask, deadline);
    return result;
  }

  private async startLike(
    accountId: string,
    serverId: string,
    meta: MutationMeta,
    operation: "start" | "restart",
  ): Promise<ServerTask> {
    this.validateMeta(accountId, meta);
    const requestFingerprint = fingerprint({ operation, serverId });
    const replay = await this.replay(accountId, meta, requestFingerprint);
    if (replay) return replay;
    const existing = await this.get(accountId, serverId);
    const allowed = operation === "start"
      ? existing.status === "stopped"
      : existing.status === "running";
    if (!allowed) {
      throw new ServerControlError("conflict", `server cannot ${operation}`);
    }
    const leaseId = this.id("lease");
    const authorization = await this.authorize(
      accountId,
      leaseId,
      meta.idempotencyKey,
    );
    const now = this.now();
    const released: ServerLease[] = [];
    const task = await this.repository.transact(accountId, (state) => {
      const server = findServer(state, serverId);
      if (!server) throw new ServerControlError("not_found");
      const claimed = this.claim(
        state,
        meta,
        requestFingerprint,
        this.id("task"),
        now,
      );
      if (claimed.replay) return claimed.replay;
      const valid = operation === "start"
        ? server.status === "stopped"
        : server.status === "running";
      if (!valid) throw new ServerControlError("conflict");
      if (operation === "restart") {
        const lease = closeLease(state, server, now);
        if (lease) released.push(lease);
      }
      const created = this.newTask(
        accountId,
        claimed.taskId,
        meta.requestId,
        operation,
        serverId,
        now,
        authorization.authorizationId,
      );
      const lease: ServerLease = {
        leaseId,
        serverId,
        accountId,
        authorizationId: authorization.authorizationId,
        startedAt: now,
        status: "reserved",
      };
      state.tasks.push(created);
      state.leases.push(lease);
      server.leaseId = lease.leaseId;
      server.address = undefined;
      setStatus(
        server,
        "starting",
        "running",
        `${operation}_requested`,
        "user",
        created.taskId,
        now,
      );
      return created;
    });
    await this.releaseLeases(released, task.taskId);
    return task;
  }

  private async executeCreate(task: ServerTask) {
    const server = await this.get(task.accountId, task.resource.id);
    const created = await this.provider.createInstance({
      serverId: server.serverId,
      plan: server.plan,
      userData: this.bootstrapUserData(server.serverId),
    });
    await this.repository.transact(task.accountId, (state) => {
      const current = findServer(state, server.serverId);
      if (current && !current.providerResourceId) {
        current.providerResourceId = created.id;
        current.updatedAt = this.now();
      }
    });
    if (created.status === "active" && created.powerStatus !== "stopped") {
      await this.provider.halt(created.id);
    }
    await this.reconcileTask(task.accountId, task.taskId);
  }

  async executeStart(task: ServerTask, restart: boolean) {
    const server = await this.get(task.accountId, task.resource.id);
    if (!server.providerResourceId) {
      throw new ServerControlError("conflict", "provider instance is missing");
    }
    if (restart) await this.provider.reboot(server.providerResourceId);
    else await this.provider.start(server.providerResourceId);
    await this.reconcileTask(task.accountId, task.taskId);
  }

  private async executeDelete(task: ServerTask) {
    const server = await this.get(task.accountId, task.resource.id);
    if (server.providerResourceId) {
      await this.provider.delete(server.providerResourceId);
      await this.reconcileTask(task.accountId, task.taskId);
      return;
    }
    const now = this.now();
    await this.repository.transact(task.accountId, (state) => {
      const current = findServer(state, server.serverId);
      const currentTask = findTask(state, task.taskId);
      if (!current || !currentTask) return;
      setStatus(
        current,
        "deleted",
        "deleted",
        "no_provider_resource",
        "reconciler",
        task.taskId,
        now,
      );
      currentTask.status = "succeeded";
      currentTask.result = { serverId: server.serverId };
      currentTask.updatedAt = now;
    });
  }

  private async executeArchive(task: ServerTask) {
    const server = await this.get(task.accountId, task.resource.id);
    if (!server.providerResourceId) {
      throw new ServerControlError("conflict", "provider instance is missing");
    }
    const snapshot = await this.provider.createSnapshot(
      server.providerResourceId,
      `xmcl:${server.serverId}:${task.taskId}`,
    );
    await this.provider.delete(server.providerResourceId);
    const now = this.now();
    await this.repository.transact(task.accountId, (state) => {
      const current = findServer(state, server.serverId);
      const currentTask = findTask(state, task.taskId);
      if (!current || !currentTask || currentTask.status !== "running") return;
      current.providerResourceId = undefined;
      current.snapshotId = snapshot.snapshotId;
      current.archivedAt = now;
      current.address = undefined;
      setStatus(
        current,
        "archived",
        "archived",
        "provider_snapshot_archived",
        "reconciler",
        task.taskId,
        now,
      );
      currentTask.status = "succeeded";
      currentTask.result = { serverId: current.serverId };
      currentTask.updatedAt = now;
    });
  }

  private async executeRestore(task: ServerTask) {
    const server = await this.get(task.accountId, task.resource.id);
    if (!server.snapshotId) {
      throw new ServerControlError("conflict", "server snapshot is missing");
    }
    const instance = await this.provider.createInstance({
      serverId: server.serverId,
      plan: server.plan,
      userData: this.bootstrapUserData(server.serverId),
      snapshotId: server.snapshotId,
    });
    await this.repository.transact(task.accountId, (state) => {
      const current = findServer(state, server.serverId);
      if (current && current.status === "restoring") {
        current.providerResourceId = instance.id;
        current.updatedAt = this.now();
      }
    });
  }

  private async handleProviderFailure(task: ServerTask, error: unknown) {
    const now = this.now();
    const unknown = error instanceof VultrError && error.outcome === "unknown";
    if (unknown) {
      await this.repository.transact(task.accountId, (state) => {
        const server = findServer(state, task.resource.id);
        const currentTask = findTask(state, task.taskId);
        if (server) {
          server.statusReason = "provider_reconciliation_required";
          server.updatedAt = now;
        }
        if (currentTask) {
          currentTask.error = {
            error: "provider_unknown",
            message:
              "Cloud provider outcome is unknown; reconciliation pending",
            requestId: currentTask.requestId,
          };
          currentTask.updatedAt = now;
        }
      });
      return;
    }
    const released: ServerLease[] = [];
    await this.repository.transact(task.accountId, (state) => {
      const currentTask = findTask(state, task.taskId);
      const server = findServer(state, task.resource.id);
      if (!currentTask || !server) return;
      taskError(
        currentTask,
        "provider_unavailable",
        "Cloud provider rejected the operation",
        now,
      );
      if (task.operation === "create") {
        setStatus(
          server,
          "failed",
          "stopped",
          "provider_create_failed",
          "reconciler",
          task.taskId,
          now,
        );
      } else if (
        task.operation === "start" || task.operation === "restart" ||
        task.operation === "restore"
      ) {
        setStatus(
          server,
          task.operation === "restore" ? "archived" : "stopped",
          task.operation === "restore" ? "archived" : "stopped",
          task.operation === "restore"
            ? "provider_restore_failed"
            : "provider_start_failed",
          "reconciler",
          task.taskId,
          now,
        );
        const lease = closeLease(state, server, now);
        if (lease) released.push(lease);
      }
    });
    if (task.operation === "create" && task.authorizationId) {
      await this.authorizations.release(
        task.authorizationId,
        `m4-release:${task.taskId}`,
      );
    }
    await this.releaseLeases(released, task.taskId);
  }

  private async authorize(
    accountId: string,
    serverId: string,
    idempotencyKey: string,
  ) {
    const now = Date.parse(this.now());
    const result = await this.authorizations.authorize({
      accountId,
      resource: "server_time",
      sourceId: serverId,
      expectedQuantity: 1,
      unit: "hour",
      settlementIntervalSeconds: 3600,
      rateVersion: this.rateVersion,
      idempotencyKey: `m4:${idempotencyKey}`,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    });
    if (result.status !== "authorized") {
      throw new ServerControlError(result.reason ?? "insufficient_balance");
    }
    return result;
  }

  private async replay(
    accountId: string,
    meta: MutationMeta,
    requestFingerprint: string,
  ): Promise<ServerTask | undefined> {
    const state = await this.repository.read(accountId);
    const existing = state.idempotency.find((item) =>
      item.key === meta.idempotencyKey
    );
    if (!existing) return undefined;
    if (existing.fingerprint !== requestFingerprint) {
      throw new ServerControlError("idempotency_conflict");
    }
    const task = findTask(state, existing.taskId);
    if (!task) throw new ServerControlError("conflict");
    return task;
  }

  private claim(
    state: AccountServerState,
    meta: MutationMeta,
    requestFingerprint: string,
    taskId: string,
    now: string,
  ): { taskId: string; replay?: ServerTask } {
    const existing = state.idempotency.find((item) =>
      item.key === meta.idempotencyKey
    );
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new ServerControlError("idempotency_conflict");
      }
      const task = findTask(state, existing.taskId);
      if (!task) throw new ServerControlError("conflict");
      return { taskId: existing.taskId, replay: task };
    }
    state.idempotency.push({
      key: meta.idempotencyKey,
      fingerprint: requestFingerprint,
      taskId,
      createdAt: now,
    });
    return { taskId };
  }

  private newTask(
    accountId: string,
    taskId: string,
    requestId: string,
    operation: ServerOperation,
    serverId: string,
    now: string,
    authorizationId?: string,
  ): ServerTask {
    return {
      taskId,
      requestId,
      accountId,
      status: "queued",
      operation,
      resource: { type: "server", id: serverId },
      authorizationId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private validateMeta(accountId: string, meta: MutationMeta) {
    requireText(accountId, "accountId");
    requireText(meta.idempotencyKey, "Idempotency-Key");
    requireText(meta.requestId, "requestId");
  }

  private validateEvent(
    event: ServerControlWorkerEvent | ServerControlEvent,
  ) {
    requireText(event.eventId, "eventId");
    requireText(event.accountId, "accountId");
    requireText(event.serverId, "serverId");
    if (
      event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) ||
      event.sequence <= 0 || !Number.isFinite(Date.parse(
        "observedAt" in event ? event.observedAt : event.occurredAt,
      ))
    ) {
      throw new ServerControlError("invalid_request", "event is invalid");
    }
  }

  private succeedCurrentTask(
    state: AccountServerState,
    server: ServerRecord,
    now: string,
  ) {
    const task = findTask(state, server.taskId);
    if (task && task.status === "running") {
      task.status = "succeeded";
      task.result = { serverId: server.serverId };
      task.updatedAt = now;
    }
  }

  private async requestGracefulStop(task: ServerTask, deadline: string) {
    await this.worker.requestGracefulStop({
      serverId: task.resource.id,
      taskId: task.taskId,
      deadline,
    }).catch(() => "unreachable" as const);
  }

  private async releaseLeases(leases: ServerLease[], reasonId: string) {
    await Promise.allSettled(leases.map((lease) =>
      this.authorizations.release(
        lease.authorizationId,
        `m4-release:${reasonId}:${lease.leaseId}`,
      )
    ));
  }
}
