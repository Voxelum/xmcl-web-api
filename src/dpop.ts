import { AccountError } from "./account.ts";

export interface DpopPublicJwk extends JsonWebKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d?: never;
}

export interface DpopReplayStore {
  consume(key: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface VerifyDpopProofInput {
  proof: string;
  method: string;
  url: string;
  accessToken?: string;
  expectedJkt?: string;
  now?: Date;
  replayStore?: DpopReplayStore;
}

const DPOP_PROOF_MAX_AGE_SECONDS = 60;
const DPOP_REPLAY_CAPACITY = 10_000;
const replayCache = new Map<string, number>();

export function parseDpopPublicJwk(value: unknown): DpopPublicJwk | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AccountError(422, "invalid_dpop_key");
    }
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as JsonWebKey).kty !== "EC" ||
    (parsed as JsonWebKey).crv !== "P-256" ||
    typeof (parsed as JsonWebKey).x !== "string" ||
    typeof (parsed as JsonWebKey).y !== "string" ||
    "d" in parsed ||
    !isCoordinate((parsed as JsonWebKey).x!) ||
    !isCoordinate((parsed as JsonWebKey).y!)
  ) {
    throw new AccountError(422, "invalid_dpop_key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: (parsed as JsonWebKey).x!,
    y: (parsed as JsonWebKey).y!,
  };
}

export async function dpopJwkThumbprint(jwk: DpopPublicJwk) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({
            crv: jwk.crv,
            kty: jwk.kty,
            x: jwk.x,
            y: jwk.y,
          }),
        ),
      ),
    ),
  );
}

export async function verifyDpopProof(input: VerifyDpopProofInput) {
  const parts = input.proof.split(".");
  if (parts.length !== 3) invalidProof();

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return invalidProof();
  }
  if (
    header.typ !== "dpop+jwt" || header.alg !== "ES256" ||
    header.jwk === undefined
  ) {
    return invalidProof();
  }

  let jwk: DpopPublicJwk;
  try {
    jwk = parseDpopPublicJwk(header.jwk)!;
  } catch {
    return invalidProof();
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return invalidProof();
  } catch {
    return invalidProof();
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const jti = claims.jti;
  if (
    typeof jti !== "string" || !jti || jti.length > 128 ||
    typeof claims.iat !== "number" || !Number.isInteger(claims.iat) ||
    Math.abs(nowSeconds - claims.iat) > DPOP_PROOF_MAX_AGE_SECONDS ||
    claims.htm !== input.method.toUpperCase() ||
    claims.htu !== normalizeHtu(input.url)
  ) {
    return invalidProof();
  }

  const expectedAth = input.accessToken === undefined
    ? undefined
    : await sha256Base64Url(input.accessToken);
  if (
    expectedAth === undefined
      ? claims.ath !== undefined
      : claims.ath !== expectedAth
  ) {
    return invalidProof();
  }

  const jkt = await dpopJwkThumbprint(jwk);
  if (input.expectedJkt !== undefined && input.expectedJkt !== jkt) {
    return invalidProof();
  }

  const replayKey = `${jkt}:${jti}`;
  const expiresAt = (claims.iat + DPOP_PROOF_MAX_AGE_SECONDS) * 1000;
  const consumed = await (input.replayStore ?? memoryReplayStore).consume(
    replayKey,
    expiresAt,
  );
  if (!consumed) {
    throw new AccountError(401, "dpop_proof_replayed");
  }
  return { jkt, jti };
}

export function normalizeHtu(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidProof();
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function sha256Base64Url(value: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      ),
    ),
  );
}

const memoryReplayStore: DpopReplayStore = {
  consume(key, expiresAt) {
    const now = Date.now();
    for (const [candidate, expiry] of replayCache) {
      if (expiry <= now) replayCache.delete(candidate);
    }
    if (replayCache.has(key)) return false;
    if (replayCache.size >= DPOP_REPLAY_CAPACITY) {
      replayCache.delete(replayCache.keys().next().value!);
    }
    replayCache.set(key, expiresAt);
    return true;
  },
};

function isCoordinate(value: string) {
  try {
    return decodeBase64Url(value).length === 32 &&
      base64Url(decodeBase64Url(value)) === value;
  } catch {
    return false;
  }
}

function decodeJson(value: string) {
  const parsed = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(value)),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalidProof();
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function invalidProof(): never {
  throw new AccountError(401, "invalid_dpop_proof");
}
