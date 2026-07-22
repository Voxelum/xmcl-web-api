import { RemoteOAuthAdapter } from "./types.ts";

export function createModrinthOAuth(options: {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  fetch?: typeof globalThis.fetch;
}) {
  return new RemoteOAuthAdapter({
    declaration: {
      provider: "modrinth",
      issuer: "https://modrinth.com",
      authorizationEndpoint: "https://modrinth.com/auth/authorize",
      tokenEndpoint: "https://api.modrinth.com/_internal/oauth/token",
      userInfoEndpoint: "https://api.modrinth.com/v2/user",
      clientId: options.clientId,
      audience: options.clientId,
      subjectClaim: "id",
      scopes: ["USER_READ"],
      redirectUris: options.redirectUris,
      credentialVerification: "provider_userinfo",
      launcherAvailable: true,
    },
    clientSecret: options.clientSecret,
    fetch: options.fetch,
    mapUser: (body) => ({ subject: body.id, displayName: body.username }),
  });
}
