import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "./types.ts";
import {
  AccountError,
  AccountService,
  MemoryAccountRepository,
} from "./account.ts";
import { AccountMergeService } from "./accountMerge.ts";
import type { AccountRuntime } from "./accountRuntime.ts";
import type {
  BrowserExchange,
  LauncherCredential,
  OAuthProvider,
  OAuthProviderAdapter,
  VerifiedIdentity,
} from "./oauth/types.ts";
import { createSessionRoutes } from "./routes/session.ts";
import {
  ACCESS_TOKEN_TTL_MS,
  SessionService,
  USER_SESSION_SCOPES,
} from "./session.ts";

const secret = "fixture-only-session-secret-at-least-32-bytes";

class FixtureOAuth implements OAuthProviderAdapter {
  constructor(
    readonly declaration: OAuthProviderAdapter["declaration"],
  ) {}

  authorizationUrl() {
    return "https://provider.fixture.invalid/authorize";
  }

  exchange(input: BrowserExchange): Promise<VerifiedIdentity> {
    return this.identity(input.code);
  }

  verifyLauncherCredential(
    input: LauncherCredential,
  ): Promise<VerifiedIdentity> {
    return this.identity(input.accessToken);
  }

  private identity(value: string): Promise<VerifiedIdentity> {
    const [provider, subject] = value.split(":");
    if (provider !== this.declaration.provider || !subject) {
      return Promise.reject(
        new AccountError(401, "invalid_provider_credential"),
      );
    }
    return Promise.resolve({ provider: provider as OAuthProvider, subject });
  }
}

function fixtureOAuth(provider: OAuthProvider) {
  return new FixtureOAuth({
    provider,
    issuer: "https://provider.fixture.invalid",
    authorizationEndpoint: "https://provider.fixture.invalid/authorize",
    tokenEndpoint: "https://provider.fixture.invalid/token",
    userInfoEndpoint: "https://provider.fixture.invalid/user",
    clientId: "fixture-client",
    audience: "fixture-client",
    subjectClaim: "id",
    scopes: ["openid"],
    redirectUris: [],
    credentialVerification: "provider_userinfo",
    launcherAvailable: true,
  });
}

function createRuntime(now: () => Date): AccountRuntime {
  const repository = new MemoryAccountRepository();
  return {
    accounts: new AccountService(repository, now),
    sessions: new SessionService(repository, secret, now),
    merges: new AccountMergeService(repository, now),
    oauth: {
      microsoft: fixtureOAuth("microsoft"),
      modrinth: fixtureOAuth("modrinth"),
      google: fixtureOAuth("google"),
      discord: fixtureOAuth("discord"),
    },
  };
}

Deno.test("M1 access tokens expire after 10 minutes", async () => {
  let timestamp = Date.parse("2026-07-22T14:00:00.000Z");
  const now = () => new Date(timestamp);
  const runtime = createRuntime(now);
  const account = await runtime.accounts.bindIdentity({
    identity: { provider: "microsoft", subject: "account-user" },
    linkedBy: "web_link",
  });
  const session = await runtime.sessions.issue(account.account.accountId);

  assert.equal(
    Date.parse(session.expiresAt) - Date.parse(session.issuedAt),
    ACCESS_TOKEN_TTL_MS,
  );
  assert.deepEqual(session.scopes, [...USER_SESSION_SCOPES]);

  timestamp += ACCESS_TOKEN_TTL_MS;
  await assert.rejects(
    () => runtime.sessions.verify(session.accessToken),
    (error: unknown) =>
      error instanceof AccountError && error.code === "access_token_expired",
  );
});

Deno.test("M1 launcher exchange recovers from an expired optional bearer", async () => {
  let timestamp = Date.parse("2026-07-22T14:00:00.000Z");
  const now = () => new Date(timestamp);
  const runtime = createRuntime(now);
  const expired = await runtime.sessions.issue("previous-account");
  timestamp += ACCESS_TOKEN_TTL_MS;

  const app = new Hono<AppEnv>();
  app.route("/", createSessionRoutes(() => Promise.resolve(runtime)));
  const response = await app.request(
    "http://localhost/v1/auth/microsoft/launcher-exchange",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${expired.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        loginTransactionId: "launcher-transaction",
        completedAt: now().toISOString(),
        credential: "microsoft:recovered-user",
      }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bindingDisposition, "created");
  assert.equal(body.account.status, "active");
});

Deno.test("M1 concurrent refresh has one winner and revokes replay", async () => {
  const runtime = createRuntime(() => new Date("2026-07-22T14:00:00.000Z"));
  const created = await runtime.sessions.issue("concurrent-refresh-account");

  const results = await Promise.allSettled([
    runtime.sessions.refresh(created.sessionId, created.refreshToken),
    runtime.sessions.refresh(created.sessionId, created.refreshToken),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason.code,
    "refresh_token_replayed",
  );
  const winner = (fulfilled[0] as PromiseFulfilledResult<
    Awaited<ReturnType<SessionService["refresh"]>>
  >).value;
  await assert.rejects(
    () => runtime.sessions.refresh(winner.sessionId, winner.refreshToken),
    (error: unknown) =>
      error instanceof AccountError && error.code === "session_revoked",
  );
});
