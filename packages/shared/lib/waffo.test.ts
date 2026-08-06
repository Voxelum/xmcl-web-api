import assert from "node:assert/strict";
import {
  Environment,
  type WebhookEvent,
  WebhookEventType,
} from "@waffo/pancake-ts";
import { Hono } from "hono";
import type { AccountRuntime } from "./accountRuntime.ts";
import { AccountError } from "./account.ts";
import { BillingService } from "./billing.ts";
import { handleAccountError } from "./accountHttp.ts";
import { MemoryBillingStore } from "./ledger.ts";
import {
  FakeWaffoProvider,
  FakeWaffoWebhookVerifier,
  WaffoService,
} from "./waffo.ts";
import { createWaffoRoutes } from "../routes/waffo.ts";
import type { AppEnv } from "../types.ts";

const now = "2026-08-06T08:00:00.000Z";

function webhook(
  orderId: string,
  overrides: Partial<WebhookEvent["data"]> & {
    storeId?: string;
    mode?: `${Environment}`;
    id?: string;
  } = {},
): WebhookEvent {
  return {
    id: overrides.id ?? "delivery_1",
    timestamp: now,
    eventType: WebhookEventType.OrderCompleted,
    eventId: "payment_1",
    storeId: overrides.storeId ?? "STO_xmcl",
    storeName: "XMCL",
    mode: overrides.mode ?? Environment.Test,
    data: {
      orderId: "ORD_waffo",
      buyerEmail: "buyer@example.com",
      currency: "USD",
      amount: "10.00",
      taxAmount: "0.00",
      productName: "XMCL balance",
      paymentStatus: "succeeded",
      orderMerchantExternalId: orderId,
      ...overrides,
    },
  };
}

function fixture() {
  let ids = 0;
  const billing = new BillingService(new MemoryBillingStore(), {
    currency: "USD",
    rates: [],
    now: () => new Date(now),
    createId: (prefix) => `${prefix}_${++ids}`,
  });
  const provider = new FakeWaffoProvider();
  let currentEvent: WebhookEvent | undefined;
  const verifier = new FakeWaffoWebhookVerifier(({ signature }) => {
    if (signature !== "valid") throw new Error("invalid signature");
    if (!currentEvent) throw new Error("missing fixture event");
    return currentEvent;
  });
  const waffo = new WaffoService(billing, provider, verifier, {
    storeId: "STO_xmcl",
    environment: "test",
  });
  const runtime = {
    sessions: {
      verify: async () => ({
        sessionId: "session_1",
        familyId: "family_1",
        accountId: "account_1",
        scopes: ["account:read"],
        issuedAt: now,
        expiresAt: "2026-08-06T09:00:00.000Z",
      }),
    },
  } as unknown as AccountRuntime;
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.route(
    "/",
    createWaffoRoutes(waffo, () => Promise.resolve(runtime)),
  );
  return {
    app,
    billing,
    provider,
    waffo,
    setEvent(event: WebhookEvent) {
      currentEvent = event;
    },
  };
}

Deno.test("Waffo checkout creates a dynamic top-up intent and replays idempotently", async () => {
  const f = fixture();
  const request = () =>
    f.app.request("/v1/billing/waffo/orders", {
      method: "POST",
      headers: {
        authorization: ["Bearer", "user"].join(" "),
        "content-type": "application/json",
        "idempotency-key": "waffo_once",
      },
      body: JSON.stringify({ amountMinor: 1000 }),
    });
  const first = await request();
  const replay = await request();
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(f.provider.createCalls.length, 1);
  assert.deepEqual(f.provider.createCalls[0].amount, {
    currency: "USD",
    amountMinor: 1000,
  });
  assert.equal(
    (await first.json() as { approvalUrl: string }).approvalUrl,
    "https://checkout.waffo.invalid/order_1",
  );
});

Deno.test("Waffo credits only a matching signed store, environment, and amount", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "credit_once",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId));
  const send = () =>
    f.app.request("/v1/webhooks/waffo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-waffo-signature": "valid",
      },
      body: JSON.stringify({ preserved: "raw body" }),
    });
  assert.equal((await send()).status, 200);
  const duplicate = await send();
  assert.equal(duplicate.status, 200);
  assert.equal(
    (await duplicate.json() as { duplicate: boolean }).duplicate,
    true,
  );
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    1000,
  );
  assert.equal((await f.billing.adminLedger())[0].kind, "waffo_credit");
});

Deno.test("Waffo validates the top-up subtotal when provider tax increases the total", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "taxed_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId, {
    amount: "11.00",
    subtotal: "10.00",
    taxAmount: "1.00",
  }));
  const result = await f.waffo.receiveWebhook("{}", {
    "x-waffo-signature": "valid",
  });
  assert.equal(result.duplicate, false);
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    1000,
  );
});

Deno.test("Waffo rejects invalid signatures and mismatched payment facts", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "reject_once",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId, { amount: "1.00" }));
  await assert.rejects(
    () => f.waffo.receiveWebhook("{}", { "x-waffo-signature": "valid" }),
    (error: unknown) =>
      error instanceof Error && error.message === "payment_amount_mismatch",
  );
  f.setEvent(webhook(order.orderId, { storeId: "STO_attacker" }));
  await assert.rejects(
    () => f.waffo.receiveWebhook("{}", { "x-waffo-signature": "valid" }),
    (error: unknown) =>
      error instanceof Error && error.message === "invalid_webhook_payload",
  );
  await assert.rejects(
    () => f.waffo.receiveWebhook("{}", { "x-waffo-signature": "invalid" }),
    (error: unknown) =>
      error instanceof AccountError &&
      error.code === "invalid_webhook_signature",
  );
  assert.equal((await f.billing.balance("account_1")).available.amountMinor, 0);
});
