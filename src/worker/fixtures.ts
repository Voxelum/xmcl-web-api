export const workerFixtures = {
  request: {
    heartbeat: {
      eventId: "heartbeat_test_001",
      serverId: "server_test_001",
      leaseId: "lease_test_001",
      status: "running",
      observedAt: "2026-07-22T10:00:30.000Z",
    },
    usage: {
      eventId: "usage_test_001",
      serverId: "server_test_001",
      leaseId: "lease_test_001",
      sequence: 1,
      quantity: 60,
      intervalStart: "2026-07-22T10:00:00.000Z",
      intervalEnd: "2026-07-22T10:01:00.000Z",
      occurredAt: "2026-07-22T10:01:00.000Z",
      idempotencyKey: "m5:lease_test_001:1",
    },
  },
  response: {
    accepted: { status: "accepted" },
    duplicate: { status: "duplicate" },
    stopRequired: { status: "accepted", action: "stop_required" },
  },
  errors: {
    unauthorized: {
      status: 401,
      body: { error: "unauthorized", action: "registration_required" },
    },
    replay: {
      status: 409,
      body: { error: "replay_detected", action: "registration_required" },
    },
    statusConflict: {
      status: 409,
      body: { error: "status_conflict", action: "registration_required" },
    },
    providerFailure: {
      status: 503,
      body: { error: "worker_provider_unavailable" },
    },
  },
  retries: {
    eventId: "usage_test_001",
    idempotencyKey: "m5:lease_test_001:1",
    expectedSettlements: 1,
  },
} as const;
