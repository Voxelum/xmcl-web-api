import assert from "node:assert/strict";
import { Hono } from "hono";
import sharedBackupStoragePolicyFixture from "../../contracts/shared/v1/fixtures/backup-storage-policy.json" with {
  type: "json",
};
import type { AppEnv } from "../types.ts";
import { AccountService, MemoryAccountRepository, sha256 } from "./account.ts";
import { AccountMergeService } from "./accountMerge.ts";
import type { AccountRuntime } from "./accountRuntime.ts";
import { accountApiFixtures } from "./account.fixtures.ts";
import {
  type OAuthProvider,
  type OAuthProviderAdapter,
  OAuthProviderError,
  type VerifiedIdentity,
} from "./oauth/types.ts";
import { SessionService, USER_SESSION_SCOPES } from "./session.ts";
import { createAccountRoutes } from "../routes/account.ts";
import { createAiRoutes } from "../routes/ai.ts";
import { createModpackDeploymentRoutes } from "../routes/modpackDeployments.ts";
import { createSessionRoutes } from "../routes/session.ts";
import { createBackupStoragePolicyRoutes } from "../routes/backupStoragePolicy.ts";
import { createGoogleOAuth } from "./oauth/google.ts";
import { createMicrosoftOAuth } from "./oauth/microsoft.ts";

const secret = "fixture-only-session-secret-at-least-32-bytes";

class FixtureOAuth implements OAuthProviderAdapter {
  constructor(readonly declaration: OAuthProviderAdapter["declaration"]) {}
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    const query = new URLSearchParams({
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: input.redirectUri,
    });
    return `https://fixture.invalid/authorize?${query}`;
  }
  exchange(input: { code: string }) {
    return this.identity(input.code);
  }
  verifyLauncherCredential(input: { accessToken: string }) {
    return this.identity(input.accessToken);
  }
  private identity(value: string): Promise<VerifiedIdentity> {
    if (value === "provider-down") {
      return Promise.reject(new OAuthProviderError("provider_unavailable"));
    }
    const [provider, subject, displayName] = value.split(":");
    if (provider !== this.declaration.provider || !subject) {
      return Promise.reject(
        new OAuthProviderError("invalid_provider_credential"),
      );
    }
    return Promise.resolve({
      provider: provider as OAuthProvider,
      subject,
      displayName,
    });
  }
}

function setup() {
  const repository = new MemoryAccountRepository();
  const accounts = new AccountService(repository);
  const sessions = new SessionService(repository, secret);
  const declarations = (
    ["microsoft", "modrinth", "google", "discord"] as const
  ).map((provider) =>
    new FixtureOAuth({
      provider,
      issuer: `https://${provider}.fixture.invalid`,
      authorizationEndpoint: "https://fixture.invalid/authorize",
      tokenEndpoint: "https://fixture.invalid/token",
      userInfoEndpoint: "https://fixture.invalid/me",
      clientId: `${provider}-fixture-client`,
      audience: `${provider}-fixture-client`,
      subjectClaim: "id",
      scopes: ["openid"],
      redirectUris: ["https://xmcl.app/oauth/callback"],
      credentialVerification: "provider_userinfo",
      launcherAvailable: provider === "microsoft" || provider === "modrinth",
    })
  );
  const runtime: AccountRuntime = {
    accounts,
    sessions,
    merges: new AccountMergeService(repository),
    oauth: {
      microsoft: declarations[0],
      modrinth: declarations[1],
      google: declarations[2],
      discord: declarations[3],
    },
  };
  const resolve = () => Promise.resolve(runtime);
  const app = new Hono<AppEnv>();
  app.route("/", createSessionRoutes(resolve));
  app.route("/", createAccountRoutes(resolve));
  return { app, runtime, repository };
}

