import { Hono } from "hono";
import { AccountError } from "../account.ts";
import { handleAccountError, jsonBody } from "../accountHttp.ts";
import {
  type CompilerGrantAuthority,
  type RuntimeDescriptor,
  SharedModdedRuntimeError,
  type SharedModdedRuntimeService,
  type SharedRuntimeContentDescriptor,
} from "../sharedModdedRuntime.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

function requireWrite(scopes: readonly string[]) {
  if (!scopes.includes("modpack:write")) {
    throw new AccountError(403, "insufficient_scope");
  }
}

function requireIdempotencyKey(
  c: { req: { header(name: string): string | undefined } },
) {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 255) {
    throw new AccountError(422, "idempotency_key_required");
  }
  return key;
}

function requiredString(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new SharedModdedRuntimeError("invalid_request", { field: name });
  }
  return value;
}

function runtimeFor(
  c: { var: AppEnv["Variables"] },
  configured?: SharedModdedRuntimeService,
) {
  const runtime = configured ?? c.var.sharedModdedRuntime;
  if (!runtime) throw new SharedModdedRuntimeError("compiler_unavailable");
  return runtime;
}

function publicImport(
  value: Awaited<ReturnType<SharedModdedRuntimeService["getImport"]>>,
) {
  return {
    importId: value.importId,
    serviceId: value.serviceId,
    sourceFormat: value.sourceFormat,
    status: value.status,
    validation: value.validation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicDeployment(
  value: Awaited<ReturnType<SharedModdedRuntimeService["getDeployment"]>>,
) {
  return {
    deploymentId: value.deploymentId,
    serviceId: value.serviceId,
    importId: value.importId,
    manifestSha256: value.manifestSha256,
    status: value.status,
    contentSha256: value.content?.sha256,
    descriptor: value.descriptor,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createSharedModdedRuntimeRoutes(
  configured?: SharedModdedRuntimeService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof AccountError) return handleAccountError(error, c);
    if (error instanceof SharedModdedRuntimeError) {
      const status = error.code === "not_found"
        ? 404
        : error.code === "forbidden"
        ? 403
        : error.code === "compiler_unavailable"
        ? 503
        : error.code === "invalid_request" || error.code === "content_invalid"
        ? 400
        : 409;
      return c.json({ error: error.code, details: error.details }, status);
    }
    return c.json({ error: "shared_modded_runtime_unavailable" }, 503);
  });
  app.use(
    "/v1/shared-hosting/*",
    xmclAuth(["account:read"], resolve),
  );
  app.post(
    "/v1/shared-hosting/services/:serviceId/runtime-terms-acceptance",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      const body = await jsonBody(c);
      if (
        Object.keys(body).length !== 1 ||
        body.accepted !== true
      ) {
        throw new SharedModdedRuntimeError("invalid_request", {
          field: "accepted",
        });
      }
      return c.json(
        await runtimeFor(c, configured).acceptTerms(
          principal.accountId,
          c.req.param("serviceId"),
        ),
        201,
      );
    },
  );
  app.post(
    "/v1/shared-hosting/services/:serviceId/modpack-imports",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      const body = await jsonBody(c);
      const sourceFormat = requiredString(body, "sourceFormat");
      if (
        sourceFormat !== "mrpack" &&
        sourceFormat !== "curseforge_zip" &&
        sourceFormat !== "xmcl_server_bundle"
      ) {
        throw new SharedModdedRuntimeError("invalid_request", {
          field: "sourceFormat",
        });
      }
      const result = await runtimeFor(c, configured).createImport({
        accountId: principal.accountId,
        serviceId: c.req.param("serviceId"),
        sourceFormat,
        expectedSha256: requiredString(body, "expectedSha256"),
        expectedSizeBytes: Number(body.expectedSizeBytes),
        idempotencyKey: requireIdempotencyKey(c),
      });
      return c.json(publicImport(result), 201);
    },
  );
  app.post(
    "/v1/shared-hosting/modpack-imports/:importId/upload-url",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      requireIdempotencyKey(c);
      return c.json(
        await runtimeFor(c, configured).uploadUrl(
          principal.accountId,
          c.req.param("importId"),
        ),
      );
    },
  );
  app.post(
    "/v1/shared-hosting/modpack-imports/:importId/complete",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      requireIdempotencyKey(c);
      return c.json(publicImport(
        await runtimeFor(c, configured).completeImport(
          principal.accountId,
          c.req.param("importId"),
        ),
      ));
    },
  );
  app.post(
    "/v1/shared-hosting/services/:serviceId/modpack-deployments",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      const body = await jsonBody(c);
      const result = await runtimeFor(c, configured).createDeployment({
        accountId: principal.accountId,
        serviceId: c.req.param("serviceId"),
        importId: requiredString(body, "importId"),
        idempotencyKey: requireIdempotencyKey(c),
      });
      return c.json(publicDeployment(result), 202);
    },
  );
  app.get(
    "/v1/shared-hosting/services/:serviceId/modpack-deployments",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const items = await runtimeFor(c, configured).listDeployments(
        principal.accountId,
        c.req.param("serviceId"),
      );
      return c.json({ items: items.map(publicDeployment) });
    },
  );
  app.post(
    "/v1/shared-hosting/modpack-deployments/:deploymentId/apply",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      return c.json(
        publicDeployment(
          await runtimeFor(c, configured).apply(
            principal.accountId,
            c.req.param("deploymentId"),
            requireIdempotencyKey(c),
          ),
        ),
        202,
      );
    },
  );
  app.post(
    "/v1/shared-hosting/services/:serviceId/modpack-deployments/:deploymentId/rollback",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireWrite(principal.scopes);
      return c.json(
        publicDeployment(
          await runtimeFor(c, configured).rollback({
            accountId: principal.accountId,
            serviceId: c.req.param("serviceId"),
            deploymentId: c.req.param("deploymentId"),
            idempotencyKey: requireIdempotencyKey(c),
          }),
        ),
        202,
      );
    },
  );
  return app;
}

