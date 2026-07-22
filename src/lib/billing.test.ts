import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "./accountRuntime.ts";
import { createApp } from "../app.ts";
import { BillingService } from "./billing.ts";
import { type CashRate, MemoryBillingStore } from "./ledger.ts";
import {
  FakePayPalProvider,
  FakePayPalWebhookVerifier,
  PayPalService,
} from "./paypal.ts";
import {
  type CanonicalUsageEvent,
  type UsageAuthorizationRequest,
  UsageSettlementService,
} from "./usageSettlement.ts";
import { handleAccountError } from "./accountHttp.ts";
import { createBillingRoutes } from "../routes/billing.ts";
import { createPayPalRoutes } from "../routes/paypal.ts";
import { createUsageSettlementRoutes } from "../routes/usageSettlement.ts";
import type { AppEnv } from "../types.ts";

const now = "2026-07-22T10:00:00.000Z";
const rate: CashRate = {
  rateVersion: 7,
  resource: "server_time",
  unit: "second",
  amountMinorPerUnit: 1,
  effectiveAt: now,
};

function fixture(options: {
  failCreate?: boolean;
  failCreateOnce?: boolean;
  verifier?: FakePayPalWebhookVerifier;
} = {}) {
  let ids = 0;
  const store = new MemoryBillingStore();
  const billing = new BillingService(store, {
    currency: "USD",
    rates: [rate],
    now: () => new Date(now),
    createId: (prefix) => `${prefix}_${++ids}`,
  });
  const provider = new FakePayPalProvider({
    failCreate: options.failCreate,
    failCreateOnce: options.failCreateOnce,
  });
  const verifier = options.verifier ?? new FakePayPalWebhookVerifier();
  const paypal = new PayPalService(billing, provider, verifier);
  const usage = new UsageSettlementService(store, billing, {
    now: () => new Date(now),
    createId: (prefix) => `${prefix}_${++ids}`,
  });
  const runtime = {
    sessions: {
      verify: async (token: string) => {
        if (token === "user") {
          return {
            sessionId: "session_user",
            familyId: "family_user",
            accountId: "account_1",
            scopes: ["account:read"],
            issuedAt: now,
            expiresAt: "2026-07-22T11:00:00.000Z",
          };
        }
        if (token === "producer") {
          return {
            sessionId: "session_producer",
            familyId: "family_producer",
            accountId: "producer_1",
            scopes: ["billing:internal"],
            issuedAt: now,
            expiresAt: "2026-07-22T11:00:00.000Z",
          };
        }
        throw new Error("unexpected token");
      },
    },
  } as AccountRuntime;
  const resolve = (_c: unknown) => Promise.resolve(runtime);
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.route("/", createBillingRoutes(billing, resolve));
  app.route("/", createPayPalRoutes(paypal, resolve));
  app.route("/", createUsageSettlementRoutes(usage, resolve));
  return { app, billing, paypal, provider, usage, verifier, runtime };
}

