import type { Db } from "../db.ts";
import type { AdminOperationCompleted } from "./serverControlProposals.ts";

export type ServerStatus =
  | "creating"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "archiving"
  | "archived"
  | "restoring"
  | "suspended"
  | "billing_blocked"
  | "failed"
  | "deleting"
  | "deleted";

export type DesiredServerStatus =
  | "running"
  | "stopped"
  | "archived"
  | "deleted";
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type ServerOperation =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "archive"
  | "restore"
  | "delete"
  | "forced_stop";
export type LeaseStatus = "reserved" | "active" | "settled" | "released";

export interface ServerRecord {
  serverId: string;
  accountId: string;
  provider: "vultr";
  region: "taipei";
  plan: string;
  status: ServerStatus;
  desiredStatus: DesiredServerStatus;
  statusVersion: number;
  statusReason?: string;
  commandSource: "user" | "worker" | "m3" | "m5" | "m7" | "reconciler";
  taskId: string;
  providerResourceId?: string;
  snapshotId?: string;
  archivedAt?: string;
  address?: string;
  leaseId?: string;
  stopDeadline?: string;
  lastWorkerSequence: number;
  lastM3Sequence: number;
  lastM7Sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  requestId: string;
  details?: unknown;
}

export interface ServerTask {
  taskId: string;
  requestId: string;
  accountId: string;
  status: TaskStatus;
  operation: ServerOperation;
  resource: { type: "server"; id: string };
  authorizationId?: string;
  result?: { serverId: string };
  error?: ApiError;
  createdAt: string;
  updatedAt: string;
}

export interface ServerLease {
  leaseId: string;
  serverId: string;
  accountId: string;
  authorizationId: string;
  startedAt: string;
  endedAt?: string;
  status: LeaseStatus;
}

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  taskId: string;
  createdAt: string;
}

export interface ConsumedEventRecord {
  eventId: string;
  fingerprint: string;
  source: "worker" | "m3" | "m5" | "m7";
  sequence: number;
  consumedAt: string;
}

export interface AdminOperationCompletionRecord {
  operationId: string;
  requestEventId: string;
  completion: AdminOperationCompleted;
}

export interface AccountServerState {
  accountId: string;
  revision: number;
  servers: ServerRecord[];
  tasks: ServerTask[];
  leases: ServerLease[];
  idempotency: IdempotencyRecord[];
  consumedEvents: ConsumedEventRecord[];
  adminOperationCompletions: AdminOperationCompletionRecord[];
}

export interface ServerRepository {
  read(accountId: string): Promise<AccountServerState>;
  transact<T>(
    accountId: string,
    mutation: (state: AccountServerState) => T,
  ): Promise<T>;
}

function emptyState(accountId: string): AccountServerState {
  return {
    accountId,
    revision: 0,
    servers: [],
    tasks: [],
    leases: [],
    idempotency: [],
    consumedEvents: [],
    adminOperationCompletions: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryServerRepository implements ServerRepository {
  private readonly accounts = new Map<string, AccountServerState>();

  read(accountId: string): Promise<AccountServerState> {
    return Promise.resolve(
      clone(this.accounts.get(accountId) ?? emptyState(accountId)),
    );
  }

  transact<T>(
    accountId: string,
    mutation: (state: AccountServerState) => T,
  ): Promise<T> {
    const state = clone(this.accounts.get(accountId) ?? emptyState(accountId));
    const result = mutation(state);
    state.revision += 1;
    this.accounts.set(accountId, state);
    return Promise.resolve(clone(result));
  }
}

interface StoredAccountServerState extends AccountServerState {
  _id: string;
  recentMutationIds: string[];
}

function persistedState(
  accountId: string,
  value?: StoredAccountServerState | null,
): StoredAccountServerState {
  if (value) return value;
  return {
    _id: `m4:${accountId}`,
    ...emptyState(accountId),
    recentMutationIds: [],
  };
}

/**
 * Stores one ServerControl aggregate per account. Every update is a revision-checked CAS,
 * so server, task, lease, event-deduplication and idempotency state move
 * atomically without relying on isolate-local locks.
 */
export class MongoServerRepository implements ServerRepository {
  constructor(
    private readonly db: Db,
    private readonly maxAttempts = 8,
  ) {}

  async read(accountId: string): Promise<AccountServerState> {
    const found = await this.collection().findOne({ _id: `m4:${accountId}` }) as
      | StoredAccountServerState
      | null;
    const { _id: _, recentMutationIds: __, ...state } = persistedState(
      accountId,
      found,
    );
    return clone(state);
  }

  async transact<T>(
    accountId: string,
    mutation: (state: AccountServerState) => T,
  ): Promise<T> {
    const collection = this.collection();
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const current = await collection.findOne({ _id: `m4:${accountId}` }) as
        | StoredAccountServerState
        | null;
      const stored = persistedState(accountId, current);
      const draft = clone(stored);
      const result = mutation(draft);
      const mutationId = crypto.randomUUID();
      draft.revision = stored.revision + 1;
      draft.recentMutationIds = [
        ...stored.recentMutationIds.slice(-63),
        mutationId,
      ];

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
        | StoredAccountServerState
        | null;
      if (verified?.recentMutationIds.includes(mutationId)) {
        return clone(result);
      }
    }
    throw new Error("m4_repository_conflict");
  }

  private collection() {
    return this.db.collection("m4_server_control");
  }
}

export function findServer(
  state: AccountServerState,
  serverId: string,
): ServerRecord | undefined {
  return state.servers.find((server) => server.serverId === serverId);
}

export function findTask(
  state: AccountServerState,
  taskId: string,
): ServerTask | undefined {
  return state.tasks.find((task) => task.taskId === taskId);
}

export function findLease(
  state: AccountServerState,
  leaseId: string | undefined,
): ServerLease | undefined {
  return leaseId
    ? state.leases.find((lease) => lease.leaseId === leaseId)
    : undefined;
}
