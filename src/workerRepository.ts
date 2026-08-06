import type {
  WorkerAuthRepository,
  WorkerSessionRecord,
} from "./workerAuth.ts";

export type WorkerStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface WorkerAuditInput {
  scope: string;
  eventId: string;
  idempotencyKey?: string;
  fingerprint: string;
  sequence?: number;
  occurredAt?: string;
  intervalStart?: string;
  intervalEnd?: string;
  nextStatus?: WorkerStatus;
}

export type WorkerAuditClaim =
  | { status: "claimed" }
  | { status: "duplicate"; result?: unknown }
  | { status: "conflict" | "out_of_order" | "status_conflict" };

export interface WorkerRepository extends WorkerAuthRepository {
  replaceSession(session: WorkerSessionRecord): Promise<void>;
  invalidateLease(serverId: string, leaseId: string, at: string): Promise<void>;
  claimAudit(input: WorkerAuditInput): Promise<WorkerAuditClaim>;
  completeAudit(input: WorkerAuditInput, result?: unknown): Promise<void>;
  releaseAudit(input: WorkerAuditInput): Promise<void>;
  markStopRequired(input: {
    serverId: string;
    leaseId: string;
    settlementId: string;
  }): Promise<void>;
  getStopRequired(
    serverId: string,
    leaseId: string,
  ): Promise<string | undefined>;
}

interface AuditRecord {
  input: WorkerAuditInput;
  status: "pending" | "completed";
  result?: unknown;
}

const transitions: Record<WorkerStatus, readonly WorkerStatus[]> = {
  starting: ["starting", "running", "stopping", "failed"],
  running: ["running", "stopping", "stopped", "failed"],
  stopping: ["stopping", "stopped", "failed"],
  stopped: ["stopped"],
  failed: ["failed"],
};

/**
 * Deterministic adapter for route tests and local fixtures. Production platforms
 * must implement WorkerRepository with durable atomic writes.
 */
export class MemoryWorkerRepository implements WorkerRepository {
  private readonly sessions = new Map<string, WorkerSessionRecord>();
  private readonly nonces = new Set<string>();
  private readonly audits = new Map<string, AuditRecord>();
  private readonly idempotencyKeys = new Map<string, string>();
  private readonly cursors = new Map<
    string,
    {
      sequence?: number;
      occurredAt?: string;
      intervalEnd?: string;
      status: WorkerStatus;
    }
  >();
  private readonly stops = new Map<string, string>();

  findSession(tokenId: string) {
    return Promise.resolve(this.sessions.get(tokenId));
  }

  replaceSession(session: WorkerSessionRecord) {
    for (const current of this.sessions.values()) {
      if (
        current.serverId === session.serverId &&
        current.leaseId === session.leaseId &&
        !current.invalidatedAt
      ) {
        current.invalidatedAt = new Date().toISOString();
      }
    }
    this.sessions.set(session.tokenId, session);
    return Promise.resolve();
  }

  invalidateLease(serverId: string, leaseId: string, at: string) {
    for (const session of this.sessions.values()) {
      if (session.serverId === serverId && session.leaseId === leaseId) {
        session.invalidatedAt = at;
      }
    }
    return Promise.resolve();
  }

  claimNonce(input: { tokenId: string; nonce: string }) {
    const key = `${input.tokenId}:${input.nonce}`;
    if (this.nonces.has(key)) return Promise.resolve("replayed" as const);
    this.nonces.add(key);
    return Promise.resolve("claimed" as const);
  }

  claimAudit(input: WorkerAuditInput): Promise<WorkerAuditClaim> {
    const key = `${input.scope}:${input.eventId}`;
    const idempotencyScope = input.idempotencyKey
      ? `${input.scope}:idempotency:${input.idempotencyKey}`
      : undefined;
    const knownKey = idempotencyScope
      ? this.idempotencyKeys.get(idempotencyScope)
      : undefined;
    const existing = this.audits.get(key) ??
      (knownKey ? this.audits.get(knownKey) : undefined);
    if (existing) {
      if (existing.input.fingerprint !== input.fingerprint) {
        return Promise.resolve({ status: "conflict" });
      }
      if (existing.status === "pending") {
        return Promise.resolve({ status: "conflict" });
      }
      return Promise.resolve({ status: "duplicate", result: existing.result });
    }

    const cursor = this.cursors.get(input.scope) ??
      { status: "starting" as const };
    if (
      input.sequence !== undefined && cursor.sequence !== undefined &&
      input.sequence <= cursor.sequence
    ) {
      return Promise.resolve({ status: "out_of_order" });
    }
    if (
      input.occurredAt && cursor.occurredAt &&
      Date.parse(input.occurredAt) < Date.parse(cursor.occurredAt)
    ) {
      return Promise.resolve({ status: "out_of_order" });
    }
    if (
      input.intervalStart && cursor.intervalEnd &&
      Date.parse(input.intervalStart) < Date.parse(cursor.intervalEnd)
    ) {
      return Promise.resolve({ status: "out_of_order" });
    }
    if (
      input.nextStatus && !transitions[cursor.status].includes(input.nextStatus)
    ) {
      return Promise.resolve({ status: "status_conflict" });
    }

    this.audits.set(key, { input, status: "pending" });
    if (idempotencyScope) this.idempotencyKeys.set(idempotencyScope, key);
    return Promise.resolve({ status: "claimed" });
  }

  completeAudit(input: WorkerAuditInput, result?: unknown) {
    const key = `${input.scope}:${input.eventId}`;
    const record = this.audits.get(key);
    if (!record) throw new Error("audit_not_claimed");
    record.status = "completed";
    record.result = result;
    const cursor = this.cursors.get(input.scope) ??
      { status: "starting" as const };
    if (input.sequence !== undefined) cursor.sequence = input.sequence;
    if (input.occurredAt) cursor.occurredAt = input.occurredAt;
    if (input.intervalEnd) cursor.intervalEnd = input.intervalEnd;
    if (input.nextStatus) cursor.status = input.nextStatus;
    this.cursors.set(input.scope, cursor);
    return Promise.resolve();
  }

  releaseAudit(input: WorkerAuditInput) {
    const key = `${input.scope}:${input.eventId}`;
    const record = this.audits.get(key);
    if (record?.status === "pending") {
      this.audits.delete(key);
      if (input.idempotencyKey) {
        this.idempotencyKeys.delete(
          `${input.scope}:idempotency:${input.idempotencyKey}`,
        );
      }
    }
    return Promise.resolve();
  }

  markStopRequired(
    input: { serverId: string; leaseId: string; settlementId: string },
  ) {
    this.stops.set(`${input.serverId}:${input.leaseId}`, input.settlementId);
    return Promise.resolve();
  }

  getStopRequired(serverId: string, leaseId: string) {
    return Promise.resolve(this.stops.get(`${serverId}:${leaseId}`));
  }
}
