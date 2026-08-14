import type { Account } from "./account.ts";
import type { AdminBillingOverview } from "./billing.ts";
import type {
  AdminPrincipal,
  AdminPrincipalAuthenticator,
} from "./operations.ts";
import type { XmclPrincipal } from "./session.ts";

const adminSessionLifetimeMs = 15 * 60_000;

export function adminSessionAuthenticator(
  secret: string | undefined,
): AdminPrincipalAuthenticator | undefined {
  if (!secret) return undefined;
  return {
    async authenticate(authorization) {
      const token = authorization?.match(/^Bearer (.+)$/)?.[1];
      return token ? await verifyAdminSession(secret, token) : undefined;
    },
  };
}

export async function issueAdminSession(secret: string, accountId: string) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + adminSessionLifetimeMs);
  const payload = encodePayload({
    version: 1,
    accountId,
    authenticatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return {
    accessToken: `${payload}.${await signPayload(secret, payload)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyAdminSession(
  secret: string,
  token: string,
): Promise<AdminPrincipal | undefined> {
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length > 0) return undefined;
  if (!await secureEqual(signature, await signPayload(secret, payload))) {
    return undefined;
  }
  try {
    const claims = decodePayload(payload);
    const authenticatedAt = Date.parse(String(claims.authenticatedAt));
    const expiresAt = Date.parse(String(claims.expiresAt));
    const now = Date.now();
    if (
      claims.version !== 1 ||
      typeof claims.accountId !== "string" ||
      typeof claims.authenticatedAt !== "string" ||
      typeof claims.expiresAt !== "string" ||
      !Number.isFinite(authenticatedAt) ||
      !Number.isFinite(expiresAt) ||
      authenticatedAt > now + 60_000 ||
      expiresAt <= now ||
      expiresAt <= authenticatedAt ||
      expiresAt - authenticatedAt > adminSessionLifetimeMs + 1_000
    ) return undefined;
    return {
      id: claims.accountId,
      scopes: ["admin"],
      authenticatedAt: claims.authenticatedAt,
    };
  } catch {
    return undefined;
  }
}

export function isRecentBrowserOAuthPrincipal(
  principal: Pick<XmclPrincipal, "authenticatedAt" | "authenticationMethod">,
  now = new Date(),
) {
  if (
    principal.authenticationMethod !== "browser_oauth" ||
    !principal.authenticatedAt
  ) return false;
  const authenticatedAt = Date.parse(principal.authenticatedAt);
  const age = now.getTime() - authenticatedAt;
  return Number.isFinite(authenticatedAt) && age >= -60_000 &&
    age <= adminSessionLifetimeMs;
}

export function verifiedAllowedAdminEmail(
  account: Account,
  allowedEmails: ReadonlySet<string>,
) {
  return account.identities
    .filter((identity) => identity.emailVerified === true)
    .map((identity) => identity.email?.toLowerCase())
    .find((value): value is string => !!value && allowedEmails.has(value));
}

export function publicAdminAccount(account: Account) {
  return {
    accountId: account.accountId,
    status: account.status,
    createdAt: account.createdAt,
    ...(account.deletionEffectiveAt
      ? { deletionEffectiveAt: account.deletionEffectiveAt }
      : {}),
    identities: account.identities.map((identity) => ({
      provider: identity.provider,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      linkedBy: identity.linkedBy,
      linkedAt: identity.linkedAt,
    })),
  };
}

export function billingOnlyAdminAccount(
  accountId: string,
  overview: AdminBillingOverview,
) {
  const exists =
    overview.accounts.some((account) => account.accountId === accountId) ||
    overview.orders.some((order) => order.accountId === accountId) ||
    overview.ledger.some((entry) => entry.accountId === accountId);
  if (!exists) return undefined;
  const activityDates = [
    ...overview.orders
      .filter((order) => order.accountId === accountId)
      .map((order) => order.createdAt),
    ...overview.ledger
      .filter((entry) => entry.accountId === accountId)
      .map((entry) => entry.occurredAt),
  ].sort();
  return {
    accountId,
    status: "active",
    createdAt: activityDates[0] ?? new Date(0).toISOString(),
    identities: [],
  };
}

function encodePayload(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePayload(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
  ) as {
    version?: unknown;
    accountId?: unknown;
    authenticatedAt?: unknown;
    expiresAt?: unknown;
  };
}

async function signPayload(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    ),
  ));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function secureEqual(actual: string, expected: string) {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
