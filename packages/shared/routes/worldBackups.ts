import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import type {
  WorldBackupCreateCommand,
  WorldBackupRestoreEvent,
} from "../lib/worldBackupService.ts";
import { WorldBackupError } from "../lib/worldBackupService.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

const requestId = (c: Context<AppEnv>) =>
  c.req.header("X-Request-Id") ?? crypto.randomUUID();

function accountId(c: Context<AppEnv>) {
  const account = c.get("xmclPrincipal")?.accountId;
  if (!account) {
    throw new AccountError(401, "authentication_required");
  }
  return account;
}

function idempotencyKey(c: Context<AppEnv>) {
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    throw new WorldBackupError(
      "invalid_backup",
      "Idempotency-Key header required",
    );
  }
  return key;
}

function errorResponse(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof WorldBackupError)) throw error;
  const status = ({
    forbidden: 403,
    source_forbidden: 403,
    not_found: 404,
    conflict: 409,
    parent_in_use: 409,
    out_of_order: 409,
    insufficient_balance: 422,
    authorization_unavailable: 503,
    invalid_source: 400,
    invalid_backup: 400,
    upload_verification_failed: 422,
    upload_expired: 422,
  } as const)[error.code];
  return c.json(
    { error: error.code, message: error.message, requestId: requestId(c) },
    status,
  );
}

function service(c: Context<AppEnv>) {
  const value = c.get("worldBackupService");
  if (!value) {
    return c.json({
      error: "m6_adapter_unavailable",
      message: "WorldBackup world-backup adapter is not configured",
      requestId: requestId(c),
    }, 503);
  }
  return value;
}

function publicBackup(
  backup: Awaited<
    ReturnType<
      NonNullable<AppEnv["Variables"]["worldBackupService"]>["get"]
    >
  >,
) {
  const {
    authorizationExpiresAt: _authorizationExpiresAt,
    authorizationId: _authorizationId,
    authorizationRateVersion: _authorizationRateVersion,
    createIdempotencyKey: _createIdempotencyKey,
    lastEventSequence: _lastEventSequence,
    uploadGrant: _uploadGrant,
    ...resource
  } = backup;
  return resource;
}

function parseRestoreEvent(rawBody: string): WorldBackupRestoreEvent {
  try {
    const body: unknown = JSON.parse(rawBody);
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      typeof (body as Record<string, unknown>).eventId !== "string" ||
      !Number.isSafeInteger((body as Record<string, unknown>).sequence) ||
      !["restore_started", "restore_succeeded", "restore_failed"].includes(
        (body as Record<string, unknown>).type as string,
      ) ||
      typeof (body as Record<string, unknown>).occurredAt !== "string"
    ) {
      throw new Error("invalid restore event");
    }
    return body as WorldBackupRestoreEvent;
  } catch {
    throw new WorldBackupError("invalid_backup", "invalid restore event");
  }
}

export function createM6WorldBackupRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const routes = new Hono<AppEnv>();

  routes.onError((error, c) => {
    if (error instanceof AccountError) return handleAccountError(error, c);
    return errorResponse(c, error);
  });

  routes.get(
    "/v1/backup-sources/:sourceType/:sourceId/backups",
    xmclAuth(["account:read"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      return c.json(
        (
          await backups.list(
            accountId(c),
            c.req.param("sourceType"),
            c.req.param("sourceId"),
          )
        ).map(publicBackup),
      );
    },
  );

  routes.post(
    "/v1/backup-sources/:sourceType/:sourceId/backups",
    xmclAuth(["account:write"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        const body = await c.req.json<
          Omit<
            WorldBackupCreateCommand,
            | "accountId"
            | "sourceType"
            | "sourceId"
            | "idempotencyKey"
            | "requestId"
          >
        >();
        const result = await backups.create({
          ...body,
          accountId: accountId(c),
          sourceType: c.req.param(
            "sourceType",
          ) as WorldBackupCreateCommand["sourceType"],
          sourceId: c.req.param("sourceId"),
          idempotencyKey: idempotencyKey(c),
          requestId: requestId(c),
        });
        return c.json(
          {
            backupId: result.backup.backupId,
            taskId: result.task.taskId,
            task: result.task,
          },
          202,
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.get(
    "/v1/world-backups/:backupId",
    xmclAuth(["account:read"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        return c.json(
          publicBackup(
            await backups.get(accountId(c), c.req.param("backupId")),
          ),
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.post(
    "/v1/world-backups/:backupId/upload-url",
    xmclAuth(["account:write"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        idempotencyKey(c);
        const result = await backups.issueUpload(
          accountId(c),
          c.req.param("backupId"),
          requestId(c),
        );
        return c.json({
          taskId: result.task.taskId,
          task: result.task,
          ...result.grant,
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.post(
    "/v1/world-backups/:backupId/complete",
    xmclAuth(["account:write"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        idempotencyKey(c);
        const result = await backups.complete(
          accountId(c),
          c.req.param("backupId"),
          requestId(c),
        );
        return c.json(
          {
            taskId: result.task.taskId,
            task: result.task,
            backup: publicBackup(result.backup),
          },
          202,
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.post(
    "/v1/world-backups/:backupId/restore",
    xmclAuth(["account:write"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        idempotencyKey(c);
        const result = await backups.restore(
          accountId(c),
          c.req.param("backupId"),
          requestId(c),
        );
        return c.json({ taskId: result.task.taskId, task: result.task }, 202);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.delete(
    "/v1/world-backups/:backupId",
    xmclAuth(["account:write"], resolve),
    async (c) => {
      const backups = service(c);
      if (backups instanceof Response) return backups;
      try {
        idempotencyKey(c);
        const result = await backups.delete(
          accountId(c),
          c.req.param("backupId"),
          requestId(c),
        );
        return c.json({ taskId: result.task.taskId, task: result.task }, 202);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  routes.post("/v1/internal/world-backups/:backupId/events", async (c) => {
    const backups = service(c);
    if (backups instanceof Response) return backups;
    const authenticator = c.get("worldBackupRestoreWorkerAuthenticator");
    if (!authenticator) {
      return c.json({
        error: "m6_worker_auth_unavailable",
        message: "WorldBackup restore-worker authentication is not configured",
        requestId: requestId(c),
      }, 503);
    }
    const rawBody = await c.req.raw.text();
    const worker = await authenticator.authenticate({
      authorization: c.req.header("authorization"),
      method: c.req.method,
      path: c.req.path,
      body: rawBody,
      timestamp: c.req.header("x-worker-timestamp"),
      nonce: c.req.header("x-worker-nonce"),
      signature: c.req.header("x-worker-signature"),
    }).catch(() => undefined);
    if (!worker) {
      return c.json({
        error: "worker_authentication_required",
        message: "A verified restore worker scope is required",
        requestId: requestId(c),
      }, 401);
    }
    try {
      const result = await backups.handleRestoreEvent(
        c.req.param("backupId"),
        parseRestoreEvent(rawBody),
        worker,
      );
      return c.json(result, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}

export default createM6WorldBackupRoutes();
