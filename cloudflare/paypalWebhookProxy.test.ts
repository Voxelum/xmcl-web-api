import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import {
  HmacPayPalWebhookProxyIdentity,
  type PayPalWebhookProxyNonceStore,
} from "../src/lib/paypalWebhookProxyIdentity.ts";
import worker, {
  PAYPAL_WEBHOOK_AZURE_TARGET,
  PAYPAL_WEBHOOK_PATH,
  PAYPAL_WEBHOOK_STAGING_HOST,
  paypalWebhookProxySettings,
  proxyPayPalWebhook,
} from "./worker.ts";

const secret = "paypal-webhook-proxy-secret-at-least-thirty-two-bytes";
const config: AppConfig = {
  PAYPAL_WEBHOOK_PROXY_URL:
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/webhooks/paypal",
  XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID: "paypal-worker-staging-v1",
  XMCL_PAYPAL_WEBHOOK_PROXY_SECRET: secret,
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
  assert.equal(options?.redirect, "error");
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
    new Request(
      `https://${PAYPAL_WEBHOOK_STAGING_HOST}${PAYPAL_WEBHOOK_PATH}?target=attacker`,
      {
        method: "POST",
      },
    ),
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/webhooks/paypal/other`, {
      method: "POST",
    }),
    new Request(`https://production.example${PAYPAL_WEBHOOK_PATH}`, {
      method: "POST",
    }),
  ]) {
    assert.equal(await proxyPayPalWebhook(request, config, fetchImpl), undefined);
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
});
