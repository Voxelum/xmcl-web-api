/**
 * Detects the retired legacy `/group/:id` signaling path.
 */
export function isLegacyGroupPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return /^\/group\/[^/]+\/?$/.test(pathname);
}

/**
 * Detects public signaling and AI paths retired by the v1 service URLs.
 */
export function isRetiredServicePath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/ai/chat/completions" ||
    pathname === "/rtc/official";
}

/**
 * Detects the v1 multiplayer room WebSocket and returns its room id.
 */
export function matchMultiplayerUpgrade(
  request: Request,
): string | undefined {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return undefined;
  }
  const { pathname } = new URL(request.url);
  const match = /^\/v1\/multiplayer\/rooms\/([^/]+)\/socket\/?$/.exec(
    pathname,
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Detects a WebSocket upgrade request for `/group/:id` and returns the group id.
 *
 * Used by the platform entry points to intercept realtime upgrades before the
 * Hono app runs, so the CORS middleware never tries to mutate the immutable 101
 * response.
 */
export function matchGroupUpgrade(request: Request): string | undefined {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return undefined;
  }
  const { pathname } = new URL(request.url);
  const match = /^\/group\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}
