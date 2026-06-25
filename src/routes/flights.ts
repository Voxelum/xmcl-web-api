import { Hono } from "hono";
import { getFlights } from "../shared/flights.ts";
import type { AppEnv } from "../types.ts";


export default new Hono<AppEnv>().get("/flights", (c) => {
  const version = c.req.query("version") ?? null;
  const locale = c.req.query("locale") ?? null;
  const build = c.req.query("build") ?? null;

  if (!version || !locale) {
    return c.json({});
  }

  return c.json(getFlights(version, locale, build));
});
