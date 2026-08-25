import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
  WaffoSdkProvider,
  WaffoService,
} from "./waffo.ts";
import { createWaffoRoutes } from "./routes/waffo.ts";
import type { AppEnv } from "./types.ts";

const now = "2026-08-06T08:00:00.000Z";

Deno.test("Waffo checkout uses stable provider idempotency across recovery", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const idempotencyKeys: string[] = [];
  const provider = new WaffoSdkProvider({
    merchantId: "MER_0000000000000000000000",
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString(
      "base64",
    ),
    storeId: "STO_0000000000000000000000",
    productId: "PROD_0000000000000000000000",
    environment: "test",
    fetchImpl: async (_input, init) => {
      idempotencyKeys.push(
        new Headers(init?.headers).get("X-Idempotency-Key")!,
      );
      return Response.json({
        data: {
          sessionId: "checkout-session",
          checkoutUrl: "https://pancake.waffo.ai/xmcl/checkout/session",
        },
      });
    },
  });
  const input = {
    orderId: "order-stable",
    amount: { currency: "USD", amountMinor: 123 },
  };
  await provider.createCheckout(input);
  await provider.createCheckout(input);
  assert.equal(idempotencyKeys.length, 2);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
});

Deno.test("Waffo checkout discovers the unique XMCL cash top-up product", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let graphqlCalls = 0;
  let graphqlBody: {
    query?: string;
    variables?: Record<string, unknown>;
  } | undefined;
  let checkoutBody: Record<string, unknown> | undefined;
  const provider = new WaffoSdkProvider({
    merchantId: "MER_0000000000000000000000",
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString(
      "base64",
    ),
    storeId: "STO_0000000000000000000000",
    environment: "test",
    apiBaseUrl: "https://waffo.example",
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/v1/graphql")) {
        graphqlCalls += 1;
        graphqlBody = JSON.parse(String(init?.body));
        return Response.json({
          data: {
            onetimeProducts: [
              {
                id: "PROD_0000000000000000000000",
                metadata: JSON.stringify({
                  xmclProductType: "cash_top_up",
                  billingModel: "monthly_base_plus_hourly",
                  checkoutAmount: "server_dynamic_price_snapshot",
                  settlementOwner: "xmcl_ledger",
                }),
              },
              {
                id: "PROD_other",
                metadata: { xmclProductType: "other" },
              },
            ],
          },
        });
      }
      checkoutBody = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          sessionId: "checkout-session",
          checkoutUrl: "https://pancake.waffo.ai/xmcl/checkout/session",
        },
      });
    },
  });

  await provider.createCheckout({
    orderId: "order-discovered",
    amount: { currency: "USD", amountMinor: 500 },
  });
  await provider.createCheckout({
    orderId: "order-discovered",
    amount: { currency: "USD", amountMinor: 500 },
  });

  assert.equal(graphqlCalls, 1);
  assert.match(
    graphqlBody?.query ?? "",
    /onetimeProducts\(\s*storeId: \$storeId/,
  );
  assert.deepEqual(graphqlBody?.variables, {
    storeId: "STO_0000000000000000000000",
  });
  assert.equal(
    checkoutBody?.productId,
    "PROD_0000000000000000000000",
  );
});

Deno.test("Waffo product discovery rejects missing or ambiguous matches", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encodedKey = privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
  const matchingProduct = {
    id: "PROD_0000000000000000000000",
    metadata: {
      xmclProductType: "cash_top_up",
      billingModel: "monthly_base_plus_hourly",
      checkoutAmount: "server_dynamic_price_snapshot",
      settlementOwner: "xmcl_ledger",
    },
  };

  for (const products of [[], [matchingProduct, matchingProduct]]) {
    const provider = new WaffoSdkProvider({
      merchantId: "MER_0000000000000000000000",
      privateKey: encodedKey,
      storeId: "STO_0000000000000000000000",
      environment: "test",
      apiBaseUrl: "https://waffo.example",
      fetchImpl: async (input) => {
        assert.match(String(input), /\/v1\/graphql$/);
        return Response.json({ data: { onetimeProducts: products } });
      },
    });

    await assert.rejects(
      () =>
        provider.createCheckout({
          orderId: "order-unavailable",
          amount: { currency: "USD", amountMinor: 500 },
        }),
      (error) =>
        error instanceof AccountError &&
        error.code === "waffo_provider_unavailable",
    );
  }
});

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

function fixture(
  recoverPaymentDue?: (accountId: string, at: Date) => Promise<unknown>,
) {
  let ids = 0;
  const store = new MemoryBillingStore();
  const billing = new BillingService(store, {
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
    recoverPaymentDue,
    now: () => new Date(now),
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
    store,
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

Deno.test("Waffo rejects the wrong environment and accepts non-credit events without crediting", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "non_credit_once",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId, { mode: Environment.Prod }));
  await assert.rejects(
    () => f.waffo.receiveWebhook("{}", { "x-waffo-signature": "valid" }),
    (error: unknown) =>
      error instanceof AccountError &&
      error.code === "invalid_webhook_payload",
  );

  f.setEvent({
    ...webhook(order.orderId, { id: "refund_delivery_1" }),
    eventType: WebhookEventType.RefundFailed,
  });
  const accepted = await f.waffo.receiveWebhook("{}", {
    "x-waffo-signature": "valid",
  });
  assert.deepEqual(accepted, { accepted: true, duplicate: false });
  assert.equal((await f.billing.balance("account_1")).available.amountMinor, 0);
  assert.deepEqual(await f.billing.adminLedger(), []);
});

