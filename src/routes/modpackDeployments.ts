import type { Context } from "hono";
import { Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import {
  type ApiError,
  ModpackDeploymentCoordinator,
  ModpackDeploymentError,
} from "../lib/deploymentTasks.ts";
import {
  type AccountRuntimeResolver,
  xmclAuth,
} from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

export interface ModpackDeploymentRouteDependencies {
  coordinator: ModpackDeploymentCoordinator;
}

export type ModpackDeploymentRouteResolver = (
  context: Context<AppEnv>,
) => Promise<ModpackDeploymentRouteDependencies>;

export class ModpackDeploymentRouteConfigurationError extends Error {
  constructor(readonly missing: "m9_runtime" | "m4_target" | "m5_staging") {
    super(
      `ModpackDeployment modpack deployment is not configured: missing ${missing}`,
    );
  }
}

/**
 * ModpackDeployment owns its durable runtime. The only cross-module route injections are the
 * ServerControl target projection and Worker staging adapter; authentication is always Account.
 */
export function getMountedModpackDeploymentDependencies(
  context: Context<AppEnv>,
): Promise<ModpackDeploymentRouteDependencies> {
  const runtime = context.get("modpackDeploymentRuntime");
  if (!runtime) {
    throw new ModpackDeploymentRouteConfigurationError("m9_runtime");
  }
  const serverControlTarget = context.get(
    "modpackDeploymentServerControlTarget",
  );
  if (!serverControlTarget) {
    throw new ModpackDeploymentRouteConfigurationError("m4_target");
  }
  const workerStaging = context.get("modpackDeploymentWorkerStaging");
  if (!workerStaging) {
    throw new ModpackDeploymentRouteConfigurationError("m5_staging");
  }
  return Promise.resolve({
    coordinator: runtime.createCoordinator({
      serverControlTarget,
      workerStaging,
    }),
  });
}

function requestId(candidate: string | undefined) {
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function apiError(
  error: string,
  message: string,
  requestId: string,
  details?: unknown,
): ApiError {
  return {
    error,
    message,
    requestId,
    ...(details === undefined ? {} : { details }),
  };
}

function requireIdempotencyKey(value: string | undefined) {
  if (
    !value || value.length > 255 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new ModpackDeploymentError("invalid_request", {
      field: "Idempotency-Key",
    });
  }
  return value;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ModpackDeploymentError("invalid_request", { field: "body" });
  }
}

function requiredString(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ModpackDeploymentError("invalid_request", { field });
  }
  return value;
}

