/**
 * ServerControl adapters for the immutable shared contract v1. Transport-specific
 * account routing stays local because published worker/admin events do not
 * carry an account ID.
 */
export const SERVER_CONTROL_SHARED_CONTRACT_VERSION = 1;

export interface ServerControlPrincipal {
  accountId: string;
  scopes: string[];
}

export interface AccountSessionGateway {
  authenticate(
    authorization: string | undefined,
  ): Promise<ServerControlPrincipal | null>;
}

export interface BillingRuntimeAuthorizationRequest {
  accountId: string;
  resource: "server_time";
  sourceId: string;
  expectedQuantity: number;
  unit: "hour";
  settlementIntervalSeconds: number;
  rateVersion: number;
  idempotencyKey: string;
  expiresAt: string;
}

export type BillingRuntimeAuthorization =
  | {
    authorizationId: string;
    accountId: string;
    resource: "server_time";
    sourceId: string;
    status: "authorized";
    rateVersion: number;
    expiresAt: string;
    actionOnExhaustion: "stop_required";
  }
  | {
    status: "rejected" | "expired" | "released";
    reason?: "insufficient_balance" | "forbidden" | "conflict";
  };

export interface BillingAuthorizationGateway {
  authorize(
    request: BillingRuntimeAuthorizationRequest,
  ): Promise<BillingRuntimeAuthorization>;
  release(authorizationId: string, idempotencyKey: string): Promise<void>;
}

export interface WorkerGateway {
  requestGracefulStop(input: {
    serverId: string;
    taskId: string;
    deadline: string;
  }): Promise<"accepted" | "unreachable">;
}

export interface WorldBackupDeletionGateway {
  confirmServerDeletion(input: {
    accountId: string;
    serverId: string;
    idempotencyKey: string;
  }): Promise<"confirmed" | "blocked">;
}

/**
 * D5 notification delivered through ServerControl's trusted account-partitioned queue
 * after Billing tells Worker to stop. The settlement ID is the deduplication key; this
 * is transport metadata, not a second shared event schema.
 */
export interface WorkerBalanceStopRequired {
  serverId: string;
  leaseId: string;
  settlementId: string;
  occurredAt: string;
}

/** `balance-exhaustion.schema.json`: `runtime.stopped.v1`. */
export interface WorkerRuntimeStoppedEvent {
  eventType: "runtime.stopped.v1";
  eventId: string;
  schemaVersion: 1;
  serverId: string;
  leaseId: string;
  settlementId: string;
  reason: "balance_exhausted";
  occurredAt: string;
}

export interface ServerControlWorkerEvent {
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  serverId: string;
  sequence: number;
  type: "worker.healthy" | "worker.stopped";
  observedAt: string;
}

/** `admin-operation-requested.schema.json`, routed by trusted account context. */
export interface AdminOperationRequested {
  eventType: "admin.operation.requested.v1";
  eventId: string;
  schemaVersion: 1;
  operationId: string;
  action: "server_suspend" | "server_restore";
  target: { resourceType: "server"; resourceId: string };
  requestedBy: string;
  reason: string;
  ticketId?: string;
  occurredAt: string;
}

/** `admin-operation-completed.schema.json`, recorded exactly once by ServerControl. */
export interface AdminOperationCompleted {
  eventType: "admin.operation.completed.v1";
  eventId: string;
  schemaVersion: 1;
  operationId: string;
  owner: "m4";
  status: "succeeded" | "rejected" | "failed";
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  completedAt: string;
}

/**
 * Local, post-schema translation used only inside the ServerControl state machine.
 * ServerControl no longer accepts Billing `stop_required` through this shape: D5 routes that
 * settlement to Worker and ServerControl observes its runtime stop/escalation instead.
 */
export interface ServerControlEvent {
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  serverId: string;
  sequence: number;
  source: "m7";
  action: "suspend" | "restore";
  reason: string;
  occurredAt: string;
}
