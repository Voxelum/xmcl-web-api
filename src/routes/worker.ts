import { type Context, Hono } from "hono";
import type { AppEnv } from "../types.ts";
import {
  WorkerAuthError,
  type WorkerPrincipal,
  WorkerRequestAuthenticator,
} from "../lib/workerAuth.ts";
import {
  type WorkerOperationKind,
  WorkerRuntimeError,
  WorkerRuntimeService,
} from "../lib/worker/service.ts";
import {
  getWorkerRuntime,
  WorkerRuntimeConfigurationError,
  type WorkerRuntimeResolver,
} from "../lib/worker/runtime.ts";

export interface WorkerRouteDependencies {
  authenticator: WorkerRequestAuthenticator;
  service: WorkerRuntimeService;
  requestId?: () => string;
}

export function createWorkerRoutes(
  configured: WorkerRouteDependencies | WorkerRuntimeResolver =
    getWorkerRuntime,
) {
  const app = new Hono<AppEnv>();
  const staticDependencies = typeof configured === "function"
    ? undefined
    : configured;
  const resolve: WorkerRuntimeResolver = typeof configured === "function"
    ? configured
    : () => Promise.resolve(configured);

  app.post("/v1/internal/servers/:serverId/worker/register", async (c) => {
    const dependencies = await resolve(c);
    const rawBody = await c.req.raw.text();
    const body = parseJson(rawBody);
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Worker-Bootstrap (.+)$/.exec(authorization);
    if (!match) throw new WorkerAuthError("unauthorized");
    const serverId = c.req.param("serverId");
    const leaseId = field(body, "leaseId");
    await dependencies.authenticator.authenticateBootstrap(match[1], {
      method: c.req.method,
      path: c.req.path,
      body: rawBody,
      timestamp: c.req.header("x-worker-timestamp"),
      nonce: c.req.header("x-worker-nonce"),
      signature: c.req.header("x-worker-signature"),
      serverId,
      leaseId,
    });
    const result = await dependencies.service.register({
      serverId,
      leaseId,
      workerId: field(body, "workerId"),
      credential: match[1],
    });
    return c.json(result, 201);
  });

  app.post("/v1/internal/servers/:serverId/worker/heartbeat", async (c) => {
    const dependencies = await resolve(c);
    const { body, principal } = await authenticate(
      c,
      c.req.param("serverId"),
      dependencies,
    );
    return c.json(await dependencies.service.heartbeat(principal, body));
  });

  app.post("/v1/internal/servers/:serverId/worker/events", async (c) => {
    const dependencies = await resolve(c);
    const { body, principal } = await authenticate(
      c,
      c.req.param("serverId"),
      dependencies,
    );
    return c.json(
      await dependencies.service.runtimeEvent(principal, body),
      202,
    );
  });

  app.post("/v1/internal/servers/:serverId/worker/usage", async (c) => {
    const dependencies = await resolve(c);
    const { body, principal } = await authenticate(
      c,
      c.req.param("serverId"),
      dependencies,
    );
    return c.json(await dependencies.service.usage(principal, body));
  });

  app.post("/v1/internal/servers/:serverId/worker/logs", async (c) => {
    const dependencies = await resolve(c);
    const { body, principal } = await authenticate(
      c,
      c.req.param("serverId"),
      dependencies,
    );
    return c.json(await dependencies.service.logs(principal, body), 202);
  });

  const operations: Array<[string, WorkerOperationKind]> = [
    ["backup/export", "backup.export"],
    ["backup/restore", "backup.restore"],
    ["backup/events", "backup.event"],
    ["modpack/prepare", "modpack.prepare"],
    ["modpack/apply", "modpack.apply"],
    ["modpack/events", "modpack.event"],
  ];
  for (const [path, kind] of operations) {
    app.post(`/v1/internal/servers/:serverId/worker/${path}`, async (c) => {
      const dependencies = await resolve(c);
      const { body, principal } = await authenticate(
        c,
        c.req.param("serverId"),
        dependencies,
      );
      return c.json(
        await dependencies.service.operation(principal, kind, body),
        202,
      );
    });
  }

  app.onError((error, c) => {
    const requestId = c.req.header("x-request-id") ??
      staticDependencies?.requestId?.() ?? crypto.randomUUID();
    if (error instanceof WorkerRuntimeConfigurationError) {
      return c.json({
        error: "m5_runtime_unavailable",
        message: error.message,
        requestId,
      }, 503);
    }
    if (error instanceof WorkerAuthError) {
      const status =
        error.code === "replay_detected" || error.code === "lease_conflict"
          ? 409
          : 401;
      return c.json({
        error: error.code,
        message: error.message,
        requestId,
        action: "registration_required",
      }, status);
    }
    if (error instanceof WorkerRuntimeError) {
      const status = error.code === "unauthorized"
        ? 401
        : error.code === "invalid_request"
        ? 400
        : error.code === "settlement_unavailable"
        ? 503
        : 409;
      return c.json({
        error: error.code,
        message: error.message,
        requestId,
        ...(status === 401 || status === 409
          ? { action: "registration_required" }
          : {}),
      }, status);
    }
    return c.json({
      error: "worker_provider_unavailable",
      message: error instanceof Error
        ? error.message
        : "Unknown worker provider failure",
      requestId,
    }, 503);
  });

  return app;
}

async function authenticate(
  context: Context<AppEnv>,
  serverId: string,
  dependencies: WorkerRouteDependencies,
): Promise<{ body: Record<string, unknown>; principal: WorkerPrincipal }> {
  const request = context.req.raw;
  const rawBody = await request.text();
  const body = parseJson(rawBody);
  const leaseId = field(body, "leaseId");
  const principal = await dependencies.authenticator.authenticate({
    method: request.method,
    path: new URL(request.url).pathname,
    body: rawBody,
    authorization: request.headers.get("authorization") ?? undefined,
    timestamp: request.headers.get("x-worker-timestamp") ?? undefined,
    nonce: request.headers.get("x-worker-nonce") ?? undefined,
    signature: request.headers.get("x-worker-signature") ?? undefined,
    serverId,
    leaseId,
  });
  return { body, principal };
}

function parseJson(rawBody: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(rawBody);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Converted to the stable worker API error below.
  }
  throw new WorkerRuntimeError("invalid_request");
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkerRuntimeError("invalid_request");
  }
  return value;
}

export default createWorkerRoutes();
