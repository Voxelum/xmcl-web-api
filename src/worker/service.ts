import {
  issueWorkerToken,
  type WorkerPrincipal,
  type WorkerSessionRecord,
} from "../workerAuth.ts";
import {
  type WorkerAuditInput,
  type WorkerRepository,
  type WorkerStatus,
} from "../workerRepository.ts";

export interface LeaseBinding {
  leaseId: string;
  serverId: string;
  accountId: string;
  authorizationId: string;
  rateVersion: number;
  status: "reserved" | "active" | "closed";
}

/** Worker's read-only boundary to the ServerControl lease owner. */
export interface ServerControlLeaseAdapter {
  getLease(
    serverId: string,
    leaseId: string,
  ): Promise<LeaseBinding | undefined>;
}

/** Exact Worker projection of contracts/shared/v1/canonical-usage-event.schema.json. */
export interface CanonicalServerTimeUsage {
  eventType: "usage.recorded.v1";
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  authorizationId: string;
  resource: "server_time";
  sourceId: string;
  quantity: number;
  unit: "second";
  rateVersion: number;
  sequence: number;
  intervalStart: string;
  intervalEnd: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface BillingSettlementResult {
  settlementId: string;
  usageEventId: string;
  status: "settled" | "rejected" | "pending";
  action: "continue" | "stop_required";
}

/** Worker's write-only boundary to the Billing settlement owner. */
export interface BillingSettlementAdapter {
  settle(event: CanonicalServerTimeUsage): Promise<BillingSettlementResult>;
}

export interface WorkerRuntimeDependencies {
  repository: WorkerRepository;
  leases: ServerControlLeaseAdapter;
  bootstrap: {
    authenticate(input: {
      serverId: string;
      leaseId: string;
      workerId: string;
      credential: string;
    }): Promise<boolean>;
  };
  settlements: BillingSettlementAdapter;
  events: {
    publish(event: Record<string, unknown>): Promise<void>;
  };
  operations: {
    receive(input: {
      kind: WorkerOperationKind | "logs";
      serverId: string;
      leaseId: string;
      operationId: string;
      payload: Record<string, unknown>;
    }): Promise<void>;
  };
  now?: () => string;
  issueToken?: typeof issueWorkerToken;
}

export type WorkerOperationKind =
  | "backup.export"
  | "backup.restore"
  | "backup.event"
  | "modpack.prepare"
  | "modpack.apply"
  | "modpack.event";

export class WorkerRuntimeError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "invalid_request"
      | "invalid_lease"
      | "event_conflict"
      | "out_of_order"
      | "status_conflict"
      | "runtime_stopped"
      | "settlement_unavailable",
  ) {
    super(code);
  }
}

export class WorkerRuntimeService {
  private readonly now: () => string;
  private readonly issueToken: typeof issueWorkerToken;

  constructor(private readonly dependencies: WorkerRuntimeDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.issueToken = dependencies.issueToken ?? issueWorkerToken;
  }

  async register(input: {
    serverId: string;
    leaseId: string;
    workerId: string;
    credential: string;
  }) {
    requireStrings(
      input.serverId,
      input.leaseId,
      input.workerId,
      input.credential,
    );
    const [authorized, lease] = await Promise.all([
      this.dependencies.bootstrap.authenticate(input),
      this.dependencies.leases.getLease(input.serverId, input.leaseId),
    ]);
    if (!authorized) throw new WorkerRuntimeError("unauthorized");
    this.assertActiveLease(lease, input.serverId, input.leaseId);

    const issued = await this.issueToken();
    const expiresAt = new Date(Date.parse(this.now()) + 5 * 60_000)
      .toISOString();
    const session: WorkerSessionRecord = {
      tokenId: issued.tokenId,
      tokenHash: issued.tokenHash,
      workerId: input.workerId,
      serverId: input.serverId,
      leaseId: input.leaseId,
      expiresAt,
    };
    await this.dependencies.repository.replaceSession(session);
    return {
      token: issued.token,
      tokenType: "Worker",
      serverId: input.serverId,
      leaseId: input.leaseId,
      expiresAt,
    };
  }

  async heartbeat(principal: WorkerPrincipal, body: Record<string, unknown>) {
    const event = parseHeartbeat(body);
    this.assertPrincipal(principal, event.serverId, event.leaseId);
    await this.assertLeaseActive(event.serverId, event.leaseId);
    const audit = this.observationAudit("heartbeat", event, event.status);
    return await this.acceptAudit(audit);
  }

