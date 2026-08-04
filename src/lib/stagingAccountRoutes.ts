export const STAGING_ACCOUNT_AZURE_API_PREFIX = "/api";

const providerPattern = "(?:microsoft|modrinth|google|discord)";
const authorizePattern = new RegExp(
  `^/v1/auth/${providerPattern}/authorize$`,
);
const exchangePattern = new RegExp(
  `^/v1/auth/${providerPattern}/exchange$`,
);
const identityAuthorizePattern = new RegExp(
  `^/v1/account/identities/${providerPattern}/authorize$`,
);
const identityCompletePattern = new RegExp(
  `^/v1/account/identities/${providerPattern}/complete$`,
);
const identityPattern = new RegExp(
  `^/v1/account/identities/${providerPattern}$`,
);

const fixedRoutes = new Map<string, readonly string[]>([
  ["/v1/account", ["GET"]],
  ["/v1/account/identities", ["GET"]],
  ["/v1/sessions/refresh", ["POST"]],
  ["/v1/sessions/revoke", ["POST"]],
]);

export const STAGING_ACCOUNT_CORS_HEADERS = [
  "authorization",
  "content-type",
] as const;

/**
 * Returns the one Azure target that a staging M1 request may sign and proxy.
 * OAuth authorize is the sole route with a query string, whose exact original
 * encoding is retained in the signed target after its decoded values pass the
 * narrow schema below.
 */
export function stagingAccountAzureTarget(
  method: string,
  path: string,
  search = "",
) {
  if (
    method === "GET" && authorizePattern.test(path) &&
    validAuthorizeQuery(search)
  ) {
    return `${STAGING_ACCOUNT_AZURE_API_PREFIX}${path}${search}`;
  }
  if (
    method === "POST" &&
    (exchangePattern.test(path) || identityAuthorizePattern.test(path) ||
      identityCompletePattern.test(path)) &&
    !search
  ) {
    return `${STAGING_ACCOUNT_AZURE_API_PREFIX}${path}`;
  }
  if (method === "DELETE" && identityPattern.test(path) && !search) {
    return `${STAGING_ACCOUNT_AZURE_API_PREFIX}${path}`;
  }
  if (!search && fixedRoutes.get(path)?.includes(method)) {
    return `${STAGING_ACCOUNT_AZURE_API_PREFIX}${path}`;
  }
  return undefined;
}

/** Identifies only documented M1 route shapes, including wrong methods. */
export function isStagingAccountPathCandidate(path: string) {
  return authorizePattern.test(path) || exchangePattern.test(path) ||
    identityAuthorizePattern.test(path) || identityCompletePattern.test(path) ||
    identityPattern.test(path) || fixedRoutes.has(path);
}

export function isStagingAccountCorsRequest(
  method: string | undefined,
  path: string,
  search = "",
) {
  return typeof method === "string" &&
    stagingAccountAzureTarget(method.toUpperCase(), path, search) !== undefined;
}

/**
 * OAuth browser callbacks are limited to the configured Pages origins. This is
 * checked in both proxy hops so a compromised Worker binding cannot turn Azure
 * into a redirect broker for any other configured account callback.
 */
export function authorizeQueryUsesConfiguredCallback(
  search: string,
  corsOrigins: readonly string[],
) {
  if (!validAuthorizeQuery(search)) return false;
  const redirectUri = new URLSearchParams(search).get("redirectUri");
  if (redirectUri === null) return false;
  try {
    const origin = new URL(redirectUri).origin;
    return corsOrigins.includes(origin) &&
      redirectUri === `${origin}/oauth/callback`;
  } catch {
    return false;
  }
}

function validAuthorizeQuery(search: string) {
  if (!search || search.length > 4_000) return false;
  const query = new URLSearchParams(search);
  const allowed = new Set(["redirectUri", "state", "codeChallenge"]);
  const seen = new Set<string>();
  for (const [name] of query) {
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  if (seen.size !== allowed.size) return false;
  const redirectUri = query.get("redirectUri");
  const state = query.get("state");
  const codeChallenge = query.get("codeChallenge");
  return !!redirectUri && redirectUri.length <= 1_024 &&
    !!state && state.length <= 512 && /^[\x21-\x7e]+$/.test(state) &&
    !!codeChallenge && /^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge);
}