/**
 * The compiler callback is mounted separately from account routes. Production
 * composition must inject an authenticator; absence is a hard 503, never a
 * permissive callback.
 */
export function createSharedModdedCompilerRoutes(
  configured?: SharedModdedRuntimeService,
  grants?: CompilerGrantAuthority,
) {
  const app = new Hono<AppEnv>();
  app.post(
    "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/grants",
    async (c) => {
      const identity = c.get("sharedModdedCompilerPrincipal");
      if (!identity) return c.json({ error: "unauthorized" }, 401);
      const authority = grants ?? c.get("sharedModdedCompilerGrants");
      if (!authority) return c.json({ error: "compiler_unavailable" }, 503);
      try {
        const body = await compilerBody(c);
        const compilerRequestId = compilerCallbackHeader(
          body,
          ["schemaVersion", "compilerRequestId", "deploymentId"],
          c.req.param("deploymentId"),
        );
        return c.json(
          await runtimeFor(c, configured).compilerGrants({
            deploymentId: c.req.param("deploymentId"),
            compilerRequestId,
            authority,
          }),
        );
      } catch (error) {
        return compilerError(error, c);
      }
    },
  );
  app.post(
    "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/upload-prepared",
    async (c) => {
      const identity = c.get("sharedModdedCompilerPrincipal");
      if (!identity) return c.json({ error: "unauthorized" }, 401);
      const authority = grants ?? c.get("sharedModdedCompilerGrants");
      if (!authority) return c.json({ error: "compiler_unavailable" }, 503);
      try {
        const body = await compilerBody(c);
        const compilerRequestId = compilerCallbackHeader(
          body,
          [
            "schemaVersion",
            "status",
            "compilerRequestId",
            "deploymentId",
            "manifestSha256",
            "content",
            "descriptor",
          ],
          c.req.param("deploymentId"),
          "upload_prepared",
        );
        const content = body.content;
        if (!content || typeof content !== "object" || Array.isArray(content)) {
          throw new SharedModdedRuntimeError("invalid_request", { field: "content" });
        }
        const runtime = runtimeFor(c, configured);
        const prepared = await runtime.prepareCompilerUpload({
          deploymentId: c.req.param("deploymentId"),
          compilerRequestId,
          manifestSha256: requiredString(body, "manifestSha256"),
          content: content as SharedRuntimeContentDescriptor,
          descriptor: body.descriptor as RuntimeDescriptor,
        });
        const reconciliation = await runtime.compilerReconciliationGrant({
          binding: prepared.binding,
          authority,
        });
        return c.json({
          schemaVersion: 1,
          status: prepared.existing ? "upload_existing" : "upload_prepared",
          compilerRequestId: prepared.binding.compilerRequestId,
          deploymentId: prepared.binding.deploymentId,
          manifestSha256: prepared.binding.manifestSha256,
          content: prepared.binding.content,
          descriptor: prepared.binding.descriptor,
          reconciliation,
        });
      } catch (error) {
        return compilerError(error, c);
      }
    },
  );
  app.post(
    "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/published",
    async (c) => {
      const identity = c.get("sharedModdedCompilerPrincipal");
      if (!identity) return c.json({ error: "unauthorized" }, 401);
      try {
        const body = await compilerBody(c);
        const compilerRequestId = compilerCallbackHeader(
          body,
          [
            "schemaVersion",
            "status",
            "compilerRequestId",
            "deploymentId",
            "manifestSha256",
            "content",
            "descriptor",
          ],
          c.req.param("deploymentId"),
          "published",
        );
        const content = body.content;
        if (!content || typeof content !== "object" || Array.isArray(content)) {
          throw new SharedModdedRuntimeError("invalid_request", {
            field: "content",
          });
        }
        return c.json(
          await runtimeFor(c, configured).publishCompilerResult({
            deploymentId: c.req.param("deploymentId"),
            compilerRequestId,
            manifestSha256: requiredString(body, "manifestSha256"),
            content: content as SharedRuntimeContentDescriptor,
            descriptor: body.descriptor as RuntimeDescriptor,
          }),
        );
      } catch (error) {
        return compilerError(error, c);
      }
    },
  );
  app.post(
    "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/failed",
    async (c) => {
      const identity = c.get("sharedModdedCompilerPrincipal");
      if (!identity) return c.json({ error: "unauthorized" }, 401);
      try {
        const body = await compilerBody(c);
        const compilerRequestId = compilerCallbackHeader(
          body,
          [
            "schemaVersion",
            "status",
            "compilerRequestId",
            "deploymentId",
            "manifestSha256",
            "code",
          ],
          c.req.param("deploymentId"),
          "failed",
        );
        const code = requiredString(body, "code");
        if (
          code !== "unsupported_compatibility" &&
          code !== "compiler_unavailable" &&
          code !== "compiler_failed"
        ) {
          throw new SharedModdedRuntimeError("invalid_request", { field: "code" });
        }
        return c.json(
          await runtimeFor(c, configured).reportCompilerFailure({
            deploymentId: c.req.param("deploymentId"),
            compilerRequestId,
            manifestSha256: requiredString(body, "manifestSha256"),
            code,
          }),
        );
      } catch (error) {
        return compilerError(error, c);
      }

    },
  );
  return app;
}

