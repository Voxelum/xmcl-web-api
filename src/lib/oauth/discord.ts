import { RemoteOAuthAdapter } from "./types.ts";

export function createDiscordOAuth(options: {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  fetch?: typeof globalThis.fetch;
}) {
  return new RemoteOAuthAdapter({
    declaration: {
      provider: "discord",
      issuer: "https://discord.com",
      authorizationEndpoint: "https://discord.com/oauth2/authorize",
      tokenEndpoint: "https://discord.com/api/oauth2/token",
      userInfoEndpoint: "https://discord.com/api/users/@me",
      clientId: options.clientId,
      audience: options.clientId,
      subjectClaim: "id",
      scopes: ["identify"],
      redirectUris: options.redirectUris,
      credentialVerification: "provider_userinfo",
      // Discord is browser-OAuth-only in the launcher. Browser availability is
      // determined by clientId; launcher-exchange accepts only existing
      // Microsoft and Modrinth credentials.
      launcherAvailable: false,
    },
    clientSecret: options.clientSecret,
    fetch: options.fetch,
    mapUser: (body) => ({
      subject: body.id,
      displayName: body.global_name ?? body.username,
    }),
  });
}
