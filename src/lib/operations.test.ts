import assert from "node:assert/strict";
import {
  ADMIN_OPERATION_SCHEMA_VERSION,
  type AdminOperation,
  type AdminOperationCompletedEvent,
  AdminOperationError,
  type AdminOperationRepository,
  type AdminOperationRequestedEvent,
  AdminOperationService,
  type AdminPrincipal,
  assertAdminPermission,
} from "./operations.ts";
import { type AuditEvent, type AuditLog, safeAuditMetadata } from "./audit.ts";
import { adminOperationFixtures } from "./operations.fixtures.ts";

const now = () => "2026-07-22T14:00:00.000Z";
// Mirrors contracts/shared/v1/fixtures/admin-operation-requested.json without
// requiring filesystem permissions in the standard Deno test command.
const sharedRequestedFixture: AdminOperationRequestedEvent = {
  eventType: "admin.operation.requested.v1",
  eventId: "audit_123",
  schemaVersion: ADMIN_OPERATION_SCHEMA_VERSION,
  operationId: "operation_123",
  action: "server_suspend",
  target: { resourceType: "server", resourceId: "server_123" },
  requestedBy: "admin_123",
  reason: "Risk review",
  ticketId: "ticket_123",
  occurredAt: "2026-07-23T00:00:00Z",
};

class MemoryOperations implements AdminOperationRepository {
  readonly values = new Map<string, AdminOperation>();
  readonly manual: Array<
    { kind: string; operationId: string; reason: string }
  > = [];

  async create(operation: AdminOperation) {
    const existing = this.values.get(operation.operationId);
    if (!existing) {
      this.values.set(operation.operationId, structuredClone(operation));
      return { status: "created" as const, operation };
    }
    return existing.requestFingerprint === operation.requestFingerprint
      ? { status: "replay" as const, operation: structuredClone(existing) }
      : { status: "conflict" as const };
  }

  async get(operationId: string) {
    const value = this.values.get(operationId);
    return value && structuredClone(value);
  }

  async markRequestedPublished(operationId: string, publishedAt: string) {
    const operation = this.values.get(operationId);
    assert.ok(operation);
    operation.requestedPublishedAt = publishedAt;
  }

  async saveCompletion(
    operationId: string,
    completion: AdminOperationCompletedEvent,
    status: AdminOperation["status"],
  ) {
    const operation = this.values.get(operationId);
    assert.ok(operation);
    if (!operation.completion) {
      operation.completion = structuredClone(completion);
      operation.status = status;
      return "accepted" as const;
    }
    return JSON.stringify(operation.completion) === JSON.stringify(completion)
      ? "duplicate" as const
      : "conflict" as const;
  }

  async resolve(input: {
    operationId: string;
    resolutionId: string;
    requestFingerprint: string;
    resolvedAt: string;
  }) {
    const operation = this.values.get(input.operationId);
    if (!operation) return { status: "not_found" as const };
    if (operation.manualResolution) {
      return operation.manualResolution.resolutionId === input.resolutionId &&
          operation.manualResolution.requestFingerprint ===
            input.requestFingerprint
        ? { status: "replay" as const, operation: structuredClone(operation) }
        : { status: "conflict" as const };
    }
    operation.status = "resolved";
    operation.manualResolution = {
      resolutionId: input.resolutionId,
      requestFingerprint: input.requestFingerprint,
      resolvedAt: input.resolvedAt,
    };
    return {
      status: "resolved" as const,
      operation: structuredClone(operation),
    };
  }

  async pendingDispatches() {
    return [...this.values.values()]
      .filter((operation) => !operation.requestedPublishedAt)
      .map((operation) => structuredClone(operation));
  }

  async enqueueManual(input: {
    kind: "operation_dispatch_failed" | "orphan_completion" | "owner_failed";
    operationId: string;
    reason: string;
    occurredAt: string;
  }) {
    this.manual.push(input);
  }
}

class MemoryAudit implements AuditLog {
  readonly events: AuditEvent[] = [];
  append(event: AuditEvent) {
    this.events.push(event);
    return Promise.resolve();
  }
}

class Publisher {
  readonly events: AdminOperationRequestedEvent[] = [];
  fail = false;
  async publish(event: AdminOperationRequestedEvent) {
    if (this.fail) throw new Error("queue_unavailable");
    this.events.push(event);
  }
}

function makeService() {
  const operations = new MemoryOperations();
  const audit = new MemoryAudit();
  const publisher = new Publisher();
  return {
    operations,
    audit,
    publisher,
    service: new AdminOperationService(operations, audit, publisher, now),
  };
}

Deno.test("enforces action scopes and a recent second factor", () => {
  const billing: AdminPrincipal = {
    id: "admin-billing-001",
    scopes: ["billing_operator"],
    mfaVerifiedAt: "2026-07-22T13:50:00.000Z",
  };
  assert.doesNotThrow(() => assertAdminPermission(billing, "refund", now()));
  assert.throws(
    () => assertAdminPermission(billing, "server_suspend", now()),
    (error) =>
      error instanceof AdminOperationError && error.code === "forbidden",
  );
  assert.throws(
    () =>
      assertAdminPermission(
        { ...billing, mfaVerifiedAt: "2026-07-22T13:40:00.000Z" },
        "refund",
        now(),
      ),
    (error) =>
      error instanceof AdminOperationError && error.code === "mfa_required",
  );
});

