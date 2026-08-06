import {
  type AuditActor,
  type AuditLog,
  newAuditEvent,
  safeAuditMetadata,
} from "./audit.ts";

export type AdminOperationAction =
  | "refund"
  | "balance_adjust"
  | "server_suspend"
  | "server_restore";
export type AdminOperationOwner = "m3" | "m4";
export type AdminOperationStatus =
  | "pending"
  | "running"
  | "resolved"
  | "rejected";
/** Matches contracts/shared/v1/admin-operation-{requested,completed}.schema.json. */
export const ADMIN_OPERATION_SCHEMA_VERSION = 1 as const;

export interface AdminPrincipal {
  id: string;
  scopes: Array<"support" | "billing_operator" | "risk_operator" | "admin">;
  mfaVerifiedAt: string;
}

export interface AdminOperation {
  operationId: string;
  action: AdminOperationAction;
  target: { resourceType: string; resourceId: string };
  requestedBy: string;
  reason: string;
  ticketId?: string;
  status: AdminOperationStatus;
  requestedAt: string;
  requestFingerprint: string;
  requestedPublishedAt?: string;
  completion?: AdminOperationCompletedEvent;
  manualResolution?: {
    resolutionId: string;
    requestFingerprint: string;
    resolvedAt: string;
  };
}

export interface AdminOperationRequestedEvent {
  eventType: "admin.operation.requested.v1";
  eventId: string;
  schemaVersion: 1;
  operationId: string;
  action: AdminOperationAction;
  target: { resourceType: string; resourceId: string };
  requestedBy: string;
  reason: string;
  ticketId?: string;
  occurredAt: string;
}

export interface AdminOperationCompletedEvent {
  eventType: "admin.operation.completed.v1";
  eventId: string;
  schemaVersion: 1;
  operationId: string;
  owner: AdminOperationOwner;
  status: "succeeded" | "rejected" | "failed";
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  completedAt: string;
}

export interface AdminOperationRepository {
  create(operation: AdminOperation): Promise<
    | { status: "created"; operation: AdminOperation }
    | { status: "replay"; operation: AdminOperation }
    | { status: "conflict" }
  >;
  get(operationId: string): Promise<AdminOperation | undefined>;
  markRequestedPublished(
    operationId: string,
    publishedAt: string,
  ): Promise<void>;
  saveCompletion(
    operationId: string,
    completion: AdminOperationCompletedEvent,
    status: AdminOperationStatus,
  ): Promise<
    "accepted" | "duplicate" | "conflict"
  >;
  resolve(input: {
    operationId: string;
    resolutionId: string;
    requestFingerprint: string;
    resolvedAt: string;
  }): Promise<
    | { status: "resolved" | "replay"; operation: AdminOperation }
    | { status: "conflict" | "not_found" }
  >;
  pendingDispatches(): Promise<AdminOperation[]>;
  enqueueManual(input: {
    kind: "operation_dispatch_failed" | "orphan_completion" | "owner_failed";
    operationId: string;
    reason: string;
    occurredAt: string;
  }): Promise<void>;
}

export interface AdminOperationPublisher {
  publish(event: AdminOperationRequestedEvent): Promise<void>;
}

export interface AdminPrincipalAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<AdminPrincipal | undefined>;
}

export type BillingAdminOperationAction = "refund" | "balance_adjust";
export type ServerControlAdminOperationAction =
  | "server_suspend"
  | "server_restore";

/**
 * Resource-owner adapters are durable command boundaries. Each adapter uses
 * operationId as its dedupe key and emits exactly one shared-v1 completion for
 * an accepted command; AdminOperation only records that completion via consumeCompletion.
 */
export interface BillingAdminOperationCommandAdapter {
  dispatch(
    event: AdminOperationRequestedEvent & {
      action: BillingAdminOperationAction;
    },
  ): Promise<void>;
}

export interface ServerControlAdminOperationCommandAdapter {
  dispatch(
    event: AdminOperationRequestedEvent & {
      action: ServerControlAdminOperationAction;
    },
  ): Promise<void>;
}

function isM3AdminOperation(
  event: AdminOperationRequestedEvent,
): event is AdminOperationRequestedEvent & {
  action: BillingAdminOperationAction;
} {
  return event.action === "refund" || event.action === "balance_adjust";
}

function isM4AdminOperation(
  event: AdminOperationRequestedEvent,
): event is AdminOperationRequestedEvent & {
  action: ServerControlAdminOperationAction;
} {
  return event.action === "server_suspend" || event.action === "server_restore";
}

