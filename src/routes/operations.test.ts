import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import type { AuditEvent, AuditLog } from "../lib/audit.ts";
import type {
  AdminOperation,
  AdminOperationCompletedEvent,
  AdminOperationRepository,
  AdminOperationRequestedEvent,
  AdminPrincipalAuthenticator,
  BillingAdminOperationCommandAdapter,
  ServerControlAdminOperationCommandAdapter,
} from "../lib/operations.ts";

class MemoryOperations implements AdminOperationRepository {
  readonly values = new Map<string, AdminOperation>();

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
    const operation = this.values.get(operationId);
    return operation && structuredClone(operation);
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

  async resolve() {
    return { status: "not_found" as const };
  }

  async pendingDispatches() {
    return [...this.values.values()]
      .filter((operation) => !operation.requestedPublishedAt)
      .map((operation) => structuredClone(operation));
  }

  async enqueueManual() {}
}

class MemoryAudit implements AuditLog {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent) {
    this.events.push(event);
    return Promise.resolve();
  }
}

function principal(
  scopes: Array<"support" | "billing_operator" | "risk_operator" | "admin">,
) {
  return {
    id: "admin_123",
    scopes,
    mfaVerifiedAt: new Date().toISOString(),
  };
}

function createHarness(options: {
  billing?: BillingAdminOperationCommandAdapter;
  serverControl?: ServerControlAdminOperationCommandAdapter;
  authenticator?: AdminPrincipalAuthenticator;
} = {}) {
  const repository = new MemoryOperations();
  const audit = new MemoryAudit();
  const authenticator = options.authenticator ?? {
    authenticate(authorization) {
      const token = authorization?.replace(/^Bearer /, "");
      if (token === "billing") {
        return Promise.resolve(principal(["billing_operator"]));
      }
      if (token === "risk") {
        return Promise.resolve(principal(["risk_operator"]));
      }
      if (token === "support") return Promise.resolve(principal(["support"]));
      return Promise.resolve(undefined);
    },
  };
  const app = createApp((mounted) => {
    mounted.use("/v1/admin/*", async (c, next) => {
      c.set("adminOperationAuthenticator", authenticator);
      c.set("adminOperationRepository", repository);
      c.set("adminOperationAuditLog", audit);
      c.set("billingAdminOperationAdapter", options.billing);
      c.set("serverControlAdminOperationAdapter", options.serverControl);
      c.set("adminOperationNow", () => "2026-07-22T14:00:00.000Z");
      await next();
    });
  });

  return { app, repository, audit };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  operationId: string,
  token: string,
) {
  return app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": operationId,
    },
    body: JSON.stringify({ reason: "Risk review", ticketId: "ticket_123" }),
  });
}

Deno.test("mounted admin routes inject Billing for billing and ServerControl for server commands", async () => {
  const billingEvents: AdminOperationRequestedEvent[] = [];
  const serverControlEvents: AdminOperationRequestedEvent[] = [];
  const { app } = createHarness({
    billing: { dispatch: async (event) => void billingEvents.push(event) },
    serverControl: {
      dispatch: async (event) => void serverControlEvents.push(event),
    },
  });

  for (
    const [path, operationId, token] of [
      ["/v1/admin/accounts/account_123/refunds", "refund_123", "billing"],
      [
        "/v1/admin/accounts/account_123/balance/adjust",
        "adjust_123",
        "billing",
      ],
      ["/v1/admin/servers/server_123/suspend", "suspend_123", "risk"],
      ["/v1/admin/servers/server_123/restore", "restore_123", "risk"],
    ] as const
  ) {
    assert.equal((await post(app, path, operationId, token)).status, 202);
  }

  assert.deepEqual(billingEvents.map((event) => event.action), [
    "refund",
    "balance_adjust",
  ]);
  assert.deepEqual(serverControlEvents.map((event) => event.action), [
    "server_suspend",
    "server_restore",
  ]);
  assert.equal(
    billingEvents.every((event) =>
      event.eventType === "admin.operation.requested.v1"
    ),
    true,
  );
  assert.equal(
    serverControlEvents.every((event) => event.schemaVersion === 1),
    true,
  );
});

Deno.test("admin routes reject insufficient scope before dispatch", async () => {
  const billingEvents: AdminOperationRequestedEvent[] = [];
  const { app } = createHarness({
    billing: { dispatch: async (event) => void billingEvents.push(event) },
  });

  const response = await post(
    app,
    "/v1/admin/accounts/account_123/refunds",
    "forbidden_123",
    "support",
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "forbidden");
  assert.equal(billingEvents.length, 0);
});

Deno.test("operationId replay dispatches one durable owner command", async () => {
  const billingEvents: AdminOperationRequestedEvent[] = [];
  const { app } = createHarness({
    billing: { dispatch: async (event) => void billingEvents.push(event) },
  });

  const first = await post(
    app,
    "/v1/admin/accounts/account_123/refunds",
    "replay_123",
    "billing",
  );
  const replay = await post(
    app,
    "/v1/admin/accounts/account_123/refunds",
    "replay_123",
    "billing",
  );
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(billingEvents.length, 1);
  assert.equal(billingEvents[0].operationId, "replay_123");
});

Deno.test("an unavailable owner adapter is an explicit retryable failure", async () => {
  const { app } = createHarness();
  const response = await post(
    app,
    "/v1/admin/accounts/account_123/refunds",
    "unavailable_123",
    "billing",
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "adapter_unavailable");
});
