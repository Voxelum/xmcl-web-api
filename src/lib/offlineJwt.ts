import type { AppConfig } from "../config.ts";

const encoder = new TextEncoder();
const DEFAULT_ISSUER = "https://api.xmcl.app";
const DEFAULT_AUDIENCE = "xmcl-ai-routing";
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 900;

export interface OfflineTokenPrincipal {
  accountId: string;
  sessionId: string;
  scopes: string[];
  tier: string;
}

interface PrivateRsaJwk extends JsonWebKey {
  kty: "RSA";
  kid?: string;
  n: string;
  e: string;
  d: string;
}

export class OfflineJwtService {
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly keyId: string;
  private readonly privateJwk: PrivateRsaJwk;
  private readonly previousPublicKeys: ReturnType<typeof publicKey>[];
  private readonly signingKey: Promise<CryptoKey>;

  constructor(config: AppConfig) {
    const rawKey = config.XMCL_OFFLINE_JWT_PRIVATE_JWK;
    if (!rawKey) {
      throw new Error("XMCL_OFFLINE_JWT_PRIVATE_JWK is not set");
    }
    let key: PrivateRsaJwk;
    try {
      key = JSON.parse(rawKey) as PrivateRsaJwk;
    } catch {
      throw new Error("XMCL_OFFLINE_JWT_PRIVATE_JWK must be valid JSON");
    }
    if (
      key.kty !== "RSA" || !key.n || !key.e || !key.d ||
      !key.p || !key.q || !key.dp || !key.dq || !key.qi
    ) {
      throw new Error(
        "XMCL_OFFLINE_JWT_PRIVATE_JWK must be a complete RSA key",
      );
    }

    this.privateJwk = key;
    this.keyId = config.XMCL_OFFLINE_JWT_KEY_ID?.trim() ||
      key.kid?.trim() || "xmcl-offline-1";
    this.issuer = config.XMCL_OFFLINE_JWT_ISSUER?.trim() || DEFAULT_ISSUER;
    this.audience = config.XMCL_OFFLINE_JWT_AUDIENCE?.trim() ||
      DEFAULT_AUDIENCE;
    this.ttlSeconds = parseTtl(config.XMCL_OFFLINE_JWT_TTL_SECONDS);
    this.previousPublicKeys = parsePreviousKeys(
      config.XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS,
      this.keyId,
    );
    this.signingKey = crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  jwks() {
    return {
      keys: [
        publicKey(this.privateJwk, this.keyId),
        ...this.previousPublicKeys,
      ],
    };
  }

  async issue(principal: OfflineTokenPrincipal, now = new Date()) {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const unsigned = `${
      encodeJson({
        alg: "RS256",
        kid: this.keyId,
        typ: "at+jwt",
      })
    }.${
      encodeJson({
        iss: this.issuer,
        aud: this.audience,
        sub: principal.accountId,
        sid: principal.sessionId,
        scope: principal.scopes,
        tier: principal.tier,
        iat: issuedAt,
        exp: expiresAt,
      })
    }`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await this.signingKey,
      encoder.encode(unsigned),
    );
    return {
      accessToken: `${unsigned}.${encodeBytes(new Uint8Array(signature))}`,
      tokenType: "Bearer" as const,
      expiresIn: this.ttlSeconds,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }
}

function publicKey(key: { n: string; e: string }, keyId: string) {
  return {
    kty: "RSA",
    n: key.n,
    e: key.e,
    kid: keyId,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
}

function parsePreviousKeys(value: string | undefined, currentKeyId: string) {
  if (!value?.trim()) return [];
  let jwks: { keys?: Array<Record<string, unknown>> };
  try {
    jwks = JSON.parse(value);
  } catch {
    throw new Error("XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS must be valid JSON");
  }
  if (!Array.isArray(jwks.keys)) {
    throw new Error(
      "XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS must contain a keys array",
    );
  }
  const keyIds = new Set([currentKeyId]);
  return jwks.keys.map((key) => {
    const keyId = typeof key.kid === "string" ? key.kid.trim() : "";
    if (
      key.kty !== "RSA" || typeof key.n !== "string" ||
      typeof key.e !== "string" || !keyId || keyIds.has(keyId)
    ) {
      throw new Error(
        "XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS contains an invalid or duplicate key",
      );
    }
    keyIds.add(keyId);
    return publicKey({ n: key.n, e: key.e }, keyId);
  });
}

function parseTtl(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_TTL_SECONDS;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
    throw new Error(
      `XMCL_OFFLINE_JWT_TTL_SECONDS must be between 60 and ${MAX_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function encodeJson(value: unknown) {
  return encodeBytes(encoder.encode(JSON.stringify(value)));
}

function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
