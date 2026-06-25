import { Hono } from "hono";
import { Range } from "semver";
import { getNofications } from "../shared/notifications.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

export default new Hono<AppEnv>().get("/notifications", async (c) => {
  const version = c.req.query("version") ?? null;
  const os = c.req.query("os") ?? null;
  const arch = c.req.query("arch") ?? null;
  const env = c.req.query("env") ?? null;
  const locale = c.req.query("locale") ?? null;

  try {
    const result = await getNofications(os, arch, env, locale, version, getConfig(c).GITHUB_PAT, {
      inRange(version, range) {
        const r = new Range(range);
        return r.test(version);
      },
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: "Failed to fetch notifications", message: (e as Error).message },
      400,
    );
  }
});
