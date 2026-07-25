import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import {
  HmacPayPalWebhookProxyIdentity,
  type PayPalWebhookProxyNonceStore,
} from "../src/lib/paypalWebhookProxyIdentity.ts";
import {
  HmacStagingM3ProxyIdentity,
  type StagingM3ProxyNonceStore,
} from "../src/lib/stagingM3ProxyIdentity.ts";
import worker, {
  PAYPAL_WEBHOOK_AZURE_TARGET,
  PAYPAL_WEBHOOK_PATH,
  PAYPAL_WEBHOOK_STAGING_HOST,
  paypalWebhookProxySettings,
  proxyPayPalWebhook,
  proxyStagingM3,
  stagingM3CorsPreflight,
  stagingM3ProxySettings,
} from "./worker.ts";

const secret = "paypal-webhook-proxy-secret-at-least-thirty-two-bytes";
const config: AppConfig = {
  PAYPAL_WEBHOOK_PROXY_URL:
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/webhooks/paypal",
  XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID: "paypal-worker-staging-v1",
  XMCL_PAYPAL_WEBHOOK_PROXY_SECRET: secret,
};

const m3Config: AppConfig = {
  XMCL_STAGING_M3_PROXY_URL:
    "https://xmcl-shared-sgp-control.azurewebsites.net/api",
  XMCL_STAGING_M3_PROXY_KEY_ID: "staging-m3-worker-v1",
  XMCL_STAGING_M3_PROXY_SECRET:
    "staging-m3-proxy-secret-at-least-thirty-two-bytes",
  XMCL_STAGING_M3_CORS_ORIGINS: "https://staging.launcher.example",
};

class Nonces implements PayPalWebhookProxyNonceStore {
  readonly durable = true as const;
  readonly used = new Set<string>();

  async consume(input: { key: string }) {
    if (this.used.has(input.key)) return false;
    this.used.add(input.key);
    return true;
  }
}

class M3Nonces implements StagingM3ProxyNonceStore {
  readonly durable = true as const;
  readonly used = new Set<string>();

  async consume(input: { key: string }) {
    if (this.used.has(input.key)) return false;
    this.used.add(input.key);
    return true;
  }
}

