import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import { getBillingRuntime } from "../lib/billingRuntime.ts";
import type { BillingService } from "../lib/billing.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

export function createBillingRoutes(
  billing?: BillingService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/billing/*", xmclAuth([], resolve));

  app.get(
    "/v1/billing/balance",
    async (c) =>
      c.json(
        await (await billingFor(c, billing)).balance(
          c.get("xmclPrincipal")!.accountId,
        ),
      ),
  );
  app.get(
    "/v1/billing/rates",
    async (c) => c.json((await billingFor(c, billing)).listRates()),
  );
  app.get(
    "/v1/billing/orders",
    async (c) =>
      c.json(
        await (await billingFor(c, billing)).orders(
          c.get("xmclPrincipal")!.accountId,
        ),
      ),
  );
  app.get(
    "/v1/billing/orders/:orderId",
    async (c) =>
      c.json(
        await (await billingFor(c, billing)).order(
          c.get("xmclPrincipal")!.accountId,
          c.req.param("orderId"),
        ),
      ),
  );
  app.get(
    "/v1/billing/ledger",
    async (c) =>
      c.json({
        items: await (await billingFor(c, billing)).ledger(
          c.get("xmclPrincipal")!.accountId,
        ),
      }),
  );
  app.get(
    "/v1/billing/usage",
    async (c) =>
      c.json({
        items: await (await billingFor(c, billing)).usage(
          c.get("xmclPrincipal")!.accountId,
        ),
      }),
  );
  return app;
}

async function billingFor(c: Context<AppEnv>, injected?: BillingService) {
  const service = injected ?? c.var.billingService;
  if (service) return service;
  try {
    return (await getBillingRuntime(c)).billing;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(503, "billing_unavailable");
  }
}

export function requireIdempotencyKey(
  c: { req: { header(name: string): string | undefined } },
) {
  const key = c.req.header("idempotency-key");
  if (!key || key.length > 255) {
    throw new AccountError(422, "idempotency_key_required");
  }
  return key;
}

export default createBillingRoutes();
