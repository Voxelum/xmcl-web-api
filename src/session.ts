import {
  AccountError,
  type AccountRepository,
  randomId,
  type SessionRecord,
  sha256,
} from "./account.ts";

export interface XmclPrincipal {
  sessionId: string;
  familyId: string;
  accountId: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  dpopJkt?: string;
}

export interface PublicSession extends XmclPrincipal {
  accessToken: string;
  refreshToken: string;
  tokenType?: "Bearer" | "DPoP";
}

/** Scopes issued to first-party browser and launcher user sessions. */
export const USER_SESSION_SCOPES = [
  "account:read",
  "account:write",
  "session:manage",
  "ai:invoke",
  "modpack:read",
  "modpack:write",
] as const;

export const ACCESS_TOKEN_TTL_MS = 10 * 60_000;

export function requiresLegacySessionCheck(principal: XmclPrincipal) {
  return Date.parse(principal.expiresAt) - Date.parse(principal.issuedAt) >
    ACCESS_TOKEN_TTL_MS;
}

interface AccessClaims {
  iss: "xmcl";
  sub: string;
  sid: string;
  fid: string;
  scope: string[];
  iat: number;
  exp: number;
  cnf?: { jkt: string };
}

function encodeJson(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeJson(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return JSON.parse(binary);
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export class AccessTokenVerifier {
  constructor(
    protected readonly secret: string,
    protected readonly now: () => Date = () => new Date(),
  ) {
    if (secret.length < 32) {
      throw new Error("XMCL_SESSION_SECRET must be at least 32 characters");
    }
  }

  async verify(accessToken: string): Promise<XmclPrincipal> {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new AccountError(401, "invalid_access_token");
    let validSignature = false;
    try {
      const supplied = decodeBase64Url(parts[2]);
      validSignature = await crypto.subtle.verify(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(this.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        ),
        supplied,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
    } catch {
      validSignature = false;
    }
    if (!validSignature) {
      throw new AccountError(401, "invalid_access_token");
    }
    let header: { alg?: unknown; typ?: unknown };
    let claims: AccessClaims;
    try {
      header = decodeJson(parts[0]) as typeof header;
      claims = decodeJson(parts[1]) as AccessClaims;
    } catch {
      throw new AccountError(401, "invalid_access_token");
    }
    if (
      header.alg !== "HS256" || header.typ !== "JWT" ||
      claims.iss !== "xmcl" ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.sid !== "string" || !claims.sid ||
      typeof claims.fid !== "string" || !claims.fid ||
      !Array.isArray(claims.scope) ||
      !claims.scope.every((scope) => typeof scope === "string") ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      (claims.cnf !== undefined &&
        (typeof claims.cnf !== "object" ||
          claims.cnf === null ||
          typeof claims.cnf.jkt !== "string" ||
          !claims.cnf.jkt)) ||
      claims.exp <= claims.iat
    ) {
      throw new AccountError(401, "invalid_access_token");
    }
    if (claims.exp <= Math.floor(this.now().getTime() / 1000)) {
      throw new AccountError(401, "access_token_expired");
    }
    return {
      sessionId: claims.sid,
      familyId: claims.fid,
      accountId: claims.sub,
      scopes: claims.scope,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      dpopJkt: claims.cnf?.jkt,
    };
  }
}

export class SessionService extends AccessTokenVerifier {
  constructor(
    private readonly repository: AccountRepository,
    secret: string,
    now: () => Date = () => new Date(),
  ) {
    super(secret, now);
  }

  override async verify(accessToken: string): Promise<XmclPrincipal> {
    const principal = await super.verify(accessToken);
    return requiresLegacySessionCheck(principal)
      ? await this.requireActiveSession(principal)
      : principal;
  }

  async issue(
    accountId: string,
    scopes: readonly string[] = USER_SESSION_SCOPES,
    dpopJkt?: string,
  ): Promise<PublicSession> {
    const now = this.now();
    const sessionId = randomId("ses");
    const refreshToken = randomId("rfr");
    const record: SessionRecord = {
      sessionId,
      familyId: randomId("fam"),
      accountId,
      scopes: [...scopes],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
      dpopJkt,
      refreshHash: await sha256(refreshToken),
      consumedRefreshHashes: [],
      refreshExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000)
        .toISOString(),
    };
    await this.repository.saveSession(record);
    const account = await this.repository.getAccount(accountId);
    if (account) {
      account.sessionIds = [
        ...new Set([...(account.sessionIds ?? []), sessionId]),
      ];
      await this.repository.saveAccount(account);
    }
    return await this.toPublic(record, refreshToken);
  }

  async refresh(
    sessionId: string,
    refreshToken: string,
    dpopPresentation?:
      | string
      | ((expectedJkt?: string) => Promise<string | undefined>),
  ): Promise<PublicSession> {
    const record = await this.repository.getSession(sessionId);
    if (!record) throw new AccountError(401, "invalid_refresh_token");
    if (record.revokedAt) throw new AccountError(401, "session_revoked");
    const dpopJkt = typeof dpopPresentation === "function"
      ? await dpopPresentation(record.dpopJkt)
      : dpopPresentation;
    if (record.dpopJkt !== dpopJkt) {
      throw new AccountError(401, "invalid_dpop_proof");
    }
    if (Date.parse(record.refreshExpiresAt) <= this.now().getTime()) {
      throw new AccountError(401, "refresh_token_expired");
    }
    const tokenHash = await sha256(refreshToken);
    if (record.consumedRefreshHashes.includes(tokenHash)) {
      const revokedAt = this.now().toISOString();
      const revoked = await this.repository.revokeSessionIfRefreshConsumed(
        sessionId,
        tokenHash,
        revokedAt,
      );
      if (!revoked) {
        const latest = await this.repository.getSession(sessionId);
        if (latest?.revokedAt) {
          throw new AccountError(401, "session_revoked");
        }
      }
      throw new AccountError(401, "refresh_token_replayed");
    }
    if (tokenHash !== record.refreshHash) {
      throw new AccountError(401, "invalid_refresh_token");
    }
    const expectedRefreshHash = record.refreshHash;
    record.consumedRefreshHashes.push(record.refreshHash);
    const nextRefreshToken = randomId("rfr");
    record.refreshHash = await sha256(nextRefreshToken);
    const rotatedAt = this.now();
    record.issuedAt = rotatedAt.toISOString();
    record.expiresAt = new Date(rotatedAt.getTime() + ACCESS_TOKEN_TTL_MS)
      .toISOString();
    const rotated = await this.repository.rotateSessionRefresh(
      record,
      expectedRefreshHash,
      rotatedAt.toISOString(),
    );
    if (!rotated) {
      const revoked = await this.repository.revokeSessionIfRefreshConsumed(
        sessionId,
        tokenHash,
        rotatedAt.toISOString(),
      );
      if (revoked) {
        throw new AccountError(401, "refresh_token_replayed");
      }
      const latest = await this.repository.getSession(sessionId);
      if (!latest) throw new AccountError(401, "invalid_refresh_token");
      if (latest.revokedAt) throw new AccountError(401, "session_revoked");
      if (Date.parse(latest.refreshExpiresAt) <= rotatedAt.getTime()) {
        throw new AccountError(401, "refresh_token_expired");
      }
      throw new AccountError(401, "invalid_refresh_token");
    }
    return await this.toPublic(record, nextRefreshToken);
  }

  async revoke(accountId: string, sessionId: string | "all") {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new AccountError(404, "account_not_found");
    const ids = sessionId === "all" ? account.sessionIds ?? [] : [sessionId];
    if (sessionId !== "all" && !ids.includes(sessionId)) {
      throw new AccountError(404, "session_not_found");
    }
    for (const id of ids) {
      const record = await this.repository.getSession(id);
      if (!record || record.accountId !== accountId) {
        if (sessionId !== "all") {
          throw new AccountError(404, "session_not_found");
        }
        continue;
      }
      record.revokedAt ??= this.now().toISOString();
      await this.repository.saveSession(record);
    }
  }

  async requireActiveSession(
    principal: XmclPrincipal,
  ): Promise<XmclPrincipal> {
    const record = await this.repository.getSession(principal.sessionId);
    if (
      !record || record.revokedAt || record.accountId !== principal.accountId ||
      record.familyId !== principal.familyId
    ) {
      throw new AccountError(401, "session_revoked");
    }
    return principal;
  }

  private async toPublic(
    record: SessionRecord,
    refreshToken: string,
  ): Promise<PublicSession> {
    const iat = Math.floor(Date.parse(record.issuedAt) / 1000);
    const exp = Math.floor(Date.parse(record.expiresAt) / 1000);
    const claims: AccessClaims = {
      iss: "xmcl",
      sub: record.accountId,
      sid: record.sessionId,
      fid: record.familyId,
      scope: record.scopes,
      iat,
      exp,
      ...(record.dpopJkt ? { cnf: { jkt: record.dpopJkt } } : {}),
    };
    const unsigned = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${
      encodeJson(claims)
    }`;
    const accessToken = `${unsigned}.${
      encodeBytes(await hmac(this.secret, unsigned))
    }`;
    return {
      sessionId: record.sessionId,
      familyId: record.familyId,
      accountId: record.accountId,
      scopes: record.scopes,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      dpopJkt: record.dpopJkt,
      accessToken,
      refreshToken,
      tokenType: record.dpopJkt ? "DPoP" : "Bearer",
    };
  }
}
