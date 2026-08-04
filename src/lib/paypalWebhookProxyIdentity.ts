import type { Db } from "../db.ts";

const encoder = new TextEncoder();
const noncePattern = /^[A-Za-z0-9_-]{16,128}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PAYPAL_WEBHOOK_PROXY_MAX_AGE_MS = 60_000;

export interface PayPalWebhookProxyNonceStore {
  readonly durable: true;
  consume(input: {
    key: string;
    expiresAt: number;
    now: number;
  }): Promise<boolean>;
}

/**
 * Replay keys are isolated from every other workload identity. Mongo's unique
 * `_id` makes concurrent deliveries with the same nonce fail across instances.
 */
export class MongoPayPalWebhookProxyNonceStore
  implements PayPalWebhookProxyNonceStore {
  readonly durable = true as const;

  constructor(private readonly db: Db) {}

  async consume(input: {
    key: string;
    expiresAt: number;
    now: number;
  }): Promise<boolean> {
    if (
      typeof input.key !== "string" || !Number.isSafeInteger(input.expiresAt) ||
      !Number.isSafeInteger(input.now) || input.expiresAt <= input.now
    ) {
      return false;
    }
    const collection = this.db.collection("paypal_webhook_proxy_nonces");
    const id = `paypal-webhook-proxy-hmac:${input.key}`;
    await collection.deleteOne({ _id: id, expiresAt: { $lte: input.now } });
    const result = await collection.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          expiresAt: input.expiresAt,
          createdAt: new Date(input.now).toISOString(),
        },
      },
      { upsert: true },
    ) as { upsertedCount?: number; upsertedId?: unknown };
    return result.upsertedCount === 1 || result.upsertedId !== undefined;
  }
}

export class PayPalWebhookProxyIdentityError extends Error {
  constructor(
    readonly code: "request_identity_rejected" | "request_replayed",
  ) {
    super(code);
    this.name = "PayPalWebhookProxyIdentityError";
  }
}

/**
 * Worker-to-control-plane HMAC identity. It signs the exact method, target,
 * timestamp, nonce, and SHA-256 of the original webhook bytes.
 */
export class HmacPayPalWebhookProxyIdentity {
  private readonly key: Uint8Array;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      keyId: string;
      secret: string;
      nonceStore?: PayPalWebhookProxyNonceStore;
      now?: () => number;
    },
  ) {
    this.key = encoder.encode(options.secret);
    this.now = options.now ?? Date.now;
    if (
      !keyIdPattern.test(options.keyId) || this.key.byteLength < 32 ||
      (options.nonceStore !== undefined && options.nonceStore.durable !== true)
    ) {
      throw new TypeError("invalid PayPal webhook proxy identity configuration");
    }
  }

  async signOutgoing(input: {
    method: string;
    target: string;
    body: Uint8Array;
  }): Promise<Record<string, string>> {
    const timestamp = this.now();
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    if (!validSignedRequest({
      ...input,
      timestamp,
      nonce,
      now: timestamp,
    })) {
      throw new PayPalWebhookProxyIdentityError("request_identity_rejected");
    }
    const signature = await this.signature(
      input.method,
      input.target,
      timestamp,
      nonce,
      input.body,
    );
    return {
      authorization: `HMAC ${this.options.keyId}:${base64Url(signature)}`,
      "x-xmcl-timestamp": String(timestamp),
      "x-xmcl-nonce": nonce,
    };
  }

  async verifyIncoming(input: {
    method: string;
    target: string;
    headers: Headers | Record<string, string | undefined>;
    body: Uint8Array;
  }): Promise<void> {
    const timestamp = parseTimestamp(header(input.headers, "x-xmcl-timestamp"));
    const nonce = header(input.headers, "x-xmcl-nonce");
    const now = this.now();
    if (!validSignedRequest({ ...input, timestamp, nonce, now })) {
      throw new PayPalWebhookProxyIdentityError("request_identity_rejected");
    }
    const actual = parseAuthorization(
      header(input.headers, "authorization"),
      this.options.keyId,
    );
    const expected = await this.signature(
      input.method,
      input.target,
      timestamp,
      nonce!,
      input.body,
    );
    if (!actual || !timingSafeEqual(actual, expected)) {
      throw new PayPalWebhookProxyIdentityError("request_identity_rejected");
    }
    const nonceStore = this.options.nonceStore;
    if (!nonceStore) {
      throw new PayPalWebhookProxyIdentityError("request_identity_rejected");
    }
    if (!await nonceStore.consume({
      key: `${this.options.keyId}:${nonce}`,
      expiresAt: timestamp + PAYPAL_WEBHOOK_PROXY_MAX_AGE_MS,
      now,
    })) {
      throw new PayPalWebhookProxyIdentityError("request_replayed");
    }
  }

  private async signature(
    method: string,
    target: string,
    timestamp: number,
    nonce: string,
    body: Uint8Array,
  ) {
    const bodyHash = hex(
      await crypto.subtle.digest("SHA-256", body as unknown as BufferSource),
    );
    const material = `${method}\n${target}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const key = await crypto.subtle.importKey(
      "raw",
      this.key as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(material)),
    );
  }
}

function validSignedRequest(input: {
  method: string;
  target: string;
  body: Uint8Array;
  timestamp: number;
  nonce?: string;
  now: number;
}) {
  return /^[A-Z]+$/.test(input.method) &&
    input.target.startsWith("/") && input.target.length <= 2_048 &&
    input.body instanceof Uint8Array &&
    Number.isSafeInteger(input.timestamp) &&
    noncePattern.test(input.nonce ?? "") && Number.isSafeInteger(input.now) &&
    Math.abs(input.now - input.timestamp) <= PAYPAL_WEBHOOK_PROXY_MAX_AGE_MS;
}

function parseTimestamp(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return NaN;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : NaN;
}

function parseAuthorization(value: string | undefined, keyId: string) {
  const prefix = `HMAC ${keyId}:`;
  if (!value?.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const decoded = fromBase64Url(encoded);
    return decoded.byteLength === 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function header(
  headers: Headers | Record<string, string | undefined>,
  name: string,
) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()];
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index++) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
