import { RemoteOAuthAdapter } from "./types.ts";

export const DEFAULT_MODRINTH_CLIENT_ID = "GFz0B21y";

export function createModrinthOAuth(options: {
  clientId?: string;
  clientSecret?: string;
  redirectUris: string[];
  fetch?: typeof globalThis.fetch;
}) {
  const clientId = options.clientId || DEFAULT_MODRINTH_CLIENT_ID;
  return new RemoteOAuthAdapter({
    declaration: {
      provider: "modrinth",
      issuer: "https://modrinth.com",
      authorizationEndpoint: "https://modrinth.com/auth/authorize",
      tokenEndpoint: "https://api.modrinth.com/_internal/oauth/token",
      userInfoEndpoint: "https://api.modrinth.com/v2/user",
      clientId,
      audience: clientId,
      subjectClaim: "id",
      scopes: ["USER_READ"],
      redirectUris: options.redirectUris,
      credentialVerification: "provider_userinfo",
      launcherAvailable: true,
    },
    clientSecret: options.clientSecret,
    // Modrinth's token endpoint expects the client secret as the raw
    // Authorization header, unlike the other OAuth providers.
    clientSecretLocation: "authorization",
    fetch: options.fetch,
    mapUser: (body) => ({ subject: body.id, displayName: body.username }),
  });
}
