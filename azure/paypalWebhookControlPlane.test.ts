import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import {
  HmacPayPalWebhookProxyIdentity,
} from "../src/lib/paypalWebhookProxyIdentity.ts";
import type { AppEnv } from "../src/types.ts";
import { createAzureHttpApp } from "./httpApp.ts";
import {
  createAzurePayPalWebhookControlPlane,
  PAYPAL_WEBHOOK_AZURE_TARGET,
  PAYPAL_WEBHOOK_ROUTE,
  paypalWebhookControlPlaneSettings,
} from "./paypalWebhookControlPlane.ts";

const now = 1_785_000_000_000;
const secret = "paypal-webhook-proxy-secret-at-least-thirty-two-bytes";
const config: AppConfig = {
  MONGO_CONNECION_STRING: "******mongo.example/control",
  BILLING_RATES_JSON: "[]",
  PAYPAL_CLIENT_ID: "sandbox-client",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
  PAYPAL_WEBHOOK_ID: "sandbox-webhook",
  PAYPAL_API_BASE_URL: "https://api-m.sandbox.paypal.com",
  XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID: "paypal-worker-staging-v1",
  XMCL_PAYPAL_WEBHOOK_PROXY_SECRET: secret,
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

function controlApp(
  calls: Array<{ rawBody: string; headers: Record<string, string> }>,
) {
  const db = nonceDb();
  const controlPlane = createAzurePayPalWebhookControlPlane(config, {
    now: () => now,
    createPayPalService: () => ({
      async receiveWebhook(rawBody, headers) {
        calls.push({ rawBody, headers });
        return { accepted: true as const, duplicate: false };
      },
    }),
  });
  assert(controlPlane);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("getDb", async () => db);
    await next();
  });
  controlPlane.register(app);
  return app;
}

async function signedRequest(
  body: Uint8Array,
  options: {
    signerNow?: number;
    originalTarget?: string;
    bodyOverride?: Uint8Array;
  } = {},
) {
  const signer = new HmacPayPalWebhookProxyIdentity({
    keyId: config.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID!,
    secret,
    now: () => options.signerNow ?? now,
  });
  const headers = await signer.signOutgoing({
    method: "POST",
    target: PAYPAL_WEBHOOK_AZURE_TARGET,
    body,
  });
  return new Request(`https://control.example${PAYPAL_WEBHOOK_ROUTE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/example",
      "paypal-transmission-id": "transmission_1",
      "paypal-transmission-sig": "signature",
      "paypal-transmission-time": "2026-07-25T09:00:00Z",
      "x-xmcl-original-target": options.originalTarget ??
        PAYPAL_WEBHOOK_AZURE_TARGET,
      ...headers,
    },
    body: (options.bodyOverride ?? body) as unknown as BodyInit,
  });
}

Deno.test("Azure PayPal webhook route is absent unless every dedicated setting is safe", async () => {
  assert.equal(
    paypalWebhookControlPlaneSettings({
      ...config,
      XMCL_PAYPAL_WEBHOOK_PROXY_SECRET: undefined,
    }),
    undefined,
  );
  assert.equal(
    paypalWebhookControlPlaneSettings({
      ...config,
      PAYPAL_API_BASE_URL: "https://api-m.paypal.com",
    }),
    undefined,
  );

  const app = new Hono<AppEnv>();
  const absent = createAzurePayPalWebhookControlPlane({
    ...config,
    PAYPAL_WEBHOOK_ID: undefined,
  });
  absent?.register(app);
  assert.equal(
    (await app.request(PAYPAL_WEBHOOK_ROUTE, { method: "POST" })).status,
    404,
  );
});

Deno.test("Azure authenticates exact raw webhook bytes before invoking PayPal handling", async () => {
  const calls: Array<{ rawBody: string; headers: Record<string, string> }> = [];
  const app = controlApp(calls);
  const body = new TextEncoder().encode(
    '{"id":"event_1","event_type":"PAYMENT.CAPTURE.COMPLETED"}',
  );

  const accepted = await app.request(await signedRequest(body));
  assert.equal(accepted.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rawBody, new TextDecoder().decode(body));
  assert.equal(calls[0].headers["paypal-transmission-id"], "transmission_1");

  const replayRequest = await signedRequest(body);
  const first = await app.request(replayRequest);
  assert.equal(first.status, 202);
  const replay = await app.request(new Request(replayRequest.url, {
    method: "POST",
    headers: replayRequest.headers,
    body: body as unknown as BodyInit,
  }));
  assert.equal(replay.status, 401);
  assert.equal(calls.length, 2);
});

Deno.test("Azure rejects missing, modified, stale, and swapped-target proxy requests before PayPal", async () => {
  const calls: Array<{ rawBody: string; headers: Record<string, string> }> = [];
  const app = controlApp(calls);
  const body = new TextEncoder().encode('{"id":"event_1"}');
  const missing = await app.request(PAYPAL_WEBHOOK_ROUTE, {
    method: "POST",
    headers: { "x-xmcl-original-target": PAYPAL_WEBHOOK_AZURE_TARGET },
    body,
  });
  assert.equal(missing.status, 401);

  const modified = await app.request(await signedRequest(body, {
    bodyOverride: new TextEncoder().encode('{"id":"event_2"}'),
  }));
  assert.equal(modified.status, 401);

  const stale = await app.request(await signedRequest(body, {
    signerNow: now - 60_001,
  }));
  assert.equal(stale.status, 401);

  const swapped = await app.request(await signedRequest(body, {
    originalTarget: "/api/v1/webhooks/paypal?destination=attacker",
  }));
  assert.equal(swapped.status, 401);
  assert.equal(calls.length, 0);
});

Deno.test("Azure composition mounts the verified webhook only, never public payment or ledger routes", () => {
  const app = createAzureHttpApp(config as Record<string, string>);
  const paths = app.routes.map((route) => route.path);
  assert.equal(paths.includes(PAYPAL_WEBHOOK_ROUTE), true);
  assert.equal(paths.includes("/v1/billing/balance"), false);
  assert.equal(paths.includes("/v1/billing/paypal/orders"), false);
  assert.equal(paths.includes("/v1/billing/paypal/orders/:orderId/capture"), false);
  assert.equal(paths.includes("/v1/internal/usage/authorize"), false);
});