async function launcher(
  app: Hono<AppEnv>,
  provider: OAuthProvider,
  subject: string,
  authorization?: string,
  transaction = crypto.randomUUID(),
) {
  return await app.request(`/v1/auth/${provider}/launcher-exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({
      loginTransactionId: transaction,
      completedAt: new Date().toISOString(),
      credential: `${provider}:${subject}:Fixture User`,
    }),
  });
}

Deno.test("launcher exchange creates an account and rejects transaction replay", async () => {
  const { app } = setup();
  const transaction = crypto.randomUUID();
  const response = await launcher(
    app,
    "microsoft",
    "ms-subject-1",
    undefined,
    transaction,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.bindingDisposition, "created");
  assert.equal(result.account.status, "active");
  assert.ok(result.session.accessToken);
  assert.ok(result.session.refreshToken);

  const replay = await launcher(
    app,
    "microsoft",
    "ms-subject-1",
    undefined,
    transaction,
  );
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, "launcher_transaction_replayed");
});

Deno.test("browser OAuth binds redirect, state, nonce and PKCE to a one-time transaction", async () => {
  const { app } = setup();
  const verifier = "fixture-pkce-verifier-with-enough-entropy";
  const state = "fixture-state";
  const authorize = await app.request(
    `/v1/auth/google/authorize?redirectUri=${
      encodeURIComponent("https://xmcl.app/oauth/callback")
    }&state=${state}&codeChallenge=${await sha256(verifier)}`,
  );
  assert.equal(authorize.status, 200);
  const authorization = await authorize.json();
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("state"), state);
  assert.ok(authorizationUrl.searchParams.get("nonce"));
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge_method"),
    "S256",
  );

  const exchange = () =>
    app.request("/v1/auth/google/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transactionId: authorization.transactionId,
        state,
        codeVerifier: verifier,
        code: "google:google-subject:Google User",
      }),
    });

  const first = await exchange();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).bindingDisposition, "created");
  const replay = await exchange();
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, "oauth_transaction_replayed");
});

Deno.test("browser and launcher sessions receive the user scopes required by AI and modpack routes", async () => {
  const { app, runtime } = setup();
  const launcherSession = await (await launcher(app, "microsoft", "scopes"))
    .json();
  const verifier = "browser-scope-fixture-verifier";
  const state = "browser-scope-state";
  const authorization = await (
    await app.request(
      `/v1/auth/google/authorize?redirectUri=${
        encodeURIComponent("https://xmcl.app/oauth/callback")
      }&state=${state}&codeChallenge=${await sha256(verifier)}`,
    )
  ).json();
  const browserExchange = await app.request("/v1/auth/google/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionId: authorization.transactionId,
      state,
      codeVerifier: verifier,
      code: "google:browser-scope:Browser User",
    }),
  });
  assert.equal(browserExchange.status, 200);
  const browserSession = (await browserExchange.json()).session;
  const expectedScopes = [...USER_SESSION_SCOPES];
  assert.deepEqual(launcherSession.session.scopes, expectedScopes);
  assert.deepEqual(browserSession.scopes, expectedScopes);

  const routes = new Hono<AppEnv>();
  const resolve = () => Promise.resolve(runtime);
  routes.route("/", createAiRoutes(resolve, () => ({ models: [] })));
  routes.route(
    "/",
    createModpackDeploymentRoutes(
      {
        coordinator: {
          getImport: async () => ({ importId: "import_scope" }),
        } as never,
      },
      resolve,
    ),
  );
  const headers = {
    authorization: `Bearer ${browserSession.accessToken}`,
  };
  assert.equal(
    (await routes.request("/v1/ai/models", { headers })).status,
    200,
  );
  assert.equal(
    (await routes.request("/v1/modpack-imports/import_scope", { headers }))
      .status,
    200,
  );
});

Deno.test("OAuth transactions reject state mismatch, invalid redirects, and expiry", async () => {
  let now = new Date("2026-07-22T14:00:00.000Z");
  const repository = new MemoryAccountRepository();
  const service = new AccountService(repository, () => now);
  await assert.rejects(
    () =>
      service.createAuthorization({
        provider: "discord",
        intent: "sign_in",
        redirectUri: "https://attacker.invalid/callback",
        state: "state",
        codeChallenge: "challenge",
        allowedRedirectUris: ["https://xmcl.app/oauth/callback"],
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_oauth_request",
  );
  const transaction = await service.createAuthorization({
    provider: "discord",
    intent: "sign_in",
    redirectUri: "https://xmcl.app/oauth/callback",
    state: "expected",
    codeChallenge: await sha256("verifier"),
    allowedRedirectUris: ["https://xmcl.app/oauth/callback"],
  });
  await assert.rejects(
    () =>
      service.consumeAuthorization({
        transactionId: transaction.transactionId,
        provider: "discord",
        state: "wrong",
        codeVerifier: "verifier",
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "oauth_state_mismatch",
  );
  now = new Date("2026-07-22T14:11:00.000Z");
  await assert.rejects(
    () =>
      service.consumeAuthorization({
        transactionId: transaction.transactionId,
        provider: "discord",
        state: "expected",
        codeVerifier: "verifier",
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "oauth_transaction_expired",
  );
});

Deno.test("authenticated launcher link reports identity conflict without account details", async () => {
  const { app } = setup();
  const first = await (await launcher(app, "microsoft", "first")).json();
  const second = await (await launcher(app, "modrinth", "second")).json();
  const conflict = await launcher(
    app,
    "modrinth",
    "second",
    `Bearer ${first.session.accessToken}`,
  );
  assert.equal(
    conflict.status,
    accountApiFixtures.errors.identityConflict.status,
  );
  const body = await conflict.json();
  assert.equal(body.error, "identity_conflict");
  assert.deepEqual(body.details, { mergeAvailable: true });
  assert.equal(JSON.stringify(body).includes(second.account.accountId), false);
});

Deno.test("refresh rotates tokens and replay revokes the family", async () => {
  const { app } = setup();
  const created = await (await launcher(app, "microsoft", "refresh")).json();
  const request = (refreshToken: string) =>
    app.request("/v1/sessions/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: created.session.sessionId,
        refreshToken,
      }),
    });
  const rotated = await request(created.session.refreshToken);
  assert.equal(rotated.status, 200);
  const next = (await rotated.json()).session;
  assert.notEqual(next.refreshToken, created.session.refreshToken);

  const replay = await request(created.session.refreshToken);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "refresh_token_replayed");
  const revoked = await request(next.refreshToken);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error, "session_revoked");
});

Deno.test("account routes enforce scope and prevent unlinking the final identity", async () => {
  const { app, runtime } = setup();
  const unauthenticated = await app.request("/v1/account");
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error, "authentication_required");
  const created = await (await launcher(app, "microsoft", "scope")).json();
  const readOnly = await runtime.sessions.issue(created.account.accountId, [
    "account:read",
  ]);
  const forbidden = await app.request(
    "/v1/account/identities/microsoft",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${readOnly.accessToken}` },
    },
  );
  assert.equal(forbidden.status, accountApiFixtures.errors.permission.status);
  assert.equal((await forbidden.json()).error, "insufficient_scope");

  const last = await app.request("/v1/account/identities/microsoft", {
    method: "DELETE",
    headers: { authorization: `Bearer ${created.session.accessToken}` },
  });
  assert.equal(last.status, 409);
  assert.equal((await last.json()).error, "last_identity");
});

