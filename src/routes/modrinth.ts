import { Hono } from "hono";
import { proxyResponse } from "../proxy.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import {
  DEFAULT_MODRINTH_CLIENT_ID,
} from "../lib/oauth/modrinth.ts";

export default new Hono<AppEnv>().get("/modrinth/auth", async (c) => {
  const config = getConfig(c);
  const url = new URL("https://api.modrinth.com/_internal/oauth/token");
  const body = new URLSearchParams({
    client_id: config.XMCL_MODRINTH_CLIENT_ID ||
      DEFAULT_MODRINTH_CLIENT_ID,
    redirect_uri: c.req.query("redirect_uri") || "",
    code: c.req.query("code") || "",
    grant_type: "authorization_code",
  });
  if (config.XMCL_MODRINTH_CLIENT_SECRET) {
    body.set("client_secret", config.XMCL_MODRINTH_CLIENT_SECRET);
  }
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": c.req.header("User-Agent") || "",
    },
    body,
  });

  return proxyResponse(upstream);
});