  async runtimeEvent(
    principal: WorkerPrincipal,
    body: Record<string, unknown>,
  ) {
    const event = parseRuntimeEvent(body);
    this.assertPrincipal(principal, event.serverId, event.leaseId);
    const lease = await this.dependencies.leases.getLease(
      event.serverId,
      event.leaseId,
    );
    if (!lease || lease.status === "closed") {
      throw new WorkerRuntimeError("invalid_lease");
    }

    const nextStatus = event.type === "started"
      ? "starting"
      : event.type === "healthy"
      ? "running"
      : event.type === "stopped"
      ? "stopped"
      : "failed";
    const audit = this.observationAudit("runtime", event, nextStatus);
    const claimed = await this.claim(audit);
    if (claimed) return claimed;

    try {
      await this.dependencies.events.publish({
        eventType: "worker.runtime.observed.v1",
        schemaVersion: 1,
        ...event,
      });
      const settlementId = event.type === "stopped"
        ? await this.dependencies.repository.getStopRequired(
          event.serverId,
          event.leaseId,
        )
        : undefined;
      if (settlementId) {
        await this.dependencies.events.publish({
          eventType: "runtime.stopped.v1",
          eventId: `${event.eventId}:balance-exhausted`,
          schemaVersion: 1,
          serverId: event.serverId,
          leaseId: event.leaseId,
          settlementId,
          reason: "balance_exhausted",
          occurredAt: event.occurredAt,
        });
      }
      await this.dependencies.repository.completeAudit(audit, {
        status: "accepted",
      });
      return { status: "accepted" as const };
    } catch (error) {
      await this.dependencies.repository.releaseAudit(audit);
      throw error;
    }
  }

  async usage(principal: WorkerPrincipal, body: Record<string, unknown>) {
    const input = parseUsage(body);
    this.assertPrincipal(principal, input.serverId, input.leaseId);
    const lease = await this.assertLeaseActive(input.serverId, input.leaseId);
    if (
      await this.dependencies.repository.getStopRequired(
        input.serverId,
        input.leaseId,
      )
    ) {
      throw new WorkerRuntimeError("runtime_stopped");
    }

    const startsAt = Date.parse(input.intervalStart);
    const endsAt = Date.parse(input.intervalEnd);
    if (
      !Number.isSafeInteger(input.quantity) || input.quantity <= 0 ||
      !Number.isSafeInteger(input.sequence) || input.sequence <= 0 ||
      !Number.isFinite(startsAt) || !Number.isFinite(endsAt) ||
      endsAt <= startsAt || (endsAt - startsAt) / 1000 !== input.quantity
    ) {
      throw new WorkerRuntimeError("invalid_request");
    }

    const canonical: CanonicalServerTimeUsage = {
      eventType: "usage.recorded.v1",
      eventId: input.eventId,
      schemaVersion: 1,
      accountId: lease.accountId,
      authorizationId: lease.authorizationId,
      resource: "server_time",
      sourceId: lease.leaseId,
      quantity: input.quantity,
      unit: "second",
      rateVersion: lease.rateVersion,
      sequence: input.sequence,
      intervalStart: input.intervalStart,
      intervalEnd: input.intervalEnd,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    };
    const audit: WorkerAuditInput = {
      scope: `usage:${input.leaseId}`,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprint(canonical),
      sequence: input.sequence,
      occurredAt: input.intervalEnd,
      intervalStart: input.intervalStart,
      intervalEnd: input.intervalEnd,
    };
    const claimed = await this.claim(audit);
    if (claimed) return claimed;

    try {
      const settlement = await this.dependencies.settlements.settle(canonical);
      if (
        settlement.usageEventId !== input.eventId ||
        settlement.status === "pending" ||
        (settlement.status === "rejected" &&
          settlement.action !== "stop_required")
      ) {
        throw new WorkerRuntimeError(
          settlement.status === "pending"
            ? "settlement_unavailable"
            : "event_conflict",
        );
      }
      if (settlement.action === "stop_required") {
        await this.dependencies.repository.markStopRequired({
          serverId: input.serverId,
          leaseId: input.leaseId,
          settlementId: settlement.settlementId,
        });
      }
      const result = { status: "accepted" as const, action: settlement.action };
      await this.dependencies.repository.completeAudit(audit, result);
      return result;
    } catch (error) {
      await this.dependencies.repository.releaseAudit(audit);
      throw error;
    }
  }

  async logs(principal: WorkerPrincipal, body: Record<string, unknown>) {
    return await this.operation(principal, "logs", body);
  }

