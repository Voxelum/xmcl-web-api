import { type Context, Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import { getPayPalService } from "../lib/billingRuntime.ts";
import type { PayPalService } from "../lib/paypal.ts";
import {
  decodePayPalWebhookBody,
  PayPalWebhookBodyTooLargeError,
  readPayPalWebhookRawBody,
} from "../lib/paypalWebhook.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

export interface PayPalRouteOptions {
  authenticated?: boolean;
  checkout?: boolean;
  webhook?: boolean;
}

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
  options: PayPalRouteOptions = {},
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  if (options.checkout !== false) {
    if (options.authenticated !== false) {
      app.use("/v1/billing/paypal/*", xmclAuth([], resolve));
    }
    app.post("/v1/billing/paypal/orders", async (c) => {
      const body = await jsonBody(c);
      return c.json(
        await (await paypalFor(c, paypal)).createOrder({
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
          await (await paypalFor(c, paypal)).captureOrder(
            c.get("xmclPrincipal")!.accountId,
            c.req.param("orderId"),
          ),
        ),
    );
  }

  if (options.webhook !== false) {
    app.post("/v1/webhooks/paypal", (c) => handlePayPalWebhook(c, paypal));
  }
  return app;
}

export async function handlePayPalWebhook(
  c: Context<AppEnv>,
  injected?: PayPalService,
) {
  let raw: Uint8Array;
  try {
    raw = await readPayPalWebhookRawBody(c.req.raw);
  } catch (error) {
    if (error instanceof PayPalWebhookBodyTooLargeError) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    throw new AccountError(422, "invalid_webhook_payload");
  }
  const result = await receivePayPalWebhook(
    raw,
    headers(c),
    await paypalFor(c, injected),
  );
  return c.json(result, 202);
}

export async function receivePayPalWebhook(
  raw: Uint8Array,
  requestHeaders: Record<string, string>,
  paypal: Pick<PayPalService, "receiveWebhook">,
) {
  let rawBody: string;
  try {
    rawBody = decodePayPalWebhookBody(raw);
  } catch {
    throw new AccountError(422, "invalid_webhook_payload");
  }
  return await paypal.receiveWebhook(rawBody, requestHeaders);
}

async function paypalFor(c: Context<AppEnv>, injected?: PayPalService) {
  const service = injected ?? c.var.paypalService;
  if (service) return service;
  try {
    return await getPayPalService(c);
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(503, "billing_unavailable");
  }
}

export default createPayPalRoutes();
