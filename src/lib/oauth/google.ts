import { RemoteOAuthAdapter } from "./types.ts";

export function createGoogleOAuth(options: {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  fetch?: typeof globalThis.fetch;
  launcherAvailable?: boolean;
}) {
  return new RemoteOAuthAdapter({
    declaration: {
      provider: "google",
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId: options.clientId,
      audience: options.clientId,
      subjectClaim: "sub",
      scopes: ["openid", "profile"],
      redirectUris: options.redirectUris,
      credentialVerification: "oidc_token_and_userinfo",
      launcherAvailable: options.launcherAvailable ?? false,
    },
    clientSecret: options.clientSecret,
    fetch: options.fetch,
    mapUser: (body) => ({ subject: body.sub, displayName: body.name }),
  });
}
