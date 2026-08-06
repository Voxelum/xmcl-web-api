import { Hono } from "hono";
import { AccountError } from "../account.ts";
import { handleAccountError, jsonBody } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import {
  SharedWorldSeedError,
  type SharedWorldSeed,
  type SharedWorldSeedService,
} from "../sharedWorldSeed.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function requireWrite(scopes: readonly string[]) {
  if (!scopes.includes("account:write")) throw new AccountError(403, "insufficient_scope");
}

function publicSeed(seed: SharedWorldSeed) {
  return {
    seedId: seed.seedId,
    serviceId: seed.serviceId,
    status: seed.status,
    worldName: seed.worldName,
    expectedSha256: seed.expectedSha256,
    expectedSizeBytes: seed.expectedSizeBytes,
    files: seed.files,
    validation: seed.validation,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
  };
}

function serviceFor(c: { var: AppEnv["Variables"] }, configured?: SharedWorldSeedService) {
  const service = configured ?? c.var.sharedWorldSeedService;
  if (!service) throw new SharedWorldSeedError("state_conflict");
  return service;
}

export function createSharedWorldSeedRoutes(
  configured?: SharedWorldSeedService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof AccountError) return handleAccountError(error, c);
    if (error instanceof SharedWorldSeedError) {
      const status = error.code === "not_found" ? 404
        : error.code === "invalid_request" ? 400
        : error.code === "idempotency_conflict" || error.code === "state_conflict" ? 409
        : 503;
      return c.json({ error: error.code }, status);
    }
    return c.json({ error: "shared_world_seed_unavailable" }, 503);
  });
  app.use("/v1/shared-hosting/*", xmclAuth(["account:read"], resolve));
  app.post("/v1/shared-hosting/services/:serviceId/world-seeds", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireWrite(principal.scopes);
    const body = await jsonBody(c);
    return c.json(publicSeed(await serviceFor(c, configured).create({
      accountId: principal.accountId,
      serviceId: c.req.param("serviceId"),
      expectedSha256: String(body.expectedSha256 ?? ""),
      expectedSizeBytes: Number(body.expectedSizeBytes),
      idempotencyKey: requireIdempotencyKey(c),
    })), 201);
  });
  app.post("/v1/shared-hosting/world-seeds/:seedId/upload-url", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireWrite(principal.scopes);
    requireIdempotencyKey(c);
    return c.json(await serviceFor(c, configured).uploadUrl(principal.accountId, c.req.param("seedId")));
  });
  app.post("/v1/shared-hosting/world-seeds/:seedId/complete", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireWrite(principal.scopes);
    return c.json(publicSeed(await serviceFor(c, configured).complete(
      principal.accountId, c.req.param("seedId"), requireIdempotencyKey(c),
    )));
  });
  app.get("/v1/shared-hosting/services/:serviceId/world-seeds", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    return c.json((await serviceFor(c, configured).list(
      principal.accountId, c.req.param("serviceId"),
    )).map(publicSeed));
  });
  return app;
}

export default createSharedWorldSeedRoutes();
