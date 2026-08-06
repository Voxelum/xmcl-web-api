import { normalizeMultiplayerRoomId } from "./multiplayerRoomId.ts";

/**
 * Detects the public AI path retired by the v1 service URL.
 */
export function isRetiredServicePath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === "/ai/chat/completions";
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
  if (!match) return undefined;
  try {
    return normalizeMultiplayerRoomId(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}
