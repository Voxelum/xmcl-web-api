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
