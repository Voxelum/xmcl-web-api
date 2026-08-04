import assert from "node:assert/strict";
import { Hono } from "hono";
import { AccountService, MemoryAccountRepository } from "../lib/account.ts";
import { AccountMergeService } from "../lib/accountMerge.ts";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { SessionService } from "../lib/session.ts";
import type { AppEnv } from "../types.ts";
import { createLlmRoutes } from "./llm.ts";
import type { OAuthRegistry } from "../lib/oauth/types.ts";

const sessionSecret = "fixture-only-session-secret-at-least-32-bytes";

async function fixture() {
  const repository = new MemoryAccountRepository();
  const accounts = new AccountService(repository);
  const binding = await accounts.bindIdentity({
    identity: { provider: "microsoft", subject: "llm-user" },
    linkedBy: "web_link",
  });
  binding.account.tier = "pro";
  await repository.saveAccount(binding.account);
  const sessions = new SessionService(repository, sessionSecret);
  const session = await sessions.issue(binding.account.accountId);
  const runtime: AccountRuntime = {
    accounts,
    sessions,
    merges: new AccountMergeService(repository),
    oauth: {} as OAuthRegistry,
  };
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const env = {
    XMCL_OFFLINE_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
    XMCL_OFFLINE_JWT_KEY_ID: "fixture-key",
    XMCL_OFFLINE_JWT_ISSUER: "https://issuer.fixture",
    XMCL_OFFLINE_JWT_AUDIENCE: "xmcl-ai-routing",
    LLM_POOL_SERVICE_SECRET: "fixture-pool-secret",
    LLM_POOL_CONFIG: JSON.stringify({
      pro: [{
        endpoint: "https://llm.fixture/v1/chat/completions",
        model: "fixture-model",
        key: "fixture-provider-key",
      }],
    }),
  };
  const app = new Hono<AppEnv>();
  app.route(
    "/",
    createLlmRoutes(() => Promise.resolve(runtime), () => env),
  );
  return { app, env, session, keys };
}

Deno.test("gateway token is RS256 and carries the account tier", async () => {
  const { app, env, session, keys } = await fixture();
  const response = await app.request(
    "http://localhost/v1/auth/gateway-token",
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
    },
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    accessToken: string;
    expiresIn: number;
  };
  assert.equal(body.expiresIn, 900);
  const [encodedHeader, encodedClaims, encodedSignature] = body.accessToken
    .split(".");
  const header = decodePart(encodedHeader);
  const claims = decodePart(encodedClaims);
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, "fixture-key");
  assert.equal(claims.sub, session.accountId);
  assert.equal(claims.tier, "pro");
  assert.equal(claims.aud, "xmcl-ai-routing");
  assert.equal(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keys.publicKey,
      decodeBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    ),
    true,
  );
});

Deno.test("JWKS publishes only the RSA public key", async () => {
  const { app, env } = await fixture();
  const response = await app.request(
    "http://localhost/.well-known/jwks.json",
    undefined,
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(body.keys[0].kid, "fixture-key");
  assert.equal(body.keys[0].alg, "RS256");
  assert.equal(body.keys[0].d, undefined);
});

Deno.test("LLM pool requires the service secret", async () => {
  const { app, env } = await fixture();
  const denied = await app.request("http://localhost/llm-pool", undefined, env);
  assert.equal(denied.status, 401);

  const response = await app.request(
    "http://localhost/llm-pool",
    { headers: { "x-service-secret": "fixture-pool-secret" } },
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as {
    pro: Array<{ model: string }>;
  };
  assert.equal(body.pro[0].model, "fixture-model");
});

function decodePart(value: string) {
  return JSON.parse(new TextDecoder().decode(decodeBytes(value)));
}

function decodeBytes(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
