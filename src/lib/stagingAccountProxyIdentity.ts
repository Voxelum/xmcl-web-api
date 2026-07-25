import type { Db } from "../db.ts";

const encoder = new TextEncoder();
const noncePattern = /^[A-Za-z0-9_-]{16,128}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const STAGING_ACCOUNT_PROXY_MAX_AGE_MS = 60_000;
export const STAGING_ACCOUNT_PROXY_MAX_BODY_BYTES = 64 * 1024;

const headers = {
  keyId: "x-xmcl-staging-account-key-id",
  timestamp: "x-xmcl-staging-account-timestamp",
  nonce: "x-xmcl-staging-account-nonce",
  signature: "x-xmcl-staging-account-signature",
} as const;

export interface StagingAccountProxyNonceStore {
  readonly durable: true;
  consume(input: {
    key: string;
    expiresAt: number;
    now: number;
  }): Promise<boolean>;
}

/** A separate durable namespace prevents cross-protocol nonce reuse. */
export class MongoStagingAccountProxyNonceStore
  implements StagingAccountProxyNonceStore {
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
    const collection = this.db.collection("staging_account_proxy_nonces");
    const id = `staging-account-proxy-hmac:${input.key}`;
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

export class StagingAccountProxyIdentityError extends Error {
  constructor(
    readonly code: "request_identity_rejected" | "request_replayed",
  ) {
    super(code);
    this.name = "StagingAccountProxyIdentityError";
  }
}

/** Dedicated Worker-to-Azure identity for M1 account/session proxy requests. */
export class HmacStagingAccountProxyIdentity {
  private readonly key: Uint8Array;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      keyId: string;
      secret: string;
      nonceStore?: StagingAccountProxyNonceStore;
      now?: () => number;
    },
  ) {
    this.key = encoder.encode(options.secret);
    this.now = options.now ?? Date.now;
    if (
      !keyIdPattern.test(options.keyId) || this.key.byteLength < 32 ||
      (options.nonceStore !== undefined && options.nonceStore.durable !== true)
    ) {
      throw new TypeError(
        "invalid staging account proxy identity configuration",
      );
    }
  }

  async signOutgoing(input: {
    method: string;
    target: string;
    body: Uint8Array;
  }): Promise<Record<string, string>> {
    const timestamp = this.now();
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    if (!validSignedRequest({ ...input, timestamp, nonce, now: timestamp })) {
      throw new StagingAccountProxyIdentityError("request_identity_rejected");
    }
    return {
      [headers.keyId]: this.options.keyId,
      [headers.timestamp]: String(timestamp),
      [headers.nonce]: nonce,
      [headers.signature]: base64Url(
        await this.signature(
          input.method,
          input.target,
          timestamp,
          nonce,
          input.body,
        ),
      ),
    };
  }

  async verifyIncoming(input: {
    method: string;
    target: string;
    headers: Headers | Record<string, string | undefined>;
    body: Uint8Array;
  }): Promise<void> {
    const timestamp = parseTimestamp(header(input.headers, headers.timestamp));
    const nonce = header(input.headers, headers.nonce);
    const keyId = header(input.headers, headers.keyId);
    const now = this.now();
    if (
      keyId !== this.options.keyId ||
      !validSignedRequest({ ...input, timestamp, nonce, now })
    ) {
      throw new StagingAccountProxyIdentityError("request_identity_rejected");
    }
    const actual = parseSignature(header(input.headers, headers.signature));
    const expected = await this.signature(
      input.method,
      input.target,
      timestamp,
      nonce!,
      input.body,
    );
    if (!actual || !timingSafeEqual(actual, expected)) {
      throw new StagingAccountProxyIdentityError("request_identity_rejected");
    }
    const nonceStore = this.options.nonceStore;
    if (!nonceStore) {
      throw new StagingAccountProxyIdentityError("request_identity_rejected");
    }
    if (
      !await nonceStore.consume({
        key: `${this.options.keyId}:${nonce}`,
        expiresAt: now + STAGING_ACCOUNT_PROXY_MAX_AGE_MS,
        now,
      })
    ) {
      throw new StagingAccountProxyIdentityError("request_replayed");
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
    const material =
      `${method}\n${target}\n${timestamp}\n${nonce}\n${bodyHash}`;
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

export class StagingAccountProxyBodyTooLargeError extends Error {
  constructor() {
    super("staging account proxy request exceeds the maximum size");
    this.name = "StagingAccountProxyBodyTooLargeError";
  }
}

export async function readStagingAccountProxyRawBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength && /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > STAGING_ACCOUNT_PROXY_MAX_BODY_BYTES
  ) {
    throw new StagingAccountProxyBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > STAGING_ACCOUNT_PROXY_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new StagingAccountProxyBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
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
    input.target.startsWith("/") && input.target.length <= 4_096 &&
    !/[\r\n]/.test(input.target) &&
    input.body instanceof Uint8Array &&
    input.body.byteLength <= STAGING_ACCOUNT_PROXY_MAX_BODY_BYTES &&
    Number.isSafeInteger(input.timestamp) &&
    noncePattern.test(input.nonce ?? "") && Number.isSafeInteger(input.now) &&
    Math.abs(input.now - input.timestamp) <= STAGING_ACCOUNT_PROXY_MAX_AGE_MS;
}

function parseTimestamp(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return NaN;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : NaN;
}

function parseSignature(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = fromBase64Url(value);
    return decoded.byteLength === 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function header(
  values: Headers | Record<string, string | undefined>,
  name: string,
) {
  if (values instanceof Headers) return values.get(name) ?? undefined;
  return values[name] ?? values[name.toLowerCase()];
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
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
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
