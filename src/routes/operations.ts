import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type AdminOperationAction,
  AdminOperationCommandRouter,
  AdminOperationError,
  AdminOperationService,
  assertAdminPermission,
} from "../lib/operations.ts";
import type { AppEnv } from "../types.ts";

const accountAction = (path: string): AdminOperationAction =>
  path.endsWith("/refunds") ? "refund" : "balance_adjust";
const serverAction = (path: string): AdminOperationAction =>
  path.endsWith("/suspend") ? "server_suspend" : "server_restore";

function error(
  c: {
    json: (
      body: unknown,
      status: 400 | 401 | 403 | 409 | 422 | 503,
    ) => Response;
  },
  cause: unknown,
) {
  if (cause instanceof AdminOperationError) {
    const status = cause.code === "forbidden"
      ? 403
      : cause.code === "mfa_required"
      ? 401
      : cause.code === "adapter_unavailable"
      ? 503
      : cause.code.includes("conflict")
      ? 409
      : cause.code === "invalid_operation"
      ? 422
      : 400;
    return c.json({ error: cause.code, message: cause.code }, status);
  }
  return c.json({
    error: "admin_operations_unavailable",
    message: "Admin operations are not configured",
  }, 503);
}

async function body(c: { req: { json: () => Promise<unknown> } }) {
  const result = await c.req.json().catch(() => undefined);
  return result && typeof result === "object"
    ? result as { reason?: unknown; ticketId?: unknown }
    : {};
}

const operations = new Hono<AppEnv>();

/**
 * Admin endpoints have a separate authenticated principal from XMCL user
 * sessions. The middleware is mounted only under /v1/admin and overwrites any
 * caller-provided context value.
 */
export function adminPrincipalAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authenticator = c.var.adminOperationAuthenticator;
    if (!authenticator) {
      return c.json({
        error: "admin_auth_unavailable",
        message: "Admin authentication is not configured",
      }, 503);
    }
    const principal = await authenticator.authenticate(
      c.req.header("Authorization"),
    ).catch(() => undefined);
    if (!principal) {
      return c.json({
        error: "admin_authentication_required",
        message: "A verified admin session is required",
      }, 401);
    }
    c.set("adminPrincipal", principal);
    await next();
  });
}

function operationService(c: Context<AppEnv>) {
  if (c.var.adminOperationService) return c.var.adminOperationService;
  if (!c.var.adminOperationRepository || !c.var.adminOperationAuditLog) {
    throw new Error(
      "AdminOperation durable operation dependencies are not configured",
    );
  }
  return new AdminOperationService(
    c.var.adminOperationRepository,
    c.var.adminOperationAuditLog,
    new AdminOperationCommandRouter(
      c.var.billingAdminOperationAdapter,
      c.var.serverControlAdminOperationAdapter,
    ),
    c.var.adminOperationNow ?? (() => new Date().toISOString()),
  );
}

operations.use("/v1/admin/*", adminPrincipalAuth());

operations.get("/v1/admin/audit-events", async (c) => {
  try {
    assertAdminPermission(
      c.var.adminPrincipal,
      "read_audit",
      new Date().toISOString(),
    );
    if (!c.var.adminOperationAuditEvents) throw new Error("unavailable");
    return c.json(await c.var.adminOperationAuditEvents());
  } catch (cause) {
    return error(c, cause);
  }
});

operations.get("/v1/admin/metrics", async (c) => {
  try {
    assertAdminPermission(
      c.var.adminPrincipal,
      "read_metrics",
      new Date().toISOString(),
    );
    if (!c.var.adminOperationMetrics) throw new Error("unavailable");
    return c.json(await c.var.adminOperationMetrics.read());
  } catch (cause) {
    return error(c, cause);
  }
});

operations.get("/v1/admin/reconciliation", async (c) => {
  try {
    assertAdminPermission(
      c.var.adminPrincipal,
      "read_reconciliation",
      new Date().toISOString(),
    );
    if (!c.var.adminOperationReconciliation) throw new Error("unavailable");
    return c.json(
      (await c.var.adminOperationReconciliation.latest()) ?? { items: [] },
    );
  } catch (cause) {
    return error(c, cause);
  }
});

operations.get("/v1/admin/accounts/:accountId", async (c) => {
  try {
    assertAdminPermission(
      c.var.adminPrincipal,
      "read_audit",
      new Date().toISOString(),
    );
    if (!c.var.adminOperationAccountReader) throw new Error("unavailable");
    return c.json(
      await c.var.adminOperationAccountReader.read(c.req.param("accountId")),
    );
  } catch (cause) {
    return error(c, cause);
  }
});

async function requestOperation(
  c: Context<AppEnv>,
  action: AdminOperationAction,
  target: { resourceType: string; resourceId: string },
) {
  try {
    const now = new Date().toISOString();
    assertAdminPermission(c.var.adminPrincipal, action, now);
    const operationId = c.req.header("Idempotency-Key");
    const input = await body(c);
    if (
      !operationId || typeof input.reason !== "string" ||
      typeof input.ticketId !== "undefined" &&
        typeof input.ticketId !== "string"
    ) {
      throw new AdminOperationError("invalid_operation");
    }
    const operation = await operationService(c).request({
      operationId,
      action,
      target,
      requestedBy: c.var.adminPrincipal!.id,
      reason: input.reason,
      ticketId: input.ticketId,
    });
    return c.json({
      taskId: operation.operationId,
      requestId: c.req.header("X-Request-Id") ?? operation.operationId,
      status: "queued",
      resource: target,
    }, 202);
  } catch (cause) {
    return error(c, cause);
  }
}

operations.post(
  "/v1/admin/accounts/:accountId/refunds",
  (c) =>
    requestOperation(c, accountAction(c.req.path), {
      resourceType: "account",
      resourceId: c.req.param("accountId"),
    }),
);
operations.post(
  "/v1/admin/accounts/:accountId/balance/adjust",
  (c) =>
    requestOperation(c, accountAction(c.req.path), {
      resourceType: "account",
      resourceId: c.req.param("accountId"),
    }),
);
operations.post(
  "/v1/admin/servers/:serverId/suspend",
  (c) =>
    requestOperation(c, serverAction(c.req.path), {
      resourceType: "server",
      resourceId: c.req.param("serverId"),
    }),
);
operations.post(
  "/v1/admin/servers/:serverId/restore",
  (c) =>
    requestOperation(c, serverAction(c.req.path), {
      resourceType: "server",
      resourceId: c.req.param("serverId"),
    }),
);

operations.post("/v1/admin/operations/:operationId/resolve", async (c) => {
  try {
    assertAdminPermission(
      c.var.adminPrincipal,
      "read_reconciliation",
      new Date().toISOString(),
    );
    const service = operationService(c);
    const resolutionId = c.req.header("Idempotency-Key");
    const input = await body(c);
    if (
      !resolutionId || typeof input.reason !== "string" ||
      typeof input.ticketId !== "undefined" &&
        typeof input.ticketId !== "string"
    ) {
      throw new AdminOperationError("invalid_operation");
    }
    return c.json(
      await service.resolve({
        operationId: c.req.param("operationId"),
        resolutionId,
        reason: input.reason,
        ticketId: input.ticketId,
        actor: { type: "admin", id: c.var.adminPrincipal!.id },
      }),
    );
  } catch (cause) {
    return error(c, cause);
  }
});

export default operations;
