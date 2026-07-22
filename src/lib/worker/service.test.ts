import assert from "node:assert/strict";
import { type WorkerPrincipal } from "../workerAuth.ts";
import { MemoryWorkerRepository } from "../workerRepository.ts";
import {
  type CanonicalServerTimeUsage,
  type LeaseBinding,
  WorkerRuntimeError,
  WorkerRuntimeService,
} from "./service.ts";
import { workerFixtures } from "./fixtures.ts";
import publishedCanonicalServerTimeFixture from "../../../contracts/shared/v1/fixtures/canonical-server-time.json" with {
  type: "json",
};

const lease: LeaseBinding = {
  serverId: "server_test_001",
  leaseId: "lease_test_001",
  accountId: "account_test_001",
  authorizationId: "authorization_test_001",
  rateVersion: 3,
  status: "active",
};
const principal: WorkerPrincipal = {
  tokenId: "token_test_001",
  workerId: "worker_test_001",
  serverId: lease.serverId,
  leaseId: lease.leaseId,
};

function createService(options: {
  settlement?: "continue" | "stop_required";
  failSettlementOnce?: boolean;
  failOperationOnce?: boolean;
} = {}) {
  const repository = new MemoryWorkerRepository();
  const usage: CanonicalServerTimeUsage[] = [];
  const events: Record<string, unknown>[] = [];
  const operations: string[] = [];
  let settlementAttempts = 0;
  let operationAttempts = 0;
  const service = new WorkerRuntimeService({
    repository,
    leases: { getLease: () => Promise.resolve(lease) },
    bootstrap: { authenticate: () => Promise.resolve(true) },
    settlements: {
      settle(event) {
        settlementAttempts += 1;
        if (options.failSettlementOnce && settlementAttempts === 1) {
          return Promise.reject(new Error("m3_temporarily_unavailable"));
        }
        usage.push(event);
        return Promise.resolve({
          settlementId: "settlement_test_001",
          usageEventId: event.eventId,
          status: options.settlement === "stop_required"
            ? "rejected" as const
            : "settled" as const,
          action: options.settlement ?? "continue",
        });
      },
    },
    events: {
      publish: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    },
    operations: {
      receive(input) {
        operationAttempts += 1;
        if (options.failOperationOnce && operationAttempts === 1) {
          return Promise.reject(new Error("object_store_unavailable"));
        }
        operations.push(`${input.kind}:${input.operationId}`);
        return Promise.resolve();
      },
    },
    now: () => "2026-07-22T10:02:00.000Z",
  });
  return {
    service,
    repository,
    usage,
    events,
    operations,
    settlementAttempts: () => settlementAttempts,
    operationAttempts: () => operationAttempts,
  };
}

