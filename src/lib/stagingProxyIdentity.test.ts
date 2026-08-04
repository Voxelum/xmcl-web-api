import assert from "node:assert/strict";
import {
  HmacPayPalWebhookProxyIdentity,
  type PayPalWebhookProxyNonceStore,
} from "./paypalWebhookProxyIdentity.ts";
import {
  HmacStagingAccountProxyIdentity,
  type StagingAccountProxyNonceStore,
} from "./stagingAccountProxyIdentity.ts";
import {
  HmacStagingM3ProxyIdentity,
  type StagingM3ProxyNonceStore,
} from "./stagingM3ProxyIdentity.ts";

const secret = "proxy-identity-test-secret-at-least-thirty-two-bytes";
const body = new TextEncoder().encode("{}");
const signedAt = 160_000;
const verifiedAt = 100_000;

class Nonces implements
  StagingM3ProxyNonceStore,
  StagingAccountProxyNonceStore,
  PayPalWebhookProxyNonceStore {
  readonly durable = true as const;
  expiresAt?: number;

  async consume(input: { expiresAt: number }) {
    this.expiresAt = input.expiresAt;
    return true;
  }
}

for (const [name, identity] of [
  ["M3", HmacStagingM3ProxyIdentity],
  ["M1", HmacStagingAccountProxyIdentity],
  ["PayPal", HmacPayPalWebhookProxyIdentity],
] as const) {
  Deno.test(`${name} proxy retains a future-dated nonce until the signature expires`, async () => {
    const nonces = new Nonces();
    const signer = new identity({
      keyId: "test-key",
      secret,
      now: () => signedAt,
    });
    const verifier = new identity({
      keyId: "test-key",
      secret,
      nonceStore: nonces,
      now: () => verifiedAt,
    });
    const headers = await signer.signOutgoing({
      method: "POST",
      target: "/api/test",
      body,
    });
    await verifier.verifyIncoming({
      method: "POST",
      target: "/api/test",
      headers,
      body,
    });
    assert.equal(nonces.expiresAt, signedAt + 60_000);
  });
}
