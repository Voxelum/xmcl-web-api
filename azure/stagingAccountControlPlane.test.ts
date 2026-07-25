import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import type { AccountRuntime } from "../src/lib/accountRuntime.ts";
import {
  HmacStagingAccountProxyIdentity,
} from "../src/lib/stagingAccountProxyIdentity.ts";
import { stagingAccountAzureTarget } from "../src/lib/stagingAccountRoutes.ts";
import type { AppEnv } from "../src/types.ts";
import { createAzureHttpApp } from "./httpApp.ts";
import {
  createAzureStagingAccountControlPlane,
  stagingAccountControlPlaneSettings,
} from "./stagingAccountControlPlane.ts";

const now = 1_785_000_000_000;
const origin = "https://staging.launcher.example";
const secret = "staging-account-proxy-secret-at-least-thirty-two-bytes";
const config: AppConfig = {
  MONGO_CONNECION_STRING: "******mongo.example/control",
  XMCL_SESSION_SECRET: "session-secret-at-least-thirty-two-bytes",
  XMCL_MICROSOFT_CLIENT_ID: "microsoft-client",
  XMCL_MICROSOFT_CLIENT_SECRET: "microsoft-secret",
  XMCL_MODRINTH_CLIENT_ID: "modrinth-client",
  XMCL_MODRINTH_CLIENT_SECRET: "modrinth-secret",
  XMCL_GOOGLE_CLIENT_ID: "google-client",
  XMCL_GOOGLE_CLIENT_SECRET: "google-secret",
  XMCL_DISCORD_CLIENT_ID: "discord-client",
  XMCL_DISCORD_CLIENT_SECRET: "discord-secret",
  XMCL_OAUTH_REDIRECT_URIS: `${origin}/oauth/callback`,
  XMCL_STAGING_ACCOUNT_PROXY_ENABLED: "true",
  XMCL_STAGING_ACCOUNT_PROXY_KEY_ID: "staging-account-worker-v1",
  XMCL_STAGING_ACCOUNT_PROXY_SECRET: secret,
  XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS: origin,
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

function controlApp() {
  const db = nonceDb();
  let authCalls = 0;
  let accountCalls = 0;
  let refreshCalls = 0;
  const runtime = {
    accounts: {
      async requireAccount(accountId: string) {
        accountCalls++;
        return {
          accountId,
          status: "active",
          createdAt: "2026-07-25T00:00:00.000Z",
          identities: [],
        };
      },
    },
    sessions: {
      async verify(token: string) {
        authCalls++;
        if (token !== "user-session") throw new Error("invalid user session");
        return {
          sessionId: "session_1",
          familyId: "family_1",
          accountId: "account_1",
          scopes: ["account:read", "account:write", "session:manage"],
          issuedAt: "2026-07-25T00:00:00.000Z",
          expiresAt: "2026-07-26T00:00:00.000Z",
        };
      },
      async refresh(sessionId: string, refreshToken: string) {
        refreshCalls++;
        assert.equal(sessionId, "session_1");
        assert.equal(refreshToken, "refresh_1");
        return { sessionId, refreshToken: "refresh_2" };
      },
      async revoke() {},
    },
    oauth: {},
    merges: {},
  } as unknown as AccountRuntime;
  const controlPlane = createAzureStagingAccountControlPlane(config, {
    now: () => now,
    resolveAccountRuntime: async () => runtime,
  });
  assert(controlPlane);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("getDb", async () => db);
    await next();
  });
  controlPlane.register(app);
  return {
    app,
    getAuthCalls: () => authCalls,
    getAccountCalls: () => accountCalls,
    getRefreshCalls: () => refreshCalls,
  };
}

async function signedRequest(
  method: "GET" | "POST",
  path: string,
  body = new Uint8Array(),
  options: {
    signerNow?: number;
    bodyOverride?: Uint8Array;
    originalTarget?: string;
    authorization?: string;
  } = {},
) {
  const target = stagingAccountAzureTarget(method, path);
  assert(target);
  const signer = new HmacStagingAccountProxyIdentity({
    keyId: config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID!,
    secret,
    now: () => options.signerNow ?? now,
  });
  const identity = await signer.signOutgoing({ method, target, body });
  return new Request(`https://control.example${path}`, {
    method,
    headers: {
      origin,
      authorization: options.authorization ?? "Bearer user-session",
      "content-type": "application/json",
      "x-xmcl-original-target": options.originalTarget ?? target,
      ...identity,
    },
    body: method === "POST"
      ? (options.bodyOverride ?? body) as unknown as BodyInit
      : undefined,
  });
}

