import { createMiddleware } from "hono/factory";
import { getConfig } from "../config.ts";
import { getDb } from "../db.ts";
import type { AppEnv } from "../types.ts";

/**
 * Exposes a lazy `getDb()` on the context. The connection is only opened when a
 * route actually calls it, so DB-free endpoints stay fast and don't require
 * MongoDB configuration.
 */
export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const config = getConfig(c);
  c.set("getDb", () => getDb(config));
  await next();
});