Deno.test("Cloudflare leaves the payment-disabled app at 404 when webhook proxy config is absent", async () => {
  const response = await worker.fetch(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}`, {
      method: "POST",
    }),
    {},
    {} as never,
  );
  assert.equal(response.status, 404);
});

Deno.test("Cloudflare proxies only the exact PayPal POST, preserving bytes and approved headers", async () => {
  const body = new TextEncoder().encode('{"id":"event_1","unicode":"€"}');
  let outgoing: Request | undefined;
  let options: RequestInit | undefined;
  const response = await proxyPayPalWebhook(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/example",
        "paypal-transmission-id": "transmission_1",
        "paypal-transmission-sig": "signature",
        "paypal-transmission-time": "2026-07-25T09:00:00Z",
        "webhook-id": "provider-webhook-id",
        "x-xmcl-original-target": "/api/attacker",
        "x-not-forwarded": "no",
      },
      body: body as unknown as BodyInit,
    }),
    config,
    async (input, init) => {
      options = init;
      outgoing = new Request(input, init);
      return new Response('{"accepted":true}', {
        status: 202,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-not-returned": "no",
        },
      });
    },
  );

  assert(response);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-not-returned"), null);
  assert.equal(await response.text(), '{"accepted":true}');
  assert(outgoing);
  assert.equal(
    outgoing.url,
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/webhooks/paypal",
  );
  assert.deepEqual(
    new Uint8Array(await outgoing.arrayBuffer()),
    body,
  );
  assert.equal(outgoing.headers.get("paypal-transmission-id"), "transmission_1");
  assert.equal(outgoing.headers.get("paypal-webhook-id"), null);
  assert.equal(outgoing.headers.get("webhook-id"), "provider-webhook-id");
  assert.equal(outgoing.headers.get("x-not-forwarded"), null);
  assert.equal(outgoing.headers.get("x-xmcl-original-target"), null);
  assert.equal(options?.redirect, "manual");
  assert.equal(options?.credentials, "omit");
  assert(options?.signal instanceof AbortSignal);

  const verifier = new HmacPayPalWebhookProxyIdentity({
    keyId: config.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID!,
    secret,
    nonceStore: new Nonces(),
  });
  await verifier.verifyIncoming({
    method: outgoing.method,
    target: PAYPAL_WEBHOOK_AZURE_TARGET,
    headers: outgoing.headers,
    body,
  });
});

Deno.test("Cloudflare refuses malformed destinations and never proxies another method, path, or query", async () => {
  for (const url of [
    "http://control.example/api/v1/webhooks/paypal",
    "https://user:pass@control.example/api/v1/webhooks/paypal",
    "https://control.example/api/v1/webhooks/paypal?next=attacker",
    "https://control.example/api/v1/webhooks/paypal#fragment",
    "https://control.example/api/v1/webhooks/paypal/",
    "https://control.example/api/v1/orders",
  ]) {
    assert.equal(
      paypalWebhookProxySettings({ ...config, PAYPAL_WEBHOOK_PROXY_URL: url }),
      undefined,
    );
  }

  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response();
  };
  for (const request of [
    new Request(`https://worker.example${PAYPAL_WEBHOOK_PATH}`, { method: "GET" }),
    new Request(`https://production.example${PAYPAL_WEBHOOK_PATH}`, {
      method: "POST",
    }),
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/webhooks/paypal/other`, {
      method: "POST",
    }),
  ]) {
    assert.equal(await proxyPayPalWebhook(request, config, fetchImpl), undefined);
  }
  for (const request of [
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}`, {
      method: "GET",
    }),
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}?target=attacker`,
      {
        method: "POST",
      },
    ),
  ]) {
    assert.equal((await proxyPayPalWebhook(request, config, fetchImpl))?.status, 404);
  }
  assert.equal(calls, 0);
});

Deno.test("Cloudflare returns sanitized errors when the fixed backend fails or times out", async () => {
  const request = () => new Request(
    `https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}`,
    { method: "POST", body: "{}" },
  );
  const failed = await proxyPayPalWebhook(
    request(),
    config,
    async () => {
      throw new Error("backend diagnostic must not be returned");
    },
  );
  assert(failed);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    error: "paypal_webhook_proxy_unavailable",
  });

  const timedOut = await proxyPayPalWebhook(
    request(),
    config,
    async () => {
      throw new DOMException("deadline", "TimeoutError");
    },
  );
  assert(timedOut);
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: "paypal_webhook_proxy_unavailable",
  });

  const redirected = await proxyPayPalWebhook(
    request(),
    config,
    async () => new Response(null, {
      status: 302,
      headers: { location: "https://redirect.example/" },
    }),
  );
  assert(redirected);
  assert.equal(redirected.status, 502);
});

Deno.test("Cloudflare proxies only M3 method/path allowlist with raw body, user auth, and idempotency", async () => {
  const body = new TextEncoder().encode('{"amountMinor":100,"unicode":"€"}');
  let outgoing: Request | undefined;
  let options: RequestInit | undefined;
  const response = await proxyStagingM3(
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/paypal/orders`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer session-token",
          "content-type": "application/json",
          "idempotency-key": "order_once",
          origin: "https://staging.launcher.example",
          "x-xmcl-original-target": "/api/attacker",
          "x-not-forwarded": "no",
        },
        body: body as unknown as BodyInit,
      },
    ),
    m3Config,
    async (input, init) => {
      options = init;
      outgoing = new Request(input, init);
      return new Response('{"orderId":"order_1"}', {
        status: 201,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "https://staging.launcher.example",
          "x-not-returned": "no",
        },
      });
    },
  );

  assert(response);
  assert.equal(response.status, 201);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://staging.launcher.example",
  );
  assert.equal(response.headers.get("x-not-returned"), null);
  assert(outgoing);
  assert.equal(
    outgoing.url,
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/paypal/orders",
  );
  assert.deepEqual(new Uint8Array(await outgoing.arrayBuffer()), body);
  assert.equal(outgoing.headers.get("authorization"), "Bearer session-token");
  assert.equal(outgoing.headers.get("idempotency-key"), "order_once");
  assert.equal(outgoing.headers.get("origin"), "https://staging.launcher.example");
  assert.equal(outgoing.headers.get("x-not-forwarded"), null);
  assert.equal(outgoing.headers.get("x-xmcl-original-target"), null);
  assert.equal(options?.redirect, "manual");
  assert.equal(options?.credentials, "omit");
  assert(options?.signal instanceof AbortSignal);

  const verifier = new HmacStagingM3ProxyIdentity({
    keyId: m3Config.XMCL_STAGING_M3_PROXY_KEY_ID!,
    secret: m3Config.XMCL_STAGING_M3_PROXY_SECRET!,
    nonceStore: new M3Nonces(),
  });
  await verifier.verifyIncoming({
    method: outgoing.method,
    target: "/api/v1/billing/paypal/orders",
    headers: outgoing.headers,
    body,
  });
});

