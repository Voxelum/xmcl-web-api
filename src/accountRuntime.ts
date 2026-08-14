import type { Context } from "hono";
import { getConfig, type AppConfig } from "./config.ts";
import type { AppEnv } from "./types.ts";
import { AccountService, MongoAccountRepository } from "./account.ts";
import { AccountMergeService } from "./accountMerge.ts";
import { createDiscordOAuth } from "./oauth/discord.ts";
import { createGoogleOAuth } from "./oauth/google.ts";
import { createMicrosoftOAuth } from "./oauth/microsoft.ts";
import { createModrinthOAuth } from "./oauth/modrinth.ts";
import { createOAuthRedirectPolicy } from "./oauth/redirectPolicy.ts";
import type { OAuthRegistry } from "./oauth/types.ts";
import {
  AccessTokenVerifier,
  requiresLegacySessionCheck,
  SessionService,
} from "./session.ts";

export interface AccountRuntime {
  accounts: AccountService;
  sessions: SessionService;
  merges: AccountMergeService;
  oauth: OAuthRegistry;
}

function configuredSessionSecrets(config: AppConfig) {
  const previous = config.XMCL_SESSION_SECRET;
  const primary = config.XMCL_SESSION_SECRET_PRIMARY ?? previous;
  if (!primary) throw new Error("XMCL_SESSION_SECRET is not set");
  return {
    primary,
    additionalVerificationSecrets: previous && previous !== primary
      ? [previous]
      : [],
  };
}

export function getAccessTokenVerifier(c: Context<AppEnv>) {
  const secrets = configuredSessionSecrets(getConfig(c));
  return new AccessTokenVerifier(
    secrets.primary,
    undefined,
    secrets.additionalVerificationSecrets,
  );
}

export async function verifyAccessToken(
  c: Context<AppEnv>,
  accessToken: string,
) {
  const principal = await getAccessTokenVerifier(c).verify(accessToken);
  if (!requiresLegacySessionCheck(principal)) return principal;
  return await (await getAccountRuntime(c)).sessions.requireActiveSession(
    principal,
  );
}

export async function getAccountRuntime(
  c: Context<AppEnv>,
): Promise<AccountRuntime> {
  const overridden = c.get("accountRuntime");
  if (overridden) return overridden;
  const db = await c.get("getDb")();
  const config = getConfig(c);
  const repository = new MongoAccountRepository(db);
  const redirectPolicy = createOAuthRedirectPolicy(
    (config.XMCL_OAUTH_REDIRECT_URIS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const redirects = [...redirectPolicy.declaredRedirectUris];
  const oauth: OAuthRegistry = {
    microsoft: createMicrosoftOAuth({
      clientId: config.XMCL_MICROSOFT_CLIENT_ID ?? "",
      redirectUris: redirects,
    }),
    modrinth: createModrinthOAuth({
      clientId: config.XMCL_MODRINTH_CLIENT_ID,
      clientSecret: config.XMCL_MODRINTH_CLIENT_SECRET,
      redirectUris: redirects,
    }),
    google: createGoogleOAuth({
      clientId: config.XMCL_GOOGLE_CLIENT_ID ?? "",
      clientSecret: config.XMCL_GOOGLE_CLIENT_SECRET,
      redirectUris: redirects,
    }),
    discord: createDiscordOAuth({
      clientId: config.XMCL_DISCORD_CLIENT_ID ?? "",
      clientSecret: config.XMCL_DISCORD_CLIENT_SECRET,
      redirectUris: redirects,
    }),
  };
  const secrets = configuredSessionSecrets(config);
  return {
    accounts: new AccountService(repository),
    sessions: new SessionService(
      repository,
      secrets.primary,
      undefined,
      secrets.additionalVerificationSecrets,
    ),
    merges: new AccountMergeService(repository),
    oauth,
  };
}