Deno.test("deduplicates exact heartbeat retries and audits changed event IDs as conflicts", async () => {
  const fixture = createService();
  const heartbeat = { ...workerFixtures.request.heartbeat };
  assert.deepEqual(await fixture.service.heartbeat(principal, heartbeat), {
    status: "accepted",
  });
  assert.deepEqual(await fixture.service.heartbeat(principal, heartbeat), {
    status: "duplicate",
  });
  await assert.rejects(
    () =>
      fixture.service.heartbeat(principal, { ...heartbeat, status: "failed" }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "event_conflict",
  );
});

Deno.test("rejects out-of-order runtime events and invalid status transitions", async () => {
  const fixture = createService();
  await fixture.service.runtimeEvent(principal, {
    eventId: "runtime_healthy_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    type: "healthy",
    occurredAt: "2026-07-22T10:01:00.000Z",
  });
  await assert.rejects(
    () =>
      fixture.service.runtimeEvent(principal, {
        eventId: "runtime_started_stale",
        serverId: lease.serverId,
        leaseId: lease.leaseId,
        type: "started",
        occurredAt: "2026-07-22T10:00:00.000Z",
      }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "out_of_order",
  );
  await assert.rejects(
    () =>
      fixture.service.runtimeEvent(principal, {
        eventId: "runtime_started_conflict",
        serverId: lease.serverId,
        leaseId: lease.leaseId,
        type: "started",
        occurredAt: "2026-07-22T10:01:30.000Z",
      }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "status_conflict",
  );
});

Deno.test("maps worker usage to published canonical server_time and settles an exact retry once", async () => {
  const fixture = createService();
  const request = { ...workerFixtures.request.usage };
  assert.deepEqual(await fixture.service.usage(principal, request), {
    status: "accepted",
    action: "continue",
  });

  assert.deepEqual(await fixture.service.usage(principal, request), {
    status: "duplicate",
    action: "continue",
  });
  assert.equal(fixture.usage.length, 1);
  assert.deepEqual(
    Object.keys(fixture.usage[0]).sort(),
    Object.keys(publishedCanonicalServerTimeFixture).sort(),
  );
  assert.deepEqual(fixture.usage[0], {
    eventType: "usage.recorded.v1",
    eventId: request.eventId,
    schemaVersion: 1,
    accountId: lease.accountId,
    authorizationId: lease.authorizationId,
    resource: "server_time",
    sourceId: lease.leaseId,
    quantity: 60,
    unit: "second",
    rateVersion: lease.rateVersion,
    sequence: 1,
    intervalStart: request.intervalStart,
    intervalEnd: request.intervalEnd,
    occurredAt: request.occurredAt,
    idempotencyKey: request.idempotencyKey,
  });
});

Deno.test("rejects overlapping server_time intervals even when sequence increases", async () => {
  const fixture = createService();
  await fixture.service.usage(principal, { ...workerFixtures.request.usage });
  await assert.rejects(
    () =>
      fixture.service.usage(principal, {
        ...workerFixtures.request.usage,
        eventId: "usage_test_overlap",
        idempotencyKey: "m5:lease_test_001:2",
        sequence: 2,
        intervalStart: "2026-07-22T10:00:30.000Z",
        intervalEnd: "2026-07-22T10:01:30.000Z",
      }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "out_of_order",
  );
  assert.equal(fixture.usage.length, 1);
});

Deno.test("releases an audit claim after Billing failure so a signed worker retry can settle", async () => {
  const fixture = createService({ failSettlementOnce: true });
  await assert.rejects(
    () => fixture.service.usage(principal, { ...workerFixtures.request.usage }),
    /m3_temporarily_unavailable/,
  );
  assert.deepEqual(
    await fixture.service.usage(principal, { ...workerFixtures.request.usage }),
    { status: "accepted", action: "continue" },
  );
  assert.equal(fixture.settlementAttempts(), 2);
  assert.equal(fixture.usage.length, 1);
});

Deno.test("returns stop_required for insufficient balance and publishes stopped only after observation", async () => {
  const fixture = createService({ settlement: "stop_required" });
  assert.deepEqual(
    await fixture.service.usage(principal, { ...workerFixtures.request.usage }),
    { status: "accepted", action: "stop_required" },
  );
  await assert.rejects(
    () =>
      fixture.service.usage(principal, {
        ...workerFixtures.request.usage,
        eventId: "usage_test_002",
        idempotencyKey: "m5:lease_test_001:2",
        sequence: 2,
        intervalStart: "2026-07-22T10:01:00.000Z",
        intervalEnd: "2026-07-22T10:02:00.000Z",
      }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "runtime_stopped",
  );

  await fixture.service.runtimeEvent(principal, {
    eventId: "runtime_running_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    type: "healthy",
    occurredAt: "2026-07-22T10:01:30.000Z",
  });
  await fixture.service.runtimeEvent(principal, {
    eventId: "runtime_stopped_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    type: "stopped",
    occurredAt: "2026-07-22T10:02:00.000Z",
  });
  assert.deepEqual(fixture.events.at(-1), {
    eventType: "runtime.stopped.v1",
    eventId: "runtime_stopped_001:balance-exhausted",
    schemaVersion: 1,
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    settlementId: "settlement_test_001",
    reason: "balance_exhausted",
    occurredAt: "2026-07-22T10:02:00.000Z",
  });
});

Deno.test("audits operation retries and retries a provider failure", async () => {
  const fixture = createService({ failOperationOnce: true });
  const request = {
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    operationId: "backup_test_001",
    objectKey: "worlds/test",
  };
  await assert.rejects(
    () => fixture.service.operation(principal, "backup.export", request),
    /object_store_unavailable/,
  );
  assert.deepEqual(
    await fixture.service.operation(principal, "backup.export", request),
    {
      status: "accepted",
      operationId: "backup_test_001",
    },
  );
  assert.deepEqual(
    await fixture.service.operation(principal, "backup.export", request),
    {
      status: "duplicate",
      operationId: "backup_test_001",
    },
  );
  assert.equal(fixture.operationAttempts(), 2);
  assert.deepEqual(fixture.operations, ["backup.export:backup_test_001"]);
});

Deno.test("rejects worker payloads bound to a different lease", async () => {
  const fixture = createService();
  await assert.rejects(
    () =>
      fixture.service.heartbeat(principal, {
        ...workerFixtures.request.heartbeat,
        leaseId: "lease_other",
      }),
    (error) =>
      error instanceof WorkerRuntimeError && error.code === "invalid_lease",
  );
});