Deno.test("Azure M1 composition fails closed without complete account OAuth, callback, identity, and explicit opt-in", () => {
  for (
    const invalid of [
      { XMCL_STAGING_ACCOUNT_PROXY_ENABLED: undefined },
      { XMCL_STAGING_ACCOUNT_PROXY_ENABLED: "TRUE" },
      { XMCL_STAGING_ACCOUNT_PROXY_SECRET: undefined },
      {
        XMCL_MICROSOFT_CLIENT_ID: undefined,
        XMCL_MICROSOFT_CLIENT_SECRET: undefined,
        XMCL_MODRINTH_CLIENT_ID: undefined,
        XMCL_MODRINTH_CLIENT_SECRET: undefined,
        XMCL_GOOGLE_CLIENT_ID: undefined,
        XMCL_GOOGLE_CLIENT_SECRET: undefined,
        XMCL_DISCORD_CLIENT_ID: undefined,
        XMCL_DISCORD_CLIENT_SECRET: undefined,
      },
      { XMCL_OAUTH_REDIRECT_URIS: "https://other.example/oauth/callback" },
      { XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS: `${origin}/` },
      {
        XMCL_STAGING_M3_PROXY_KEY_ID: config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID,
      },
    ]
  ) {
    assert.equal(
      stagingAccountControlPlaneSettings({ ...config, ...invalid }),
      undefined,
    );
  }
  assert(stagingAccountControlPlaneSettings({
    ...config,
    XMCL_MODRINTH_CLIENT_ID: undefined,
    XMCL_MODRINTH_CLIENT_SECRET: undefined,
    XMCL_GOOGLE_CLIENT_ID: undefined,
    XMCL_GOOGLE_CLIENT_SECRET: undefined,
    XMCL_DISCORD_CLIENT_ID: undefined,
    XMCL_DISCORD_CLIENT_SECRET: undefined,
  }));
  const absent = createAzureHttpApp({
    ...config,
    XMCL_STAGING_ACCOUNT_PROXY_ENABLED: undefined,
  });
  assert.equal(
    absent.routes.some((route) => route.path === "/v1/account"),
    false,
  );
  assert.equal(
    absent.routes.some((route) =>
      route.path === "/v1/auth/:provider/authorize"
    ),
    false,
  );
});

Deno.test("Azure M1 mounts only reviewed account/session routes, never launcher, merge, or deletion", () => {
  const app = createAzureHttpApp(config as Record<string, string>);
  const paths = app.routes.map((route) => route.path);
  for (
    const path of [
      "/v1/auth/:provider/authorize",
      "/v1/auth/:provider/exchange",
      "/v1/sessions/refresh",
      "/v1/sessions/revoke",
      "/v1/account",
      "/v1/account/identities",
      "/v1/account/identities/:provider/authorize",
      "/v1/account/identities/:provider/complete",
      "/v1/account/identities/:provider",
    ]
  ) {
    assert.equal(paths.includes(path), true, path);
  }
  for (
    const path of [
      "/v1/auth/:provider/launcher-exchange",
      "/v1/account/merge/prepare",
      "/v1/account/merge/confirm",
      "/v1/account/deletion",
      "/v1/account/deletion/cancel",
    ]
  ) {
    assert.equal(paths.includes(path), false, path);
  }
});

Deno.test("Azure M1 verifies HMAC before injected account/session handlers and preserves the raw body", async () => {
  const { app, getAuthCalls, getAccountCalls, getRefreshCalls } = controlApp();
  const missing = await app.request("/v1/account", {
    headers: { origin, "x-xmcl-original-target": "/api/v1/account" },
  });
  assert.equal(missing.status, 401);
  assert.equal(getAuthCalls(), 0);
  assert.equal(getAccountCalls(), 0);

  const account = await app.request(await signedRequest("GET", "/v1/account"));
  assert.equal(account.status, 200);
  assert.equal((await account.json()).accountId, "account_1");
  assert.equal(getAuthCalls(), 1);
  assert.equal(getAccountCalls(), 1);
  assert.equal(account.headers.get("access-control-allow-origin"), origin);

  const raw = new TextEncoder().encode(
    '{"sessionId":"session_1","refreshToken":"refresh_1","unicode":"€"}',
  );
  const refreshed = await app.request(
    await signedRequest(
      "POST",
      "/v1/sessions/refresh",
      raw,
    ),
  );
  assert.equal(refreshed.status, 200);
  assert.equal(getRefreshCalls(), 1);
});

Deno.test("Azure M1 rejects stale, replayed, modified, and target-substituted requests before account auth", async () => {
  const { app, getAuthCalls, getRefreshCalls } = controlApp();
  const body = new TextEncoder().encode(
    '{"sessionId":"session_1","refreshToken":"refresh_1"}',
  );
  const modified = await app.request(
    await signedRequest(
      "POST",
      "/v1/sessions/refresh",
      body,
      {
        bodyOverride: new TextEncoder().encode(
          '{"sessionId":"session_1","refreshToken":"attacker"}',
        ),
      },
    ),
  );
  assert.equal(modified.status, 401);

  const stale = await app.request(
    await signedRequest(
      "POST",
      "/v1/sessions/refresh",
      body,
      { signerNow: now - 60_001 },
    ),
  );
  assert.equal(stale.status, 401);

  const targetSwap = await app.request(
    await signedRequest(
      "GET",
      "/v1/account",
      new Uint8Array(),
      { originalTarget: "/api/v1/account/identities" },
    ),
  );
  assert.equal(targetSwap.status, 401);

  const signed = await signedRequest("POST", "/v1/sessions/refresh", body);
  assert.equal((await app.request(signed)).status, 200);
  const replay = await app.request(
    new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: body as unknown as BodyInit,
    }),
  );
  assert.equal(replay.status, 401);
  assert.equal(getAuthCalls(), 0);
  assert.equal(getRefreshCalls(), 1);
});

Deno.test("Azure M1 CORS permits only configured browser origins and rejects unrelated paths", async () => {
  const { app } = controlApp();
  const accepted = await app.request("/v1/account", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("access-control-allow-origin"), origin);

  const rejected = await app.request("/v1/account", {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(rejected.status, 404);
  assert.equal(
    (await app.request("/v1/auth/google/launcher-exchange", {
      method: "POST",
      headers: { origin },
    })).status,
    404,
  );
  assert.equal(
    (await app.request("/v1/internal/usage/authorize", {
      headers: { origin },
    })).status,
    404,
  );
});