Deno.test("rejects D6-invalid reasons and ticket identifiers before persistence", async () => {
  const { service, operations } = makeService();
  await assert.rejects(
    () =>
      service.request({
        ...adminOperationFixtures.request,
        reason: "x".repeat(2_001),
      }),
    (error) =>
      error instanceof AdminOperationError &&
      error.code === "invalid_operation",
  );
  await assert.rejects(
    () => service.request({ ...adminOperationFixtures.request, ticketId: " " }),
    (error) =>
      error instanceof AdminOperationError &&
      error.code === "invalid_operation",
  );
  assert.equal(operations.values.size, 0);
});

Deno.test("publishes a single D6 ServerControl command and replays an idempotent operation", async () => {
  const { service, publisher, audit } = makeService();
  const first = await service.request(adminOperationFixtures.request);
  const retry = await service.request(adminOperationFixtures.request);

  assert.equal(first.operationId, retry.operationId);
  assert.equal(publisher.events.length, 1);
  assert.deepEqual(publisher.events[0], {
    eventType: "admin.operation.requested.v1",
    eventId: "admin-operation-requested:operation_123",
    schemaVersion: ADMIN_OPERATION_SCHEMA_VERSION,
    ...adminOperationFixtures.request,
    occurredAt: now(),
  });
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].metadata?.owner, "m4");
  assert.deepEqual(
    {
      ...publisher.events[0],
      eventId: sharedRequestedFixture.eventId,
      occurredAt: sharedRequestedFixture.occurredAt,
    },
    sharedRequestedFixture,
  );
});

Deno.test("rejects reuse of an operation id with a conflicting request", async () => {
  const { service } = makeService();
  await service.request(adminOperationFixtures.request);
  await assert.rejects(
    () =>
      service.request({
        ...adminOperationFixtures.request,
        reason: "A different reason.",
      }),
    (error) =>
      error instanceof AdminOperationError &&
      error.code === "idempotency_conflict",
  );
});

Deno.test("records provider dispatch failure for manual retry without writing ServerControl data", async () => {
  const { service, publisher, operations } = makeService();
  publisher.fail = true;
  await service.request(adminOperationFixtures.request);

  assert.deepEqual(operations.manual, [{
    kind: "operation_dispatch_failed",
    operationId: "operation_123",
    reason: "requested_event_publish_failed",
    occurredAt: now(),
  }]);
  assert.equal(publisher.events.length, 0);
  publisher.fail = false;
  await service.retryPendingDispatches();
  assert.equal(publisher.events.length, 1);
});

Deno.test("deduplicates owner completion, preserves failures for manual work, and rejects owner conflicts", async () => {
  const { service, operations } = makeService();
  await service.request(adminOperationFixtures.request);
  assert.equal(
    await service.consumeCompletion(adminOperationFixtures.completed),
    "accepted",
  );
  assert.equal(
    await service.consumeCompletion(adminOperationFixtures.completed),
    "duplicate",
  );
  await assert.rejects(
    () =>
      service.consumeCompletion({
        ...adminOperationFixtures.completed,
        eventId: "m3-conflict",
        owner: "m3",
      }),
    (error) =>
      error instanceof AdminOperationError && error.code === "owner_conflict",
  );

  const failed = {
    ...adminOperationFixtures.completed,
    eventId: "m3-completed-op-m7-001-retry",
    status: "failed" as const,
  };
  await assert.rejects(
    () => service.consumeCompletion(failed),
    (error) =>
      error instanceof AdminOperationError &&
      error.code === "completion_conflict",
  );
  assert.equal(operations.manual.length, 0);
});

Deno.test("routes out-of-order completion to manual handling", async () => {
  const { service, operations } = makeService();
  assert.equal(
    await service.consumeCompletion({
      ...adminOperationFixtures.completed,
      operationId: "op-arrived-first",
    }),
    "out_of_order",
  );
  assert.deepEqual(operations.manual, [{
    kind: "orphan_completion",
    operationId: "op-arrived-first",
    reason: "completion_before_request",
    occurredAt: now(),
  }]);
});

Deno.test("makes manual resolution idempotent while retaining only safe audit metadata", async () => {
  const { service, audit } = makeService();
  await service.request(adminOperationFixtures.request);
  const resolution = {
    operationId: adminOperationFixtures.request.operationId,
    resolutionId: "resolve-m7-001",
    reason: "Billing confirmed the external refund was already completed.",
    ticketId: "SUP-1001",
    actor: { type: "admin" as const, id: "admin-billing-001" },
  };
  const first = await service.resolve(resolution);
  const retry = await service.resolve(resolution);
  assert.equal(first.status, "resolved");
  assert.equal(retry.status, "resolved");
  assert.equal(
    audit.events.filter((event) =>
      event.action === "admin.operation.manually_resolved"
    ).length,
    1,
  );
  assert.equal(audit.events.at(-1)?.metadata?.resolutionReasonProvided, true);
  await assert.rejects(
    () =>
      service.resolve({ ...resolution, resolutionId: "resolve-m7-conflict" }),
    (error) =>
      error instanceof AdminOperationError &&
      error.code === "idempotency_conflict",
  );
});

Deno.test("removes sensitive values from audit fixtures", () => {
  assert.deepEqual(
    safeAuditMetadata({
      ticketId: "SUP-1001",
      providerToken: "must-not-persist",
      paypalTransaction: "must-not-persist",
      operationCount: 1,
    }),
    { ticketId: "SUP-1001", operationCount: 1 },
  );
});