export function createModpackDeploymentRoutes(
  configured:
    | ModpackDeploymentRouteDependencies
    | ModpackDeploymentRouteResolver = getMountedModpackDeploymentDependencies,
  resolveM1: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  const resolve: ModpackDeploymentRouteResolver =
    typeof configured === "function"
      ? configured
      : () => Promise.resolve(configured);

  app.post(
    "/v1/servers/:serverId/modpack-imports",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const body = await jsonObject(c.req.raw);
      const sourceFormat = requiredString(body, "sourceFormat");
      if (sourceFormat !== "mrpack" && sourceFormat !== "curseforge_zip") {
        throw new ModpackDeploymentError("invalid_request", {
          field: "sourceFormat",
        });
      }
      const expectedSizeBytes = body.expectedSizeBytes;
      if (!Number.isSafeInteger(expectedSizeBytes)) {
        throw new ModpackDeploymentError("invalid_request", {
          field: "expectedSizeBytes",
        });
      }
      const imported = await (await resolve(c)).coordinator.createImport({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        serverId: c.req.param("serverId"),
        sourceFormat,
        expectedSha256: requiredString(body, "expectedSha256"),
        expectedSizeBytes: expectedSizeBytes as number,
      });
      return c.json(imported, 201);
    },
  );

  app.post(
    "/v1/modpack-imports/:importId/upload-url",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireIdempotencyKey(c.req.header("Idempotency-Key"));
      return c.json(
        await (await resolve(c)).coordinator.createUpload({
          principal,
          importId: c.req.param("importId"),
        }),
      );
    },
  );

  app.post(
    "/v1/modpack-imports/:importId/complete",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const result = await (await resolve(c)).coordinator.completeImport({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        importId: c.req.param("importId"),
      });
      return c.json(result.task, 202);
    },
  );

  app.get(
    "/v1/modpack-imports/:importId",
    xmclAuth(["modpack:read"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      return c.json(
        await (await resolve(c)).coordinator.getImport(
          principal,
          c.req.param("importId"),
        ),
      );
    },
  );

  app.get(
    "/v1/modpack-imports/:importId/validation",
    xmclAuth(["modpack:read"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const imported = await (await resolve(c)).coordinator.getImport(
        principal,
        c.req.param("importId"),
      );
      if (!imported.validation) {
        throw new ModpackDeploymentError("state_conflict");
      }
      return c.json(imported.validation);
    },
  );

  app.post(
    "/v1/servers/:serverId/modpack-deployments",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const body = await jsonObject(c.req.raw);
      const result = await (await resolve(c)).coordinator.createDeployment({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        serverId: c.req.param("serverId"),
        importId: requiredString(body, "importId"),
      });
      return c.json(result.task, 202);
    },
  );

  app.get(
    "/v1/servers/:serverId/modpack-deployments",
    xmclAuth(["modpack:read"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      return c.json({
        items: await (await resolve(c)).coordinator.listDeployments(
          principal,
          c.req.param("serverId"),
        ),
      });
    },
  );

  app.get(
    "/v1/modpack-deployments/:deploymentId",
    xmclAuth(["modpack:read"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      return c.json(
        await (await resolve(c)).coordinator.getDeployment(
          principal,
          c.req.param("deploymentId"),
        ),
      );
    },
  );

  app.post(
    "/v1/modpack-deployments/:deploymentId/preview",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const result = await (await resolve(c)).coordinator.preview({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        deploymentId: c.req.param("deploymentId"),
      });
      return c.json(result.task, 202);
    },
  );

  app.post(
    "/v1/modpack-deployments/:deploymentId/apply",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const body = await jsonObject(c.req.raw);
      const result = await (await resolve(c)).coordinator.apply({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        deploymentId: c.req.param("deploymentId"),
        manifestSha256: requiredString(body, "manifestSha256"),
      });
      return c.json(result.task, 202);
    },
  );

  app.post(
    "/v1/modpack-deployments/:deploymentId/rollback",
    xmclAuth(["modpack:write"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const result = await (await resolve(c)).coordinator.rollback({
        principal,
        requestId: requestId(c.req.header("X-Request-Id")),
        idempotencyKey: requireIdempotencyKey(c.req.header("Idempotency-Key")),
        deploymentId: c.req.param("deploymentId"),
      });
      return c.json(result.task, 202);
    },
  );

  app.get(
    "/v1/modpack-tasks/:taskId",
    xmclAuth(["modpack:read"], resolveM1),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      return c.json(
        await (await resolve(c)).coordinator.getTask(
          principal,
          c.req.param("taskId"),
        ),
      );
    },
  );

  app.onError((error, c) => {
    if (error instanceof AccountError) return handleAccountError(error, c);
    const correlationId = requestId(c.req.header("X-Request-Id"));
    if (error instanceof ModpackDeploymentRouteConfigurationError) {
      return c.json(
        apiError(
          "m9_configuration_error",
          error.message,
          correlationId,
          { missing: error.missing },
        ),
        503,
      );
    }
    if (error instanceof ModpackDeploymentError) {
      const status = error.code === "forbidden"
        ? 403
        : error.code === "not_found"
        ? 404
        : error.code === "invalid_request"
        ? 400
        : 409;
      return c.json(
        apiError(error.code, error.message, correlationId, error.details),
        status,
      );
    }
    return c.json(
      apiError(
        "m9_unavailable",
        "Modpack deployment is temporarily unavailable.",
        correlationId,
      ),
      503,
    );
  });

  return app;
}

export default createModpackDeploymentRoutes();
