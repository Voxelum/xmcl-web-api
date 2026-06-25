// deno-lint-ignore-file no-explicit-any
import type { Context } from "hono";
import type { AppEnv } from "./types.ts";

/**
 * Returns true if the request appears to come from mainland China.
 *
 * Resolution order:
 *  1. Cloudflare's native `request.cf.country` (no DB needed on Workers).
 *  2. A `country` context variable set by a platform geo middleware
 *     (e.g. the geoip-country lookup used on Deno/Azure).
 *
 * Defaults to non-CN on any uncertainty, matching the original services
 * (non-CN traffic is routed to GitHub Releases / origin).
 */
export function isChineseRequest(c: Context<AppEnv>): boolean {
  const cfCountry = (c.req.raw as any).cf?.country as string | undefined;
  const country = cfCountry ?? c.get("country");
  return country === "CN";
}