Deno.test("identity responses omit stable provider subjects", async () => {
  const { app } = setup();
  const created = await (await launcher(app, "microsoft", "private-subject"))
    .json();

  const response = await app.request("/v1/account/identities", {
    headers: { authorization: `Bearer ${created.session.accessToken}` },
  });

  assert.equal(response.status, 200);
  const identities = await response.json();
  assert.deepEqual(identities, [{
    provider: "microsoft",
    displayName: "Fixture User",
    linkedBy: "launcher_bootstrap",
    linkedAt: identities[0].linkedAt,
  }]);
  assert.equal(JSON.stringify(identities).includes("private-subject"), false);
});

Deno.test("Account sessions authenticate the published shared v1 backup-policy endpoint", async () => {
  const { runtime } = setup();
  const session = await runtime.sessions.issue("acct_shared_v1");
  const app = new Hono<AppEnv>();
  app.route(
    "/",
    createBackupStoragePolicyRoutes(() => Promise.resolve(runtime)),
  );

  const response = await app.request("/v1/backup-storage-policy", {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), sharedBackupStoragePolicyFixture);
});

Deno.test("merge is explicit, audited, and idempotent", async () => {
  const { app, repository } = setup();
  const destination = await (await launcher(app, "microsoft", "merge-a"))
    .json();
  const source = await (await launcher(app, "modrinth", "merge-b")).json();
  const headers = {
    authorization: `Bearer ${destination.session.accessToken}`,
    "content-type": "application/json",
  };
  const prepare = await app.request("/v1/account/merge/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "modrinth",
      credential: "modrinth:merge-b:Source",
      completedAt: new Date().toISOString(),
    }),
  });
  assert.equal(prepare.status, 200);
  const preview = await prepare.json();
  const confirmBody = JSON.stringify({
    mergeId: preview.mergeId,
    confirmed: true,
  });
  const confirm = () =>
    app.request("/v1/account/merge/confirm", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "merge-once" },
      body: confirmBody,
    });
  const first = await confirm();
  const retry = await confirm();
  assert.equal(first.status, 202);
  assert.equal(retry.status, 202);
  assert.equal((await first.json()).taskId, (await retry.json()).taskId);
  assert.equal(
    repository.accounts.get(source.account.accountId)?.status,
    "merged",
  );
  assert.equal(repository.audits.at(-1)?.action, "account.merge_completed");
});

