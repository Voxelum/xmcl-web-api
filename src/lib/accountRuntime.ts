import type { Context } from "hono";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import { AccountService, MongoAccountRepository } from "./account.ts";
import { AccountMergeService } from "./accountMerge.ts";
import { createDiscordOAuth } from "./oauth/discord.ts";
import { createGoogleOAuth } from "./oauth/google.ts";
import { createMicrosoftOAuth } from "./oauth/microsoft.ts";
import { createModrinthOAuth } from "./oauth/modrinth.ts";
import { createOAuthRedirectPolicy } from "./oauth/redirectPolicy.ts";
import type { OAuthRegistry } from "./oauth/types.ts";
import { SessionService } from "./session.ts";

export interface AccountRuntime {
  accounts: AccountService;
  sessions: SessionService;
  merges: AccountMergeService;
  oauth: OAuthRegistry;
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
      clientSecret: config.XMCL_MICROSOFT_CLIENT_SECRET,
      redirectUris: redirects,
    }),
    modrinth: createModrinthOAuth({
      clientId: config.XMCL_MODRINTH_CLIENT_ID,
      // Existing Workers use MODRINTH_SECRET. Prefer the XMCL-scoped secret,
      // but retain the legacy value while deployments migrate.
      clientSecret: config.XMCL_MODRINTH_CLIENT_SECRET ?? config.MODRINTH_SECRET,
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
  const secret = config.XMCL_SESSION_SECRET;
  if (!secret) throw new Error("XMCL_SESSION_SECRET is not set");
  return {
    accounts: new AccountService(repository),
    sessions: new SessionService(repository, secret),
    merges: new AccountMergeService(repository),
    oauth,
  };
}
