import geoip from "geoip-country";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.ts";

/**
 * Resolves the client country from the proxy-forwarded IP using the bundled
 * geoip-country database and stores it as the `country` context variable.
 *
 * Used by the Deno and Azure entry points. It is intentionally NOT part of the
 * shared app or the Cloudflare bundle: geoip-country loads its data file from
 * disk at import time, which is unavailable on workerd (Cloudflare resolves the
 * country natively via `request.cf.country` instead).
 */
export const geoipMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip");
  if (ip) {
    const first = ip.split(",")[0].trim();
    const ipOnly = first.split(":")[0].trim();
    if (ipOnly) {
      const geo = geoip.lookup(ipOnly);
      if (geo?.country) {
        c.set("country", geo.country);
      }
    }
  }
  await next();
});