Deno.test("Cloudflare M3 proxy rejects all unreviewed paths, queries, methods, and destination settings", async () => {
  for (const url of [
    "http://control.example/api",
    "https://control.example/api/",
    "https://control.example/api?next=attacker",
    "https://control.example/api#fragment",
    "https://user:password@control.example/api",
  ]) {
    assert.equal(
      stagingM3ProxySettings({ ...m3Config, XMCL_STAGING_M3_PROXY_URL: url }),
      undefined,
    );
  }
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response();
  };
  for (const request of [
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/balance?cursor=attacker`,
    ),
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/paypal/orders`,
    ),
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/paypal/orders/not%2Fsafe/capture`,
      { method: "POST" },
    ),
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/paypal/orders/order_1/capture`,
    ),
  ]) {
    assert.equal((await proxyStagingM3(request, m3Config, fetchImpl))?.status, 404);
  }
  assert.equal(
    await proxyStagingM3(
      new Request("https://production.example/v1/billing/balance"),
      m3Config,
      fetchImpl,
    ),
    undefined,
  );
  assert.equal(
    (await proxyStagingM3(
      new Request(
        `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/balance`,
      ),
      {},
      fetchImpl,
    ))?.status,
    404,
  );
  assert.equal(calls, 0);
});

Deno.test("Cloudflare M3 proxy accepts every reviewed endpoint and no others", async () => {
  const calls: string[] = [];
  for (const [method, path] of [
    ["POST", "/v1/billing/paypal/orders"],
    ["POST", "/v1/billing/paypal/orders/order_1/capture"],
    ["GET", "/v1/billing/balance"],
    ["GET", "/v1/billing/rates"],
    ["GET", "/v1/billing/ledger"],
    ["GET", "/v1/billing/usage"],
  ] as const) {
    const response = await proxyStagingM3(
      new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}${path}`, {
        method,
        headers: { authorization: "Bearer session-token" },
        body: method === "POST" ? "{}" : undefined,
      }),
      m3Config,
      async (input) => {
        calls.push(String(input));
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(response?.status, 200);
  }
  assert.deepEqual(calls, [
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/paypal/orders",
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/paypal/orders/order_1/capture",
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/balance",
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/rates",
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/ledger",
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/billing/usage",
  ]);
});

Deno.test("Cloudflare M3 proxy handles only reviewed local preflight requests", () => {
  const accepted = stagingM3CorsPreflight(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/balance`, {
      method: "OPTIONS",
      headers: {
        origin: "https://staging.launcher.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    }),
    m3Config,
  );
  assert(accepted);
  assert.equal(accepted.status, 204);
  assert.equal(
    accepted.headers.get("access-control-allow-origin"),
    "https://staging.launcher.example",
  );
  const rejected = stagingM3CorsPreflight(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/ledger`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    }),
    m3Config,
  );
  assert.equal(rejected?.status, 404);
});

Deno.test("Cloudflare M3 proxy sanitizes redirects and timeout failures", async () => {
  const request = () => new Request(
    `https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/balance`,
    { headers: { authorization: "Bearer session-token" } },
  );
  const redirected = await proxyStagingM3(
    request(),
    m3Config,
    async () => new Response(null, {
      status: 302,
      headers: { location: "https://redirect.example/" },
    }),
  );
  assert(redirected);
  assert.equal(redirected.status, 502);
  assert.deepEqual(await redirected.json(), {
    error: "staging_m3_proxy_unavailable",
  });
  const timedOut = await proxyStagingM3(
    request(),
    m3Config,
    async () => {
      throw new DOMException("deadline", "TimeoutError");
    },
  );
  assert(timedOut);
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), {
    error: "staging_m3_proxy_unavailable",
  });
  const oversized = await proxyStagingM3(
    request(),
    m3Config,
    async () => new Response(new Uint8Array(64 * 1024 + 1)),
  );
  assert(oversized);
  assert.equal(oversized.status, 502);
  const tooLargeRequest = await proxyStagingM3(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/billing/paypal/orders`, {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    }),
    m3Config,
  );
  assert(tooLargeRequest);
  assert.equal(tooLargeRequest.status, 413);
});
