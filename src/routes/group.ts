import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types.ts";

// The legacy group protocol was used by old presence and multiplayer clients.
// It is intentionally retired so those clients cannot create billable realtime
// connections; the new v2 multiplayer protocol owns signaling now.
export default new Hono<AppEnv>().get("/group/:id", (c) => {
  throw new HTTPException(410, {
    message: "Legacy group signaling is no longer supported",
  });
});
