import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
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
import { createSessionRoutes } from "../routes/session.ts";
import { ACCESS_TOKEN_TTL_MS, SessionService } from "./session.ts";

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

Deno.test("M1 sessions expire after 24 hours", async () => {
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
  assert.deepEqual(session.scopes, [
    "account:read",
    "account:write",
    "session:manage",
  ]);

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
