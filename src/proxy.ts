/**
 * Helpers for the pass-through proxy routes (zulu, elyby, modrinth), which
 * forward to an upstream and relay its response. Mirrors the Oak routes that
 * passed `ctx.request.headers` through and re-emitted the upstream response.
 */

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

/** Copy incoming request headers minus hop-by-hop ones unsafe to forward. */
export function forwardHeaders(req: Request): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

/** Re-emit an upstream response, dropping headers the runtime will recompute. */
export function proxyResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}
