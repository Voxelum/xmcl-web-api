import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import { getWaffoService } from "../lib/billingRuntime.ts";
import {
  decodePaymentWebhookBody,
  PaymentWebhookBodyTooLargeError,
  readPaymentWebhookRawBody,
} from "../lib/paymentWebhook.ts";
import type { WaffoService } from "../lib/waffo.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

export function createWaffoRoutes(
  waffo?: WaffoService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
  options: { authenticated?: boolean; webhook?: boolean } = {},
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  if (options.authenticated !== false) {
    app.use("/v1/billing/waffo/*", xmclAuth([], resolve));
  }
  app.post("/v1/billing/waffo/orders", async (c) => {
    const body = await jsonBody(c);
    return c.json(
      await (await waffoFor(c, waffo)).createOrder({
        accountId: c.get("xmclPrincipal")!.accountId,
        idempotencyKey: requireIdempotencyKey(c),
        amountMinor: body.amountMinor as number,
      }),
      201,
    );
  });
  if (options.webhook !== false) {
    app.post("/v1/webhooks/waffo", async (c) => {
      let raw: Uint8Array;
      try {
        raw = await readPaymentWebhookRawBody(c.req.raw);
      } catch (error) {
        if (error instanceof PaymentWebhookBodyTooLargeError) {
          return c.json({ error: "payload_too_large" }, 413);
        }
        throw new AccountError(422, "invalid_webhook_payload");
      }
      let rawBody: string;
      try {
        rawBody = decodePaymentWebhookBody(raw);
      } catch {
        throw new AccountError(422, "invalid_webhook_payload");
      }
      const requestHeaders = Object.fromEntries(
        [...c.req.raw.headers.entries()].map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      return c.json(
        await (await waffoFor(c, waffo)).receiveWebhook(
          rawBody,
          requestHeaders,
        ),
        200,
      );
    });
  }
  return app;
}

async function waffoFor(c: Context<AppEnv>, injected?: WaffoService) {
  const service = injected ?? c.var.waffoService;
  if (service) return service;
  try {
    return await getWaffoService(c);
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(503, "waffo_unavailable");
  }
}

export default createWaffoRoutes();