Deno.test("deletion request retries return one task and cancellation restores account", async () => {
  const { app, repository } = setup();
  const created = await (await launcher(app, "microsoft", "delete")).json();
  const headers = {
    authorization: `Bearer ${created.session.accessToken}`,
    "idempotency-key": "delete-once",
  };
  const request = () =>
    app.request("/v1/account/deletion", { method: "POST", headers });
  const first = await request();
  const retry = await request();
  assert.equal(first.status, 202);
  assert.equal(retry.status, 202);
  assert.equal((await first.json()).taskId, (await retry.json()).taskId);

  const cancel = await app.request("/v1/account/deletion/cancel", {
    method: "POST",
    headers,
  });
  assert.equal(cancel.status, 204);
  assert.equal(
    repository.accounts.get(created.account.accountId)?.status,
    "active",
  );
});

Deno.test("provider failures return a stable response without credential leakage", async () => {
  const { app } = setup();
  const credential = "provider-down";
  const response = await app.request("/v1/auth/microsoft/launcher-exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_fixture_provider",
    },
    body: JSON.stringify({
      loginTransactionId: crypto.randomUUID(),
      completedAt: new Date().toISOString(),
      credential,
    }),
  });
  assert.equal(
    response.status,
    accountApiFixtures.errors.providerFailure.status,
  );
  const text = await response.text();
  assert.equal(JSON.parse(text).error, "provider_unavailable");
  assert.equal(text.includes(credential), false);
});

Deno.test("provider declarations gate launcher availability and declare verification metadata", async () => {
  const google = createGoogleOAuth({
    clientId: "google-fixture",
    redirectUris: ["https://xmcl.app/oauth/callback"],
    fetch: () => Promise.reject(new Error("must not fetch")),
  });
  assert.equal(google.declaration.launcherAvailable, false);
  assert.equal(google.declaration.issuer, "https://accounts.google.com");
  assert.equal(google.declaration.subjectClaim, "sub");
  await assert.rejects(
    () =>
      google.verifyLauncherCredential({
        accessToken: "not-a-real-token",
        completedAt: new Date().toISOString(),
      }),
    (error: unknown) =>
      error instanceof OAuthProviderError &&
      error.code === "provider_not_configured",
  );

  const microsoft = createMicrosoftOAuth({
    clientId: "microsoft-fixture",
    redirectUris: ["https://xmcl.app/oauth/callback"],
  });
  assert.equal(microsoft.declaration.launcherAvailable, true);
  assert.equal(microsoft.declaration.audience, "https://graph.microsoft.com");
  assert.deepEqual(microsoft.declaration.scopes, [
    "openid",
    "profile",
    "User.Read",
  ]);
});