Deno.test("Waffo credit invokes payment-due recovery with the credited account", async () => {
  const calls: Array<{ accountId: string; at: string }> = [];
  const f = fixture((accountId, at) => {
    calls.push({ accountId, at: at.toISOString() });
    return Promise.resolve();
  });
  const order = await f.waffo.createOrder({
    accountId: "account_recovery",
    idempotencyKey: "recover_after_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId));
  await f.waffo.receiveWebhook("{}", {
    "x-waffo-signature": "valid",
  });
  assert.deepEqual(calls, [{
    accountId: "account_recovery",
    at: now,
  }]);
});

Deno.test("Waffo refund succeeds once and debits the credited cash balance", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_refund",
    idempotencyKey: "refund_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId));
  await f.waffo.receiveWebhook("credit", {
    "x-waffo-signature": "valid",
  });
  f.setEvent({
    ...webhook(order.orderId, {
      id: "refund_delivery_1",
      amount: "4.00",
      refundStatus: "succeeded",
    }),
    eventType: WebhookEventType.RefundSucceeded,
  });
  const first = await f.waffo.receiveWebhook("refund", {
    "x-waffo-signature": "valid",
  });
  const duplicate = await f.waffo.receiveWebhook("refund", {
    "x-waffo-signature": "valid",
  });
  assert.deepEqual(first, { accepted: true, duplicate: false });
  assert.deepEqual(duplicate, { accepted: true, duplicate: true });
  assert.equal(
    (await f.billing.balance("account_refund")).available.amountMinor,
    600,
  );
  assert.equal(
    (await f.billing.ledger("account_refund")).filter((entry) =>
      entry.kind === "refund"
    ).length,
    1,
  );
});

Deno.test("Waffo refund maps tax to cash and caps cumulative partial refunds", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_tax_refund",
    idempotencyKey: "tax_refund_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId, {
    amount: "11.00",
    subtotal: "10.00",
    total: "11.00",
    taxAmount: "1.00",
  }));
  await f.waffo.receiveWebhook("credit", {
    "x-waffo-signature": "valid",
  });
  f.setEvent({
    ...webhook(order.orderId, {
      id: "partial_refund_1",
      amount: "5.50",
      subtotal: "10.00",
      total: "11.00",
      refundStatus: "succeeded",
    }),
    eventType: WebhookEventType.RefundSucceeded,
  });
  await f.waffo.receiveWebhook("refund-1", {
    "x-waffo-signature": "valid",
  });
  f.setEvent({
    ...webhook(order.orderId, {
      id: "partial_refund_2",
      amount: "6.60",
      subtotal: "10.00",
      total: "11.00",
      refundStatus: "succeeded",
    }),
    eventType: WebhookEventType.RefundSucceeded,
  });
  await assert.rejects(
    () =>
      f.waffo.receiveWebhook("refund-2", {
        "x-waffo-signature": "valid",
      }),
    (error: unknown) =>
      error instanceof AccountError && error.code === "refund_amount_mismatch",
  );
  assert.equal(
    (await f.billing.balance("account_tax_refund")).available.amountMinor,
    500,
  );

  f.setEvent({
    ...webhook(order.orderId, {
      id: "partial_refund_without_totals",
      amount: "5.50",
      refundStatus: "succeeded",
    }),
    eventType: WebhookEventType.RefundSucceeded,
  });
  await f.waffo.receiveWebhook("refund-without-totals", {
    "x-waffo-signature": "valid",
  });
  assert.equal(
    (await f.billing.balance("account_tax_refund")).available.amountMinor,
    0,
  );
});

Deno.test("Waffo records a completed refund after credited cash was spent", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_spent_refund",
    idempotencyKey: "spent_refund_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId));
  await f.waffo.receiveWebhook("credit", {
    "x-waffo-signature": "valid",
  });
  await f.store.transaction((state) => {
    state.balances.get("account_spent_refund")!.availableMinor = 200;
  });
  f.setEvent({
    ...webhook(order.orderId, {
      id: "spent_refund",
      amount: "5.00",
      refundStatus: "succeeded",
    }),
    eventType: WebhookEventType.RefundSucceeded,
  });
  await f.waffo.receiveWebhook("spent-refund", {
    "x-waffo-signature": "valid",
  });
  assert.equal(
    (await f.billing.balance("account_spent_refund")).available.amountMinor,
    -300,
  );
});

Deno.test("Waffo converts cumulative taxed refunds without rounding drift", async () => {
  const f = fixture();
  const order = await f.waffo.createOrder({
    accountId: "account_rounding_refund",
    idempotencyKey: "rounding_refund_credit",
    amountMinor: 1000,
  });
  f.setEvent(webhook(order.orderId, {
    amount: "11.00",
    subtotal: "10.00",
    total: "11.00",
  }));
  await f.waffo.receiveWebhook("credit", {
    "x-waffo-signature": "valid",
  });
  for (
    const [id, amount] of [
      ["rounding_refund_1", "3.67"],
      ["rounding_refund_2", "3.67"],
      ["rounding_refund_3", "3.66"],
    ]
  ) {
    f.setEvent({
      ...webhook(order.orderId, {
        id,
        amount,
        refundStatus: "succeeded",
      }),
      eventType: WebhookEventType.RefundSucceeded,
    });
    await f.waffo.receiveWebhook(id, {
      "x-waffo-signature": "valid",
    });
  }
  assert.equal(
    (await f.billing.balance("account_rounding_refund")).available.amountMinor,
    0,
  );
});
