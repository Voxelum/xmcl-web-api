import type {
  AdminOperationRequested,
  ServerControlWorkerEvent,
  WorkerBalanceStopRequired,
  WorkerRuntimeStoppedEvent,
} from "./serverControlProposals.ts";

export const workerHealthy: ServerControlWorkerEvent = {
  eventId: "evt_worker_healthy_2",
  schemaVersion: 1,
  accountId: "acct_m4_fixture",
  serverId: "server_m4_fixture",
  sequence: 2,
  type: "worker.healthy",
  observedAt: "2026-07-22T14:02:00.000Z",
};

export const duplicateWorkerHealthy = structuredClone(workerHealthy);
export const conflictingWorkerHealthy: ServerControlWorkerEvent = {
  ...workerHealthy,
  type: "worker.stopped",
};
export const outOfOrderWorkerHealthy: ServerControlWorkerEvent = {
  ...workerHealthy,
  eventId: "evt_worker_healthy_1_late",
  sequence: 1,
};
export const retriedWorkerHealthy: ServerControlWorkerEvent = {
  ...workerHealthy,
  eventId: "evt_worker_healthy_3_retry",
  sequence: 3,
};

export const balanceStopRequired: WorkerBalanceStopRequired = {
  serverId: "server_m4_fixture",
  leaseId: "lease_m4_fixture",
  settlementId: "settlement_m4_fixture",
  occurredAt: "2026-07-22T14:05:00.000Z",
};

export const runtimeStopped: WorkerRuntimeStoppedEvent = {
  eventType: "runtime.stopped.v1",
  eventId: "runtime_m4_fixture",
  schemaVersion: 1,
  serverId: "server_m4_fixture",
  leaseId: "lease_m4_fixture",
  settlementId: "settlement_m4_fixture",
  reason: "balance_exhausted",
  occurredAt: "2026-07-22T14:05:05.000Z",
};

export const adminSuspend: AdminOperationRequested = {
  eventType: "admin.operation.requested.v1",
  eventId: "evt_m7_suspend_4",
  schemaVersion: 1,
  operationId: "operation_m4_suspend",
  action: "server_suspend",
  target: { resourceType: "server", resourceId: "server_m4_fixture" },
  requestedBy: "admin_m4_fixture",
  reason: "admin_policy_ticket_42",
  occurredAt: "2026-07-22T14:06:00.000Z",
};

export const apiFixtures = {
  missingAuthorization: {
    request: { method: "GET", path: "/v1/servers" },
    response: { status: 401, error: "forbidden" },
  },
  insufficientScope: {
    request: {
      method: "POST",
      path: "/v1/servers",
      authorization: "Bearer read-only",
    },
    response: { status: 403, error: "forbidden" },
  },
  idempotentRetry: {
    first: { idempotencyKey: "fixture-create-1", plan: "vc2-2c-4gb" },
    retry: { idempotencyKey: "fixture-create-1", plan: "vc2-2c-4gb" },
    expected: "same_task",
  },
  idempotencyConflict: {
    first: { idempotencyKey: "fixture-create-1", plan: "vc2-2c-4gb" },
    conflicting: {
      idempotencyKey: "fixture-create-1",
      plan: "vc2-4c-8gb",
    },
    response: { status: 409, error: "idempotency_conflict" },
  },
  providerFailure: {
    provider: { status: 503, body: "not exposed" },
    task: {
      status: "running",
      statusReason: "provider_reconciliation_required",
      error: "provider_unknown",
    },
  },
} as const;
