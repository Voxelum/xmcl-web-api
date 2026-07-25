export const STAGING_M3_AZURE_API_PREFIX = "/api";

const readPaths = new Set([
  "/v1/billing/balance",
  "/v1/billing/rates",
  "/v1/billing/ledger",
  "/v1/billing/usage",
]);
const createOrderPath = "/v1/billing/paypal/orders";
const captureOrderPattern =
  /^\/v1\/billing\/paypal\/orders\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/capture$/;

/**
 * Returns the one Azure public target that a staging M3 request may sign and
 * proxy. It deliberately has no query-string support: these route handlers do
 * not implement reviewed pagination semantics yet.
 */
export function stagingM3AzureTarget(method: string, path: string) {
  if (
    method === "GET" && readPaths.has(path) ||
    method === "POST" && (
      path === createOrderPath || captureOrderPattern.test(path)
    )
  ) {
    return `${STAGING_M3_AZURE_API_PREFIX}${path}`;
  }
  return undefined;
}

/** Identifies malformed or wrong-method M3 checkout paths that must not fall through. */
export function isStagingM3PathCandidate(path: string) {
  return readPaths.has(path) ||
    path === createOrderPath ||
    path.startsWith(`${createOrderPath}/`);
}

export function isStagingM3CorsRequest(
  method: string | undefined,
  path: string,
) {
  return typeof method === "string" &&
    stagingM3AzureTarget(method.toUpperCase(), path) !== undefined;
}

export const STAGING_M3_CORS_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
] as const;
