import { createMiddleware } from "hono/factory";
import { getConfig, type AppConfig } from "../config.ts";
import type { Db, DbFactory } from "../db.ts";
import type { AppEnv } from "../types.ts";

/**
 * Creates a DB middleware that exposes a lazy `getDb()` on the context.
 * The `factory` parameter is the platform-specific DB connector.
 */
export function createDbMiddleware(
  factory: DbFactory,
  configResolver: (context: Parameters<typeof getConfig>[0]) => AppConfig =
    getConfig,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const config = configResolver(c);
    // Factories can be global-pool backed (Node/Azure) or per-request
    // (Cloudflare). Cache only in this request context in both cases.
    let dbPromise: Promise<Db> | undefined;
    c.set("getDb", () => {
      dbPromise ??= factory(config);
      return dbPromise;
    });
    await next();
  });
}
