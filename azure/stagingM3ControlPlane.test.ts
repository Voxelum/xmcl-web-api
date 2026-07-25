import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../src/lib/accountRuntime.ts";
import { BillingService } from "../src/lib/billing.ts";
import {
  FakePayPalProvider,
  FakePayPalWebhookVerifier,
  PayPalService,
} from "../src/lib/paypal.ts";
import {
  HmacStagingM3ProxyIdentity,
} from "../src/lib/stagingM3ProxyIdentity.ts";
import { MemoryBillingStore } from "../src/lib/ledger.ts";
import { stagingM3AzureTarget } from "../src/lib/stagingM3Routes.ts";
import type { AppEnv } from "../src/types.ts";
import { createAzureHttpApp } from "./httpApp.ts";
import {
  createAzureStagingM3ControlPlane,
  stagingM3ControlPlaneSettings,
} from "./stagingM3ControlPlane.ts";
import type { Db } from "../src/db.ts";

const now = 1_785_000_000_000;
const secret = "staging-m3-proxy-secret-at-least-thirty-two-bytes";
const config = {
  MONGO_CONNECION_STRING: "******mongo.example/control",
  BILLING_RATES_JSON: "[]",
  PAYPAL_CLIENT_ID: "sandbox-client",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
  PAYPAL_WEBHOOK_ID: "sandbox-webhook",
  PAYPAL_RETURN_URL: "https://staging.launcher.example/paypal/return",
  PAYPAL_CANCEL_URL: "https://staging.launcher.example/paypal/cancel",
  PAYPAL_API_BASE_URL: "https://api-m.sandbox.paypal.com",
  XMCL_STAGING_M3_CHECKOUT_ENABLED: "true",
  XMCL_STAGING_M3_PROXY_KEY_ID: "staging-m3-worker-v1",
  XMCL_STAGING_M3_PROXY_SECRET: secret,
  XMCL_STAGING_M3_CORS_ORIGINS: "https://staging.launcher.example",
};

function nonceDb() {
  const values = new Map<string, number>();
  return {
    collection: () => ({
      async deleteOne(filter: { _id: string; expiresAt: { $lte: number } }) {
        if ((values.get(filter._id) ?? Infinity) <= filter.expiresAt.$lte) {
          values.delete(filter._id);
        }
        return {};
      },
      async updateOne(
        filter: { _id: string },
        update: { $setOnInsert: { expiresAt: number } },
      ) {
        if (values.has(filter._id)) return { upsertedCount: 0 };
        values.set(filter._id, update.$setOnInsert.expiresAt);
        return { upsertedCount: 1 };
      },
    }),
  } as unknown as Db;
}

function controlApp() {
  const db = nonceDb();
  const billing = new BillingService(new MemoryBillingStore(), {
    currency: "USD",
    rates: [],
    now: () => new Date(now),
  });
  const paypal = new PayPalService(
    billing,
    new FakePayPalProvider(),
    new FakePayPalWebhookVerifier(),
  );
  let authCalls = 0;
  const runtime = {
    sessions: {
      async verify(token: string) {
        authCalls++;
        if (token !== "user-session") throw new Error("invalid user session");
        return {
          sessionId: "session_1",
          familyId: "family_1",
          accountId: "account_1",
          scopes: [],
          issuedAt: "2026-07-25T00:00:00.000Z",
          expiresAt: "2026-07-25T01:00:00.000Z",
        };
      },
    },
  } as unknown as AccountRuntime;
  const controlPlane = createAzureStagingM3ControlPlane(config, {
    now: () => now,
    billing,
    paypal,
    resolveAccountRuntime: async () => runtime,
  });
  assert(controlPlane);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("getDb", async () => db);
    await next();
  });
  controlPlane.register(app);
  return { app, getAuthCalls: () => authCalls };
}

async function signedRequest(
  method: "GET" | "POST",
  path: string,
  body = new Uint8Array(),
  options: {
    authorization?: string;
    bodyOverride?: Uint8Array;
    originalTarget?: string;
  } = {},
) {
  const target = stagingM3AzureTarget(method, path);
  assert(target);
  const signer = new HmacStagingM3ProxyIdentity({
    keyId: config.XMCL_STAGING_M3_PROXY_KEY_ID,
    secret,
    now: () => now,
  });
  const identity = await signer.signOutgoing({ method, target, body });
  return new Request(`https://control.example${path}`, {
    method,
    headers: {
      authorization: options.authorization ?? "Bearer user-session",
      "content-type": "application/json",
      "idempotency-key": "order_once",
      origin: "https://staging.launcher.example",
      "x-xmcl-original-target": options.originalTarget ?? target,
      ...identity,
    },
    body: method === "POST"
      ? (options.bodyOverride ?? body) as unknown as BodyInit
      : undefined,
  });
}