async function compilerBody(c: {
  get(name: "sharedModdedCompilerRawBody"): Uint8Array | undefined;
  req: { raw: Request };
}) {
  const raw = c.get("sharedModdedCompilerRawBody") ??
    new Uint8Array(await c.req.raw.arrayBuffer());
  if (raw.byteLength > 4 * 1024 * 1024) {
    throw new SharedModdedRuntimeError("invalid_request");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new SharedModdedRuntimeError("invalid_request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SharedModdedRuntimeError("invalid_request");
  }
  return body as Record<string, unknown>;
}

function compilerCallbackHeader(
  body: Record<string, unknown>,
  keys: readonly string[],
  deploymentId: string,
  status?: "published" | "failed" | "upload_prepared",
) {
  if (
    body.schemaVersion !== 1 ||
    Object.keys(body).length !== keys.length ||
    Object.keys(body).some((key) => !keys.includes(key)) ||
    body.deploymentId !== deploymentId ||
    (status !== undefined && body.status !== status) ||
    typeof body.compilerRequestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(body.compilerRequestId)
  ) {
    throw new SharedModdedRuntimeError("invalid_request");
  }
  return body.compilerRequestId;
}

function compilerError(
  error: unknown,
  c: { json: (value: unknown, status?: number) => Response },
) {
  const status = error instanceof SharedModdedRuntimeError &&
      error.code === "not_found"
    ? 404
    : error instanceof SharedModdedRuntimeError &&
        error.code === "compiler_unavailable"
    ? 503
    : 400;
  return c.json({
    error: error instanceof SharedModdedRuntimeError
      ? error.code
      : "compiler_callback_invalid",
  }, status);
}

export default createSharedModdedRuntimeRoutes();