export class AdminOperationError extends Error {
  constructor(
    readonly code:
      | "invalid_operation"
      | "forbidden"
      | "mfa_required"
      | "idempotency_conflict"
      | "owner_conflict"
      | "operation_not_found"
      | "completion_conflict"
      | "adapter_unavailable",
  ) {
    super(code);
  }
}

const ownerForAction: Record<AdminOperationAction, AdminOperationOwner> = {
  refund: "m3",
  balance_adjust: "m3",
  server_suspend: "m4",
  server_restore: "m4",
};

/**
 * Routes published D6 requests only to their owning module. It never has a
 * reference to a balance, ledger, provider resource, or server repository.
 */
export class AdminOperationCommandRouter implements AdminOperationPublisher {
  constructor(
    private readonly billingAdapter:
      | BillingAdminOperationCommandAdapter
      | undefined,
    private readonly serverControlAdapter:
      | ServerControlAdminOperationCommandAdapter
      | undefined,
  ) {}

  async publish(event: AdminOperationRequestedEvent): Promise<void> {
    if (isM3AdminOperation(event)) {
      if (!this.billingAdapter) {
        throw new AdminOperationError("adapter_unavailable");
      }
      await this.billingAdapter.dispatch(event);
      return;
    }
    if (isM4AdminOperation(event)) {
      if (!this.serverControlAdapter) {
        throw new AdminOperationError("adapter_unavailable");
      }
      await this.serverControlAdapter.dispatch(event);
      return;
    }
    throw new AdminOperationError("invalid_operation");
  }
}

function fingerprint(input: {
  action: AdminOperationAction;
  target: { resourceType: string; resourceId: string };
  requestedBy: string;
  reason: string;
  ticketId?: string;
}) {
  return JSON.stringify(input);
}

function requestedEvent(
  operation: AdminOperation,
): AdminOperationRequestedEvent {
  return {
    eventType: "admin.operation.requested.v1",
    eventId: `admin-operation-requested:${operation.operationId}`,
    schemaVersion: ADMIN_OPERATION_SCHEMA_VERSION,
    operationId: operation.operationId,
    action: operation.action,
    target: operation.target,
    requestedBy: operation.requestedBy,
    reason: operation.reason,
    ticketId: operation.ticketId,
    occurredAt: operation.requestedAt,
  };
}

export function assertAdminPermission(
  principal: AdminPrincipal | undefined,
  action:
    | AdminOperationAction
    | "read_audit"
    | "read_metrics"
    | "read_reconciliation",
  now: string,
  mfaMaxAgeMs = 15 * 60_000,
) {
  if (!principal) throw new AdminOperationError("forbidden");
  const mfaAge = Date.parse(now) - Date.parse(principal.mfaVerifiedAt);
  if (!Number.isFinite(mfaAge) || mfaAge < 0 || mfaAge > mfaMaxAgeMs) {
    throw new AdminOperationError("mfa_required");
  }
  const permitted = action === "refund" || action === "balance_adjust"
    ? ["billing_operator", "admin"]
    : action === "server_suspend" || action === "server_restore"
    ? ["risk_operator", "admin"]
    : action === "read_reconciliation" || action === "read_metrics"
    ? ["admin"]
    : ["support", "billing_operator", "risk_operator", "admin"];
  if (!principal.scopes.some((scope) => permitted.includes(scope))) {
    throw new AdminOperationError("forbidden");
  }
}

export class AdminOperationService {
  constructor(
    private readonly operations: AdminOperationRepository,
    private readonly audit: AuditLog,
    private readonly publisher: AdminOperationPublisher,
    private readonly now: () => string,
  ) {}

  async request(input: {
    operationId: string;
    action: AdminOperationAction;
    target: { resourceType: string; resourceId: string };
    requestedBy: string;
    reason: string;
    ticketId?: string;
  }): Promise<AdminOperation> {
    if (
      !input.operationId.trim() || !input.target.resourceType.trim() ||
      !input.target.resourceId.trim() ||
      !input.requestedBy.trim() || !input.reason.trim() ||
      input.reason.length > 2_000 ||
      (input.ticketId !== undefined && !input.ticketId.trim())
    ) {
      throw new AdminOperationError("invalid_operation");
    }
    const operation: AdminOperation = {
      ...input,
      status: "pending",
      requestedAt: this.now(),
      requestFingerprint: fingerprint(input),
    };
    const stored = await this.operations.create(operation);
    if (stored.status === "conflict") {
      throw new AdminOperationError("idempotency_conflict");
    }
    if (stored.status === "replay") {
      if (!stored.operation.requestedPublishedAt) {
        await this.dispatch(stored.operation);
      }
      return (await this.operations.get(stored.operation.operationId)) ??
        stored.operation;
    }

    await this.audit.append(newAuditEvent({
      eventId: `audit:${operation.operationId}:requested`,
      actor: { type: "admin", id: operation.requestedBy },
      action: `admin.operation.${operation.action}.requested`,
      resourceType: operation.target.resourceType,
      resourceId: operation.target.resourceId,
      correlationId: operation.operationId,
      occurredAt: operation.requestedAt,
      metadata: safeAuditMetadata({
        ticketId: operation.ticketId,
        owner: ownerForAction[operation.action],
      }),
    }));
    await this.dispatch(operation);
    return (await this.operations.get(operation.operationId)) ?? operation;
  }

