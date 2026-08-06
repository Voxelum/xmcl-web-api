import { Hono } from "hono";
import { Range } from "semver";
import { getNofications } from "../notifications.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

export default new Hono<AppEnv>().get("/notifications", async (c) => {
  const version = c.req.query("version") ?? null;
  const os = c.req.query("os") ?? null;
  const arch = c.req.query("arch") ?? null;
  const env = c.req.query("env") ?? null;
  const locale = c.req.query("locale") ?? null;

  try {
    const result = await getNofications(
      os,
      arch,
      env,
      locale,
      version,
      getConfig(c).GITHUB_PAT,
      {
        inRange(version, range) {
          const r = new Range(range);
          return r.test(version);
        },
      },
    );
    return c.json(result, 200, {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    });
  } catch (e) {
    console.warn({
      event: "github.route.unavailable",
      resource: "notifications",
      errorName: e instanceof Error ? e.name : "UnknownError",
    });
    return c.json(
      { error: "github_upstream_unavailable" },
      503,
      { "Retry-After": "60" },
    );
  }
});
