import { RemoteOAuthAdapter } from "./types.ts";

export function createMicrosoftOAuth(options: {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  fetch?: typeof globalThis.fetch;
}) {
  return new RemoteOAuthAdapter({
    declaration: {
      provider: "microsoft",
      issuer: "https://login.microsoftonline.com/common/v2.0",
      authorizationEndpoint:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint:
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userInfoEndpoint: "https://graph.microsoft.com/v1.0/me",
      clientId: options.clientId,
      audience: "https://graph.microsoft.com",
      subjectClaim: "id",
      scopes: ["openid", "profile", "User.Read"],
      redirectUris: options.redirectUris,
      credentialVerification: "provider_userinfo",
      launcherAvailable: true,
    },
    clientSecret: options.clientSecret,
    fetch: options.fetch,
    mapUser: (body) => ({
      subject: body.id,
      displayName: body.displayName,
    }),
  });
}