async function credit(paypal: PayPalService, amountMinor: number) {
  const order = await paypal.createOrder({
    accountId: "account_1",
    amountMinor,
    idempotencyKey: `credit_${amountMinor}`,
  });
  await paypal.receiveWebhook(
    JSON.stringify({
      id: `webhook_${amountMinor}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        supplementary_data: {
          related_ids: { order_id: `paypal_${order.orderId}` },
        },
      },
    }),
    {},
  );
}

function auth(
  body: Partial<UsageAuthorizationRequest> = {},
): UsageAuthorizationRequest {
  return {
    accountId: "account_1",
    resource: "server_time",
    sourceId: "lease_1",
    expectedQuantity: 60,
    unit: "second",
    settlementIntervalSeconds: 60,
    rateVersion: 7,
    idempotencyKey: "authorize_1",
    expiresAt: "2026-07-22T10:10:00.000Z",
    ...body,
  };
}

function event(
  authorizationId: string,
  body: Partial<CanonicalUsageEvent> = {},
): CanonicalUsageEvent {
  return {
    eventType: "usage.recorded.v1",
    eventId: "event_1",
    schemaVersion: 1,
    accountId: "account_1",
    authorizationId,
    resource: "server_time",
    sourceId: "lease_1",
    quantity: 60,
    unit: "second",
    rateVersion: 7,
    sequence: 1,
    intervalStart: "2026-07-22T10:00:00.000Z",
    intervalEnd: "2026-07-22T10:01:00.000Z",
    occurredAt: "2026-07-22T10:01:00.000Z",
    idempotencyKey: "settle_1",
    ...body,
  };
}

Deno.test("billing reads and orders require session auth; internal usage requires service scope", async () => {
  const f = fixture();
  assert.equal((await f.app.request("/v1/billing/balance")).status, 401);
  assert.equal(
    (await f.app.request("/v1/billing/paypal/orders", { method: "POST" }))
      .status,
    401,
  );
  const denied = await f.app.request("/v1/internal/usage/authorize", {
    method: "POST",
    headers: {
      authorization: "Bearer user",
      "content-type": "application/json",
      "idempotency-key": "authorize_1",
    },
    body: JSON.stringify(auth()),
  });

  assert.equal(denied.status, 403);
});

Deno.test("the shared Hono app registers the Billing route families", () => {
  const paths = createApp().routes.map((route) => route.path);
  assert(paths.includes("/v1/billing/balance"));
  assert(paths.includes("/v1/billing/paypal/orders"));
  assert(paths.includes("/v1/internal/usage/authorize"));
  assert(paths.includes("/v1/webhooks/paypal"));
});

Deno.test("PayPal order replays deterministically, conflicts on a changed intent, and never credits a provider failure", async () => {
  const f = fixture();
  const request = (amountMinor: number) =>
    f.app.request("/v1/billing/paypal/orders", {
      method: "POST",
      headers: {
        authorization: "Bearer user",
        "content-type": "application/json",
        "idempotency-key": "order_once",
      },
      body: JSON.stringify({ amountMinor }),
    });
  const first = await request(100);
  const replay = await request(100);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(
    (await first.json() as { orderId: string }).orderId,
    (await replay.json() as { orderId: string }).orderId,
  );
  assert.deepEqual(
    (await f.billing.orders("account_1"))[0]?.cashAmount,
    { currency: "USD", amountMinor: 100 },
  );
  assert.equal(f.provider.createCalls.length, 1);
  assert.equal((await request(101)).status, 409);

  const failing = fixture({ failCreate: true });
  const unavailable = await failing.app.request("/v1/billing/paypal/orders", {
    method: "POST",
    headers: {
      authorization: "Bearer user",
      "content-type": "application/json",
      "idempotency-key": "provider_failure",
    },
    body: JSON.stringify({ amountMinor: 100 }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(
    (await failing.billing.balance("account_1")).available.amountMinor,
    0,
  );

  const retrying = fixture({ failCreateOnce: true });
  const retryRequest = () =>
    retrying.app.request("/v1/billing/paypal/orders", {
      method: "POST",
      headers: {
        authorization: "Bearer user",
        "content-type": "application/json",
        "idempotency-key": "provider_retry",
      },
      body: JSON.stringify({ amountMinor: 100 }),
    });
  assert.equal((await retryRequest()).status, 503);
  assert.equal((await retryRequest()).status, 201);
  assert.equal(retrying.provider.createCalls.length, 2);
});

Deno.test("verified raw PayPal webhooks credit once; invalid and duplicate bodies cannot credit twice", async () => {
  const validRaw = JSON.stringify({
    id: "webhook_valid",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      supplementary_data: { related_ids: { order_id: "paypal_order_1" } },
    },
  });
  const verifier = new FakePayPalWebhookVerifier(({ rawBody }) =>
    rawBody === validRaw
  );
  const f = fixture({ verifier });
  await f.app.request("/v1/billing/paypal/orders", {
    method: "POST",
    headers: {
      authorization: "Bearer user",
      "content-type": "application/json",
      "idempotency-key": "order_webhook",
    },
    body: JSON.stringify({ amountMinor: 100 }),
  });
  const invalid = await f.app.request("/v1/webhooks/paypal", {
    method: "POST",
    body: validRaw.replace('"webhook_valid"', '"webhook_invalid"'),
  });
  assert.equal(invalid.status, 401);
  assert.equal((await f.billing.balance("account_1")).available.amountMinor, 0);
  const first = await f.app.request("/v1/webhooks/paypal", {
    method: "POST",
    body: validRaw,
  });
  const duplicate = await f.app.request("/v1/webhooks/paypal", {
    method: "POST",
    body: validRaw,
  });
  assert.equal(first.status, 202);
  assert.equal(
    (await duplicate.json() as { duplicate: boolean }).duplicate,
    true,
  );
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    100,
  );
  assert.deepEqual(verifier.verifiedRawBodies, [
    validRaw.replace('"webhook_valid"', '"webhook_invalid"'),
    validRaw,
    validRaw,
  ]);
});

Deno.test("usage reserves cash, settles once, and rejects duplicate, out-of-order, and overlapping streams", async () => {
  const f = fixture();
  await credit(f.paypal, 200);
  const authorization = await f.usage.authorize("producer_1", auth());
  assert.deepEqual(await f.billing.balance("account_1"), {
    accountId: "account_1",
    available: { currency: "USD", amountMinor: 140 },
    reserved: { currency: "USD", amountMinor: 60 },
  });
  const first = await f.usage.settle(
    "producer_1",
    event(authorization.authorizationId),
  );
  const duplicate = await f.usage.settle(
    "producer_1",
    event(authorization.authorizationId),
  );
  assert.equal(first.settlementId, duplicate.settlementId);
  assert.equal(first.action, "continue");
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    140,
  );
  assert.equal((await f.billing.balance("account_1")).reserved.amountMinor, 0);
  await assert.rejects(
    () =>
      f.usage.settle(
        "producer_1",
        event(authorization.authorizationId, {
          quantity: 59,
        }),
      ),
    (error) =>
      error instanceof Error && "code" in error &&
      error.code === "idempotency_conflict",
  );

  const next = await f.usage.authorize(
    "producer_1",
    auth({ idempotencyKey: "authorize_2" }),
  );
  await assert.rejects(
    () =>
      f.usage.settle(
        "producer_1",
        event(next.authorizationId, {
          eventId: "event_old",
          idempotencyKey: "settle_old",
          sequence: 1,
          intervalStart: "2026-07-22T10:01:00.000Z",
          intervalEnd: "2026-07-22T10:02:00.000Z",
          occurredAt: "2026-07-22T10:02:00.000Z",
        }),
      ),
    (error) =>
      error instanceof Error && "code" in error &&
      error.code === "usage_out_of_order",
  );
  await assert.rejects(
    () =>
      f.usage.settle(
        "producer_1",
        event(next.authorizationId, {
          eventId: "event_overlap",
          idempotencyKey: "settle_overlap",
          sequence: 2,
        }),
      ),
    (error) =>
      error instanceof Error && "code" in error &&
      error.code === "usage_interval_overlap",
  );
});

Deno.test("a usage event exceeding its reservation returns stop_required without a negative balance", async () => {
  const f = fixture();
  await credit(f.paypal, 60);
  const authorization = await f.usage.authorize("producer_1", auth());
  const result = await f.usage.settle(
    "producer_1",
    event(authorization.authorizationId, {
      quantity: 61,
      eventId: "event_exhausted",
      idempotencyKey: "settle_exhausted",
    }),
  );
  assert.equal(result.usageEventId, "event_exhausted");
  assert.deepEqual(result.charged, { currency: "USD", amountMinor: 0 });
  assert.equal(result.action, "stop_required");
  assert.equal(result.status, "rejected");
  const balance = await f.billing.balance("account_1");
  assert.equal(balance.available.amountMinor, 0);
  assert.equal(balance.reserved.amountMinor, 60);
  await f.usage.release(
    "producer_1",
    authorization.authorizationId,
    "release_exhausted",
  );
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    60,
  );
});