Deno.test("Azure M3 composition fails closed without the explicit sandbox setting or safe complete config", () => {
  for (const invalid of [
    { XMCL_STAGING_M3_CHECKOUT_ENABLED: undefined },
    { XMCL_STAGING_M3_CHECKOUT_ENABLED: "TRUE" },
    { PAYPAL_API_BASE_URL: "https://api-m.paypal.com" },
    { XMCL_STAGING_M3_PROXY_SECRET: undefined },
    { MONGO_CONNECION_STRING: undefined },
    { XMCL_STAGING_M3_CORS_ORIGINS: "https://staging.launcher.example/" },
  ]) {
    assert.equal(stagingM3ControlPlaneSettings({ ...config, ...invalid }), undefined);
  }
  const absent = createAzureHttpApp({
    ...config,
    XMCL_STAGING_M3_CHECKOUT_ENABLED: undefined,
  });
  assert.equal(
    absent.routes.some((route) => route.path === "/v1/billing/balance"),
    false,
  );
  assert.equal(
    absent.routes.some((route) => route.path === "/v1/billing/paypal/orders"),
    false,
  );
});

Deno.test("Azure M3 mounts only the reviewed authenticated APIs, never public payment or credit routes", () => {
  const app = createAzureHttpApp(config);
  const paths = app.routes.map((route) => route.path);
  for (const path of [
    "/v1/billing/balance",
    "/v1/billing/rates",
    "/v1/billing/orders",
    "/v1/billing/orders/:orderId",
    "/v1/billing/ledger",
    "/v1/billing/usage",
    "/v1/billing/paypal/orders",
    "/v1/billing/paypal/orders/:orderId/capture",
  ]) {
    assert.equal(paths.includes(path), true);
  }
  for (const path of [
    "/v1/webhooks/paypal",
    "/v1/internal/usage/authorize",
  ]) {
    assert.equal(paths.includes(path), false);
  }
});

Deno.test("Azure M3 verifies durable HMAC before account auth, then uses shared user routes", async () => {
  const { app, getAuthCalls } = controlApp();
  const missingIdentity = await app.request("/v1/billing/balance", {
    headers: {
      authorization: "Bearer user-session",
      "x-xmcl-original-target": "/api/v1/billing/balance",
    },
  });
  assert.equal(missingIdentity.status, 401);
  assert.equal(getAuthCalls(), 0);

  const balance = await app.request(await signedRequest(
    "GET",
    "/v1/billing/balance",
  ));
  assert.equal(balance.status, 200);
  assert.equal(
    balance.headers.get("access-control-allow-origin"),
    "https://staging.launcher.example",
  );

  const orderBody = new TextEncoder().encode('{"amountMinor":100}');
  const order = await app.request(await signedRequest(
    "POST",
    "/v1/billing/paypal/orders",
    orderBody,
  ));
  assert.equal(order.status, 201);
  assert.equal(getAuthCalls(), 2);
});

Deno.test("Azure M3 rejects body substitution, target swaps, and durable nonce replay before billing", async () => {
  const { app, getAuthCalls } = controlApp();
  const body = new TextEncoder().encode('{"amountMinor":100}');
  const modified = await app.request(await signedRequest(
    "POST",
    "/v1/billing/paypal/orders",
    body,
    {
      bodyOverride: new TextEncoder().encode('{"amountMinor":999}'),
    },
  ));
  assert.equal(modified.status, 401);
  assert.equal(getAuthCalls(), 0);

  const targetSwap = await app.request(await signedRequest(
    "GET",
    "/v1/billing/balance",
    new Uint8Array(),
    { originalTarget: "/api/v1/billing/ledger" },
  ));
  assert.equal(targetSwap.status, 401);
  assert.equal(getAuthCalls(), 0);

  const signed = await signedRequest(
    "POST",
    "/v1/billing/paypal/orders",
    body,
  );
  assert.equal((await app.request(signed)).status, 201);
  const replay = await app.request(new Request(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: body as unknown as BodyInit,
  }));
  assert.equal(replay.status, 401);
  assert.equal(getAuthCalls(), 1);
});

Deno.test("Azure M3 CORS preflight is restricted to configured origin and exact route method", async () => {
  const { app } = controlApp();
  const accepted = await app.request("/v1/billing/balance", {
    method: "OPTIONS",
    headers: {
      origin: "https://staging.launcher.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(accepted.status, 204);
  assert.equal(
    accepted.headers.get("access-control-allow-origin"),
    "https://staging.launcher.example",
  );
  const rejected = await app.request("/v1/billing/balance", {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(rejected.status, 404);
});
