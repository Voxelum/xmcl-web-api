import { createMiddleware } from "hono/factory";
import { getConfig } from "../config.ts";
import type { DbFactory } from "../db.ts";
import type { AppEnv } from "../types.ts";

/**
 * Creates a DB middleware that exposes a lazy `getDb()` on the context.
 * The `factory` parameter is the platform-specific DB connector.
 */
export function createDbMiddleware(factory: DbFactory) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const config = getConfig(c);
    c.set("getDb", () => factory(config));
    await next();
  });
}
