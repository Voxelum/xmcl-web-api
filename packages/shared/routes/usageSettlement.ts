import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import type {
  CanonicalUsageEvent,
  UsageAuthorizationRequest,
  UsageSettlementService,
} from "../lib/usageSettlement.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function exactFields(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const permitted = new Set([...required, ...optional]);
  if (
    required.some((field) => body[field] === undefined) ||
    Object.keys(body).some((field) => !permitted.has(field))
  ) {
    throw new AccountError(422, "invalid_usage_payload");
  }
}

function headerMatchesBody(
  c: { req: { header(name: string): string | undefined } },
  body: Record<string, unknown>,
) {
  const key = requireIdempotencyKey(c);
  if (body.idempotencyKey !== key) {
    throw new AccountError(422, "idempotency_key_mismatch");
  }
}

export function createUsageSettlementRoutes(
  usage?: UsageSettlementService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/internal/usage/*", xmclAuth(["billing:internal"], resolve));

  app.post("/v1/internal/usage/authorize", async (c) => {
    const body = await jsonBody(c);
    exactFields(body, [
      "accountId",
      "resource",
      "sourceId",
      "expectedQuantity",
      "unit",
      "settlementIntervalSeconds",
      "rateVersion",
      "idempotencyKey",
      "expiresAt",
    ]);
    headerMatchesBody(c, body);
    return c.json(
      await usageFor(c, usage).authorize(
        c.get("xmclPrincipal")!.accountId,
        body as unknown as UsageAuthorizationRequest,
      ),
    );
  });
  app.post("/v1/internal/usage/release", async (c) => {
    const body = await jsonBody(c);
    exactFields(body, ["authorizationId"]);
    return c.json(
      await usageFor(c, usage).release(
        c.get("xmclPrincipal")!.accountId,
        String(body.authorizationId),
        requireIdempotencyKey(c),
      ),
    );
  });
  app.post("/v1/internal/usage/settle", async (c) => {
    const body = await jsonBody(c);
    exactFields(body, [
      "eventType",
      "eventId",
      "schemaVersion",
      "accountId",
      "authorizationId",
      "resource",
      "sourceId",
      "quantity",
      "unit",
      "rateVersion",
      "intervalStart",
      "intervalEnd",
      "occurredAt",
      "idempotencyKey",
    ], ["sequence"]);
    headerMatchesBody(c, body);
    return c.json(
      await usageFor(c, usage).settle(
        c.get("xmclPrincipal")!.accountId,
        body as unknown as CanonicalUsageEvent,
      ),
    );
  });
  return app;
}

function usageFor(c: Context<AppEnv>, injected?: UsageSettlementService) {
  const service = injected ?? c.var.usageSettlementService;
  if (!service) throw new AccountError(503, "billing_unavailable");
  return service;
}

export default createUsageSettlementRoutes();
