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
}

export interface PublicSession extends XmclPrincipal {
  accessToken: string;
  refreshToken: string;
}

/** Scopes issued to first-party browser and launcher user sessions. */
export const USER_SESSION_SCOPES = [
  "account:read",
  "account:write",
  "session:manage",
] as const;

export const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60_000;

interface AccessClaims {
  iss: "xmcl";
  sub: string;
  sid: string;
  fid: string;
  scope: string[];
  iat: number;
  exp: number;
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

export class SessionService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secret.length < 32) {
      throw new Error("XMCL_SESSION_SECRET must be at least 32 characters");
    }
  }

  async issue(
    accountId: string,
    scopes: readonly string[] = USER_SESSION_SCOPES,
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
  ): Promise<PublicSession> {
    const record = await this.repository.getSession(sessionId);
    if (!record) throw new AccountError(401, "invalid_refresh_token");
    if (record.revokedAt) throw new AccountError(401, "session_revoked");
    if (Date.parse(record.refreshExpiresAt) <= this.now().getTime()) {
      throw new AccountError(401, "refresh_token_expired");
    }
    const tokenHash = await sha256(refreshToken);
    if (record.consumedRefreshHashes.includes(tokenHash)) {
      record.revokedAt = this.now().toISOString();
      await this.repository.saveSession(record);
      throw new AccountError(401, "refresh_token_replayed");
    }
    if (tokenHash !== record.refreshHash) {
      throw new AccountError(401, "invalid_refresh_token");
    }
    record.consumedRefreshHashes.push(record.refreshHash);
    const nextRefreshToken = randomId("rfr");
    record.refreshHash = await sha256(nextRefreshToken);
    record.issuedAt = this.now().toISOString();
    record.expiresAt = new Date(this.now().getTime() + ACCESS_TOKEN_TTL_MS)
      .toISOString();
    await this.repository.saveSession(record);
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

  async verify(accessToken: string): Promise<XmclPrincipal> {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new AccountError(401, "invalid_access_token");
    let validSignature = false;
    try {
      const expected = await hmac(this.secret, `${parts[0]}.${parts[1]}`);
      const supplied = decodeBase64Url(parts[2]);
      validSignature = expected.length === supplied.length &&
        await crypto.subtle.verify(
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
    let claims: AccessClaims;
    try {
      claims = decodeJson(parts[1]) as AccessClaims;
    } catch {
      throw new AccountError(401, "invalid_access_token");
    }
    if (
      claims.iss !== "xmcl" || !claims.sub || !claims.sid ||
      !Array.isArray(claims.scope) ||
      claims.exp <= Math.floor(this.now().getTime() / 1000)
    ) {
      throw new AccountError(401, "access_token_expired");
    }
    const record = await this.repository.getSession(claims.sid);
    if (
      !record || record.revokedAt || record.accountId !== claims.sub ||
      record.familyId !== claims.fid
    ) {
      throw new AccountError(401, "session_revoked");
    }
    return {
      sessionId: claims.sid,
      familyId: claims.fid,
      accountId: claims.sub,
      scopes: claims.scope,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
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
      accessToken,
      refreshToken,
    };
  }
}