  async retryPendingDispatches(): Promise<void> {
    for (const operation of await this.operations.pendingDispatches()) {
      await this.dispatch(operation);
    }
  }

  async consumeCompletion(
    event: AdminOperationCompletedEvent,
  ): Promise<"accepted" | "duplicate" | "out_of_order"> {
    const operation = await this.operations.get(event.operationId);
    if (!operation) {
      await this.operations.enqueueManual({
        kind: "orphan_completion",
        operationId: event.operationId,
        reason: "completion_before_request",
        occurredAt: this.now(),
      });
      return "out_of_order";
    }
    if (ownerForAction[operation.action] !== event.owner) {
      throw new AdminOperationError("owner_conflict");
    }
    const status = event.status === "succeeded"
      ? "resolved"
      : event.status === "rejected"
      ? "rejected"
      : "pending";
    const outcome = await this.operations.saveCompletion(
      operation.operationId,
      event,
      status,
    );
    if (outcome === "conflict") {
      throw new AdminOperationError("completion_conflict");
    }
    if (outcome === "duplicate") return "duplicate";

    if (event.status === "failed") {
      await this.operations.enqueueManual({
        kind: "owner_failed",
        operationId: operation.operationId,
        reason: "resource_owner_failed",
        occurredAt: event.completedAt,
      });
    }
    await this.audit.append(newAuditEvent({
      eventId: `audit:${operation.operationId}:completed:${event.eventId}`,
      actor: { type: "system", id: event.owner },
      action: `admin.operation.${operation.action}.${event.status}`,
      resourceType: operation.target.resourceType,
      resourceId: operation.target.resourceId,
      correlationId: operation.operationId,
      causationId: event.eventId,
      occurredAt: event.completedAt,
      metadata: safeAuditMetadata({
        owner: event.owner,
        outcome: event.status,
      }),
    }));
    return "accepted";
  }

  async resolve(input: {
    operationId: string;
    resolutionId: string;
    reason: string;
    ticketId?: string;
    actor: AuditActor;
  }): Promise<AdminOperation> {
    if (!input.resolutionId.trim() || !input.reason.trim()) {
      throw new AdminOperationError("invalid_operation");
    }
    const resolvedAt = this.now();
    const result = await this.operations.resolve({
      operationId: input.operationId,
      resolutionId: input.resolutionId,
      requestFingerprint: JSON.stringify({
        reason: input.reason,
        ticketId: input.ticketId,
        actor: input.actor.id,
      }),
      resolvedAt,
    });
    if (result.status === "not_found") {
      throw new AdminOperationError("operation_not_found");
    }
    if (result.status === "conflict") {
      throw new AdminOperationError("idempotency_conflict");
    }
    if (result.status !== "resolved" && result.status !== "replay") {
      throw new AdminOperationError("operation_not_found");
    }
    const resolved = result.operation;
    if (result.status === "replay") return resolved;
    await this.audit.append(newAuditEvent({
      eventId:
        `audit:${input.operationId}:manually-resolved:${input.resolutionId}`,
      actor: input.actor,
      action: "admin.operation.manually_resolved",
      resourceType: resolved.target.resourceType,
      resourceId: resolved.target.resourceId,
      correlationId: input.operationId,
      occurredAt: resolvedAt,
      metadata: safeAuditMetadata({
        resolutionReasonProvided: true,
        ticketId: input.ticketId,
      }),
    }));
    return resolved;
  }

  private async dispatch(operation: AdminOperation): Promise<void> {
    try {
      await this.publisher.publish(requestedEvent(operation));
      await this.operations.markRequestedPublished(
        operation.operationId,
        this.now(),
      );
    } catch (cause) {
      if (
        cause instanceof AdminOperationError &&
        cause.code === "adapter_unavailable"
      ) {
        throw cause;
      }
      await this.operations.enqueueManual({
        kind: "operation_dispatch_failed",
        operationId: operation.operationId,
        reason: "requested_event_publish_failed",
        occurredAt: this.now(),
      });
    }
  }
}
