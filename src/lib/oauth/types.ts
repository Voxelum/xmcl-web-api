export type OAuthProvider = "microsoft" | "modrinth" | "google" | "discord";

export interface OAuthProviderDeclaration {
  provider: OAuthProvider;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint?: string;
  userInfoEndpoint: string;
  clientId: string;
  audience: string;
  subjectClaim: string;
  scopes: string[];
  redirectUris: string[];
  credentialVerification:
    | "provider_userinfo"
    | "oidc_token_and_userinfo";
  launcherAvailable: boolean;
}

export interface VerifiedIdentity {
  provider: OAuthProvider;
  subject: string;
  displayName?: string;
}

export interface BrowserExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface LauncherCredential {
  accessToken: string;
  completedAt: string;
}

export interface OAuthProviderAdapter {
  readonly declaration: OAuthProviderDeclaration;
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchange(input: BrowserExchange): Promise<VerifiedIdentity>;
  verifyLauncherCredential(
    input: LauncherCredential,
  ): Promise<VerifiedIdentity>;
}

export type OAuthRegistry = Record<OAuthProvider, OAuthProviderAdapter>;

const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export class OAuthProviderError extends Error {
  constructor(
    readonly code:
      | "provider_unavailable"
      | "provider_rejected"
      | "invalid_provider_credential"
      | "provider_not_configured",
    message = code,
  ) {
    super(message);
  }
}

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" &&
    ["microsoft", "modrinth", "google", "discord"].includes(value);
}

export interface RemoteOAuthOptions {
  declaration: OAuthProviderDeclaration;
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
  mapUser(
    body: Record<string, unknown>,
  ): { subject?: unknown; displayName?: unknown };
}

export class RemoteOAuthAdapter implements OAuthProviderAdapter {
  readonly declaration: OAuthProviderDeclaration;
  private readonly clientSecret?: string;
  private readonly remoteFetch: typeof globalThis.fetch;
  private readonly mapUser: RemoteOAuthOptions["mapUser"];

  constructor(options: RemoteOAuthOptions) {
    this.declaration = options.declaration;
    this.clientSecret = options.clientSecret;
    // Cloudflare's fetch requires the Worker global as its receiver. Keeping an
    // unbound reference works in Node/Deno but throws an illegal-invocation
    // error in Workers when an OAuth adapter calls it later.
    this.remoteFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.mapUser = options.mapUser;
  }

  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }) {
    const url = new URL(this.declaration.authorizationEndpoint);
    url.searchParams.set("client_id", this.declaration.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.declaration.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchange(input: BrowserExchange) {
    if (!this.declaration.tokenEndpoint || !this.declaration.clientId) {
      throw new OAuthProviderError("provider_not_configured");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.declaration.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    let response: Response;
    try {
      response = await this.remoteFetch(this.declaration.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logProviderNetworkFailure(
        this.declaration.provider,
        this.declaration.tokenEndpoint,
        error,
      );
      throw new OAuthProviderError("provider_unavailable");
    }
    if (!response.ok) {
      logProviderRejection(this.declaration.provider, this.declaration.tokenEndpoint, response.status);
      throw new OAuthProviderError("provider_rejected");
    }
    const token = await response.json() as { access_token?: string };
    if (!token.access_token) {
      throw new OAuthProviderError("invalid_provider_credential");
    }
    return await this.verifyAccessToken(token.access_token);
  }

  async verifyLauncherCredential(input: LauncherCredential) {
    if (!this.declaration.launcherAvailable) {
      throw new OAuthProviderError("provider_not_configured");
    }
    return await this.verifyAccessToken(input.accessToken);
  }

  private async verifyAccessToken(
    accessToken: string,
  ): Promise<VerifiedIdentity> {
    let response: Response;
    try {
      response = await this.remoteFetch(this.declaration.userInfoEndpoint, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logProviderNetworkFailure(
        this.declaration.provider,
        this.declaration.userInfoEndpoint,
        error,
      );
      throw new OAuthProviderError("provider_unavailable");
    }
    if (!response.ok) {
      logProviderRejection(
        this.declaration.provider,
        this.declaration.userInfoEndpoint,
        response.status,
      );
      throw new OAuthProviderError("invalid_provider_credential");
    }
    const mapped = this.mapUser(
      await response.json() as Record<string, unknown>,
    );
    if (typeof mapped.subject !== "string" || mapped.subject.length === 0) {
      throw new OAuthProviderError("invalid_provider_credential");
    }
    return {
      provider: this.declaration.provider,
      subject: mapped.subject,
      displayName: typeof mapped.displayName === "string"
        ? mapped.displayName
        : undefined,
    };
  }
}

function logProviderNetworkFailure(
  provider: OAuthProvider,
  endpoint: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("OAuth provider request failed", {
    provider,
    endpointHost: new URL(endpoint).host,
    error: error instanceof Error ? error.name : typeof error,
    message: message.slice(0, 500),
  });
}

function logProviderRejection(
  provider: OAuthProvider,
  endpoint: string,
  status: number,
) {
  console.warn("OAuth provider rejected request", {
    provider,
    endpointHost: new URL(endpoint).host,
    status,
  });
}
