import type { Context } from "hono";
import { Hono } from "hono";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import {
  getServerControlRuntime,
  ServerControlRuntimeConfigurationError,
} from "../lib/serverControlRuntime.ts";
import type {
  AccountSessionGateway,
  ServerControlPrincipal,
} from "../lib/serverControlProposals.ts";
import {
  ServerControlError,
  type ServerControlService,
} from "../lib/serverControl.ts";
import type { ServerRecord, ServerTask } from "../lib/serverRepository.ts";
import type { AppEnv } from "../types.ts";

export interface ServerRouteDependencies {
  service: ServerControlService;
  sessions: AccountSessionGateway;
}
export type ServerRouteResolver = (
  context: Context<AppEnv>,
) => Promise<ServerRouteDependencies>;

export async function getMountedServerRouteDependencies(
  context: Context<AppEnv>,
): Promise<ServerRouteDependencies> {
  const [serverControlRuntime, accountRuntime] = [
    getServerControlRuntime(context),
    await getAccountRuntime(context),
  ];
  return {
    service: serverControlRuntime.service,
    sessions: {
      async authenticate(authorization) {
        if (!authorization?.startsWith("Bearer ")) return null;
        try {
          const principal = await accountRuntime.sessions.verify(
            authorization.slice("Bearer ".length),
          );
          return { accountId: principal.accountId, scopes: principal.scopes };
        } catch {
          return null;
        }
      },
    },
  };
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 503;

const generatedRequestIds = new WeakMap<object, string>();

function requestId(c: { req: { header(name: string): string | undefined } }) {
  const supplied = c.req.header("X-Request-Id");
  if (supplied && supplied.length <= 256) return supplied;
  const existing = generatedRequestIds.get(c);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  generatedRequestIds.set(c, generated);
  return generated;
}

function publicServer(server: ServerRecord) {
  return {
    serverId: server.serverId,
    accountId: server.accountId,
    provider: server.provider,
    region: server.region,
    plan: server.plan,
    status: server.status,
    desiredStatus: server.desiredStatus,
    statusVersion: server.statusVersion,
    statusReason: server.statusReason,
    address: server.address,
    leaseId: server.leaseId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

function publicTask(task: ServerTask) {
  return {
    taskId: task.taskId,
    requestId: task.requestId,
    status: task.status,
    operation: task.operation,
    resource: task.resource,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function statusFor(error: ServerControlError): ErrorStatus {
  if (error.code === "not_found") return 404;
  if (
    error.code === "conflict" || error.code === "idempotency_conflict" ||
    error.code === "deletion_blocked"
  ) return 409;
  if (error.code === "insufficient_balance") return 422;
  if (error.code === "forbidden") return 403;
  if (
    error.code === "provider_unavailable" ||
    error.code === "provider_unknown"
  ) return 503;
  return 400;
}

async function principal(
  dependencies: ServerRouteDependencies,
  authorization: string | undefined,
  scope: "servers:read" | "servers:control" | "tasks:read",
) {
  const value = await dependencies.sessions.authenticate(authorization);
  if (!value) {
    throw new ServerControlError("forbidden", "XMCL account session required");
  }
  const accountScope = scope === "servers:control"
    ? "account:write"
    : "account:read";
  if (
    !value.scopes.includes(scope) && !value.scopes.includes("servers:*") &&
    !value.scopes.includes(accountScope)
  ) {
    throw new ServerControlError("forbidden", `scope ${scope} is required`);
  }
  return value;
}

function idempotencyKey(
  header: string | undefined,
): string {
  if (!header) {
    throw new ServerControlError(
      "invalid_request",
      "Idempotency-Key header is required",
    );
  }
  return header;
}

function errorResponse(
  c: {
    json: (
      body: unknown,
      status: ErrorStatus,
    ) => Response;
    req: { header(name: string): string | undefined };
  },
  cause: unknown,
) {
  const id = requestId(c);
  if (cause instanceof ServerControlRuntimeConfigurationError) {
    return c.json({
      error: "m4_runtime_unavailable",
      message: cause.message,
      requestId: id,
    }, 503);
  }
  if (cause instanceof ServerControlError) {
    const missingSession = cause.code === "forbidden" &&
      cause.message === "XMCL account session required";
    return c.json({
      error: cause.code,
      message: cause.message,
      requestId: id,
    }, missingSession ? 401 : statusFor(cause));
  }
  return c.json({
    error: "m4_unavailable",
    message: "Server control is temporarily unavailable",
    requestId: id,
  }, 503);
}

async function withPrincipal<T>(
  dependencies: ServerRouteDependencies,
  c: {
    req: { header(name: string): string | undefined };
  },
  scope: "servers:read" | "servers:control" | "tasks:read",
  action: (principal: ServerControlPrincipal) => Promise<T>,
) {
  const identity = await principal(
    dependencies,
    c.req.header("Authorization"),
    scope,
  );
  return await action(identity);
}

export function createServerRoutes(
  configured: ServerRouteDependencies | ServerRouteResolver =
    getMountedServerRouteDependencies,
) {
  const routes = new Hono<AppEnv>();
  const resolve: ServerRouteResolver = typeof configured === "function"
    ? configured
    : () => Promise.resolve(configured);

  routes.get("/v1/servers", async (c) => {
    try {
      const dependencies = await resolve(c);
      const servers = await withPrincipal(
        dependencies,
        c,
        "servers:read",
        (identity) => dependencies.service.list(identity.accountId),
      );
      return c.json(servers.map(publicServer));
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  routes.post("/v1/servers", async (c) => {
    try {
      const dependencies = await resolve(c);
      const identity = await principal(
        dependencies,
        c.req.header("Authorization"),
        "servers:control",
      );
      const body = await c.req.json().catch(() => undefined) as
        | { plan?: unknown }
        | undefined;
      if (typeof body?.plan !== "string") {
        throw new ServerControlError("invalid_request", "plan is required");
      }
      const task = await dependencies.service.create(identity.accountId, {
        plan: body.plan,
      }, {
        idempotencyKey: idempotencyKey(
          c.req.header("Idempotency-Key"),
        ),
        requestId: requestId(c),
      });
      return c.json(publicTask(task), 202);
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  routes.get("/v1/servers/:serverId", async (c) => {
    try {
      const dependencies = await resolve(c);
      const server = await withPrincipal(
        dependencies,
        c,
        "servers:read",
        (identity) =>
          dependencies.service.get(
            identity.accountId,
            c.req.param("serverId"),
          ),
      );
      return c.json(publicServer(server));
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  for (
    const operation of [
      "start",
      "stop",
      "restart",
      "archive",
      "restore",
    ] as const
  ) {
    routes.post(`/v1/servers/:serverId/${operation}`, async (c) => {
      try {
        const dependencies = await resolve(c);
        const task = await withPrincipal(
          dependencies,
          c,
          "servers:control",
          (identity) =>
            dependencies.service[operation](
              identity.accountId,
              c.req.param("serverId"),
              {
                idempotencyKey: idempotencyKey(
                  c.req.header("Idempotency-Key"),
                ),
                requestId: requestId(c),
              },
            ),
        );
        return c.json(publicTask(task), 202);
      } catch (cause) {
        return errorResponse(c, cause);
      }
    });
  }

  routes.delete("/v1/servers/:serverId", async (c) => {
    try {
      const dependencies = await resolve(c);
      const task = await withPrincipal(
        dependencies,
        c,
        "servers:control",
        (identity) =>
          dependencies.service.delete(
            identity.accountId,
            c.req.param("serverId"),
            {
              idempotencyKey: idempotencyKey(
                c.req.header("Idempotency-Key"),
              ),
              requestId: requestId(c),
            },
          ),
      );
      return c.json(publicTask(task), 202);
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  routes.get("/v1/tasks/:taskId", async (c) => {
    try {
      const dependencies = await resolve(c);
      const task = await withPrincipal(
        dependencies,
        c,
        "tasks:read",
        (identity) =>
          dependencies.service.getTask(
            identity.accountId,
            c.req.param("taskId"),
          ),
      );
      return c.json(publicTask(task));
    } catch (cause) {
      return errorResponse(c, cause);
    }
  });

  routes.onError((cause, c) => {
    if (cause instanceof ServerControlRuntimeConfigurationError) {
      return c.json({
        error: "m4_runtime_unavailable",
        message: cause.message,
        requestId: requestId(c),
      }, 503);
    }
    return errorResponse(c, cause);
  });
  return routes;
}

export default createServerRoutes();
