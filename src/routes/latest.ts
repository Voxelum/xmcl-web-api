import { Hono } from "hono";
import { gte, lt } from "semver";
import { getLatest } from "../shared/latest.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

export default new Hono<AppEnv>().get("/latest", async (c) => {
  const includePrerelease = c.req.query("prerelease") !== undefined;
  const version = c.req.query("version") ?? null;
  const langs = c.req.header("Accept-Language") ?? null;

  const result = await getLatest(
    includePrerelease,
    version,
    langs,
    getConfig(c).GITHUB_PAT,
    {
      gte,
      lt,
    },
  );

  return c.json(result);
});
