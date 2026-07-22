import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import type { PayPalService } from "../lib/paypal.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function headers(c: { req: { raw: Request } }) {
  return Object.fromEntries(
    [...c.req.raw.headers.entries()].map((
      [key, value],
    ) => [key.toLowerCase(), value]),
  );
}

export function createPayPalRoutes(
  paypal?: PayPalService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/billing/paypal/*", xmclAuth([], resolve));

  app.post("/v1/billing/paypal/orders", async (c) => {
    const body = await jsonBody(c);
    return c.json(
      await paypalFor(c, paypal).createOrder({
        accountId: c.get("xmclPrincipal")!.accountId,
        idempotencyKey: requireIdempotencyKey(c),
        amountMinor: body.amountMinor as number,
      }),
      201,
    );
  });
  app.post(
    "/v1/billing/paypal/orders/:orderId/capture",
    async (c) =>
      c.json(
        await paypalFor(c, paypal).captureOrder(
          c.get("xmclPrincipal")!.accountId,
          c.req.param("orderId"),
        ),
      ),
  );

  app.post("/v1/webhooks/paypal", async (c) => {
    const rawBody = await c.req.text();
    const result = await paypalFor(c, paypal).receiveWebhook(
      rawBody,
      headers(c),
    );
    return c.json(result, 202);
  });
  return app;
}

function paypalFor(c: Context<AppEnv>, injected?: PayPalService) {
  const service = injected ?? c.var.paypalService;
  if (!service) throw new AccountError(503, "billing_unavailable");
  return service;
}

export default createPayPalRoutes();