  async operation(
    principal: WorkerPrincipal,
    kind: WorkerOperationKind | "logs",
    body: Record<string, unknown>,
  ) {
    const serverId = stringField(body, "serverId");
    const leaseId = stringField(body, "leaseId");
    const operationId = stringField(body, "operationId");
    this.assertPrincipal(principal, serverId, leaseId);
    await this.assertLeaseActive(serverId, leaseId);
    const audit: WorkerAuditInput = {
      scope: `operation:${kind}:${leaseId}`,
      eventId: operationId,
      idempotencyKey: operationId,
      fingerprint: fingerprint(body),
    };
    const claimed = await this.claim(audit);
    if (claimed) return claimed;
    try {
      await this.dependencies.operations.receive({
        kind,
        serverId,
        leaseId,
        operationId,
        payload: body,
      });
      const result = { status: "accepted" as const, operationId };
      await this.dependencies.repository.completeAudit(audit, result);
      return result;
    } catch (error) {
      await this.dependencies.repository.releaseAudit(audit);
      throw error;
    }
  }

  private observationAudit(
    kind: string,
    event: { eventId: string; leaseId: string; occurredAt: string },
    nextStatus: WorkerStatus,
  ): WorkerAuditInput {
    return {
      scope: `${kind}:${event.leaseId}`,
      eventId: event.eventId,
      fingerprint: fingerprint(event),
      occurredAt: event.occurredAt,
      nextStatus,
    };
  }

  private async acceptAudit(audit: WorkerAuditInput) {
    const claimed = await this.claim(audit);
    if (claimed) return claimed;
    await this.dependencies.repository.completeAudit(audit, {
      status: "accepted",
    });
    return { status: "accepted" as const };
  }

  private async claim(audit: WorkerAuditInput) {
    const result = await this.dependencies.repository.claimAudit(audit);
    if (result.status === "duplicate") {
      return {
        ...((result.result as Record<string, unknown> | undefined) ?? {}),
        status: "duplicate" as const,
      };
    }
    if (result.status !== "claimed") {
      throw new WorkerRuntimeError(
        result.status === "conflict" ? "event_conflict" : result.status,
      );
    }
    return undefined;
  }

  private assertPrincipal(
    principal: WorkerPrincipal,
    serverId: string,
    leaseId: string,
  ) {
    if (principal.serverId !== serverId || principal.leaseId !== leaseId) {
      throw new WorkerRuntimeError("invalid_lease");
    }
  }

  private async assertLeaseActive(serverId: string, leaseId: string) {
    const lease = await this.dependencies.leases.getLease(serverId, leaseId);
    this.assertActiveLease(lease, serverId, leaseId);
    return lease;
  }

  private assertActiveLease(
    lease: LeaseBinding | undefined,
    serverId: string,
    leaseId: string,
  ): asserts lease is LeaseBinding {
    if (
      !lease || lease.serverId !== serverId || lease.leaseId !== leaseId ||
      lease.status !== "active"
    ) {
      throw new WorkerRuntimeError("invalid_lease");
    }
  }
}

function parseHeartbeat(body: Record<string, unknown>) {
  const status = stringField(body, "status") as WorkerStatus;
  if (
    !["starting", "running", "stopping", "stopped", "failed"].includes(status)
  ) {
    throw new WorkerRuntimeError("invalid_request");
  }
  return {
    eventId: stringField(body, "eventId"),
    serverId: stringField(body, "serverId"),
    leaseId: stringField(body, "leaseId"),
    status,
    occurredAt: dateField(body, "observedAt"),
  };
}

function parseRuntimeEvent(body: Record<string, unknown>) {
  const type = stringField(body, "type") as
    | "started"
    | "healthy"
    | "stopped"
    | "crashed";
  if (!["started", "healthy", "stopped", "crashed"].includes(type)) {
    throw new WorkerRuntimeError("invalid_request");
  }
  return {
    eventId: stringField(body, "eventId"),
    serverId: stringField(body, "serverId"),
    leaseId: stringField(body, "leaseId"),
    type,
    occurredAt: dateField(body, "occurredAt"),
    ...(isRecord(body.details) ? { details: body.details } : {}),
  };
}

function parseUsage(body: Record<string, unknown>) {
  return {
    eventId: stringField(body, "eventId"),
    serverId: stringField(body, "serverId"),
    leaseId: stringField(body, "leaseId"),
    sequence: numberField(body, "sequence"),
    quantity: numberField(body, "quantity"),
    intervalStart: dateField(body, "intervalStart"),
    intervalEnd: dateField(body, "intervalEnd"),
    occurredAt: dateField(body, "occurredAt"),
    idempotencyKey: stringField(body, "idempotencyKey"),
  };
}

function requireStrings(...values: string[]) {
  if (values.some((value) => !value.trim())) {
    throw new WorkerRuntimeError("invalid_request");
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkerRuntimeError("invalid_request");
  }
  return value;
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number") {
    throw new WorkerRuntimeError("invalid_request");
  }
  return value;
}

function dateField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw new WorkerRuntimeError("invalid_request");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map((
        [key, child],
      ) => [key, sortValue(child)]),
  );
}
