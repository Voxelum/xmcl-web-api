import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types.ts";

// Realtime group messaging. On platforms with realtime support (Deno,
// Cloudflare) the WebSocket upgrade is intercepted by the platform entry point
// before the app runs (so CORS never touches the 101 response). Anything that
// reaches this handler is either a non-WebSocket request or an unsupported
// platform (Azure), so we respond 501.
export default new Hono<AppEnv>().get("/group/:id", (c) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    throw new HTTPException(501, { message: "Expected websocket upgrade" });
  }
  throw new HTTPException(501, { message: "Realtime is not supported on this platform" });
});
