import assert from "node:assert/strict";
import { Hono } from "hono";
import { MemoryAccountRepository } from "./account.ts";
import { handleAccountError } from "./accountHttp.ts";
import type { AccountRuntime } from "./accountRuntime.ts";
import {
  dpopJwkThumbprint,
  type DpopPublicJwk,
  normalizeHtu,
  verifyDpopProof,
} from "./dpop.ts";
import { xmclAuth } from "./middleware/xmclAuth.ts";
import { createSessionRoutes } from "./routes/session.ts";
import { SessionService } from "./session.ts";
import type { AppEnv } from "./types.ts";

const secret = "fixture-only-session-secret-at-least-32-bytes";

Deno.test("DPoP proof binds method, URL, access token, key, and jti", async () => {
  const key = await createKey();
  const accessToken = "access-token";
  const proof = await signProof(key, {
    method: "GET",
    url: "https://api.xmcl.app/v1/account?ignored=true",
    accessToken,
  });
  const jkt = await dpopJwkThumbprint(key.publicJwk);

  assert.deepEqual(
    await verifyDpopProof({
      proof,
      method: "GET",
      url: "https://api.xmcl.app/v1/account?different=true",
      accessToken,
      expectedJkt: jkt,
    }),
    { jkt, jti: key.lastJti },
  );

  await assert.rejects(
    () =>
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://api.xmcl.app/v1/account",
        accessToken,
        expectedJkt: jkt,
      }),
    (error: unknown) => isAccountError(error, "dpop_proof_replayed"),
  );
});

Deno.test("DPoP proof allows five minutes of past clock skew and one minute of future skew", async () => {
  const key = await createKey();
  const nowSeconds = Math.floor(Date.parse("2026-08-25T00:00:00Z") / 1000);
  const now = new Date(nowSeconds * 1000);
  const url = "https://api.xmcl.app/v1/account";
  let oldestProofExpiresAt = 0;

  for (const issuedAt of [nowSeconds - 300, nowSeconds + 60]) {
    const proof = await signProof(key, {
      method: "GET",
      url,
      issuedAt,
    });
    await verifyDpopProof({
      proof,
      method: "GET",
      url,
      now,
      replayStore: issuedAt === nowSeconds - 300
        ? {
          consume: (_key, expiresAt) => {
            oldestProofExpiresAt = expiresAt;
            return true;
          },
        }
        : undefined,
    });
  }
  assert.ok(oldestProofExpiresAt > now.getTime());

  for (const issuedAt of [nowSeconds - 301, nowSeconds + 61]) {
    const proof = await signProof(key, {
      method: "GET",
      url,
      issuedAt,
    });
    await assert.rejects(
      () =>
        verifyDpopProof({
          proof,
          method: "GET",
          url,
          now,
        }),
      (error: unknown) => isAccountError(error, "invalid_dpop_proof"),
    );
  }
});

Deno.test("DPoP-bound sessions reject Bearer and accept a valid proof", async () => {
  const key = await createKey();
  const repository = new MemoryAccountRepository();
  const sessions = new SessionService(repository, secret);
  const jkt = await dpopJwkThumbprint(key.publicJwk);
  const session = await sessions.issue("acct_dpop", undefined, jkt);
  const runtime = { sessions } as AccountRuntime;
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.get(
    "/protected",
    xmclAuth([], () => Promise.resolve(runtime)),
    (c) => c.json({ accountId: c.get("xmclPrincipal")!.accountId }),
  );

  const bearer = await app.request("http://localhost/protected", {
    headers: { authorization: ["Bearer", session.accessToken].join(" ") },
  });
  assert.equal(bearer.status, 401);
  assert.equal((await bearer.json()).error, "invalid_dpop_proof");

  const proof = await signProof(key, {
    method: "GET",
    url: "http://localhost/protected",
    accessToken: session.accessToken,
  });
  const authenticated = await app.request("http://localhost/protected", {
    headers: {
      authorization: ["DPoP", session.accessToken].join(" "),
      dpop: proof,
    },
  });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { accountId: "acct_dpop" });
});

Deno.test("DPoP-bound refresh requires the same device key", async () => {
  const key = await createKey();
  const otherKey = await createKey();
  const sessions = new SessionService(
    new MemoryAccountRepository(),
    secret,
  );
  const jkt = await dpopJwkThumbprint(key.publicJwk);
  const otherJkt = await dpopJwkThumbprint(otherKey.publicJwk);
  const issued = await sessions.issue("acct_refresh_dpop", undefined, jkt);

  await assert.rejects(
    () => sessions.refresh(issued.sessionId, issued.refreshToken),
    (error: unknown) => isAccountError(error, "invalid_dpop_proof"),
  );
  await assert.rejects(
    () =>
      sessions.refresh(
        issued.sessionId,
        issued.refreshToken,
        otherJkt,
      ),
    (error: unknown) => isAccountError(error, "invalid_dpop_proof"),
  );

  const refreshed = await sessions.refresh(
    issued.sessionId,
    issued.refreshToken,
    jkt,
  );
  assert.equal(refreshed.tokenType, "DPoP");
  assert.equal(refreshed.dpopJkt, jkt);
});

Deno.test("DPoP refresh endpoint verifies a proof without ath", async () => {
  const key = await createKey();
  const sessions = new SessionService(
    new MemoryAccountRepository(),
    secret,
  );
  const jkt = await dpopJwkThumbprint(key.publicJwk);
  const issued = await sessions.issue("acct_refresh_route", undefined, jkt);
  const runtime = { sessions } as AccountRuntime;
  const app = createSessionRoutes(() => Promise.resolve(runtime));
  const url = "http://localhost/v1/sessions/refresh";
  const proof = await signProof(key, { method: "POST", url });

  const response = await app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      dpop: proof,
    },
    body: JSON.stringify({
      sessionId: issued.sessionId,
      refreshToken: issued.refreshToken,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).session.tokenType, "DPoP");
});

async function createKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  ) as DpopPublicJwk;
  return {
    privateKey: pair.privateKey,
    publicJwk,
    lastJti: "",
  };
}

async function signProof(
  key: Awaited<ReturnType<typeof createKey>>,
  input: {
    method: string;
    url: string;
    accessToken?: string;
    issuedAt?: number;
  },
) {
  const header = encodeJson({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: key.publicJwk,
  });
  key.lastJti = crypto.randomUUID();
  const payload = encodeJson({
    jti: key.lastJti,
    htm: input.method,
    htu: normalizeHtu(input.url),
    iat: input.issuedAt ?? Math.floor(Date.now() / 1000),
    ...(input.accessToken
      ? { ath: await sha256Base64Url(input.accessToken) }
      : {}),
  });
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(unsigned),
    ),
  );
  return `${unsigned}.${base64Url(signature)}`;
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

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function isAccountError(error: unknown, code: string) {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
