import { Hono } from "hono";
import { proxyResponse } from "../proxy.ts";
import { type AppConfig, getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import { DEFAULT_MODRINTH_CLIENT_ID } from "../oauth/modrinth.ts";

export function createModrinthTokenRequest(
  config: AppConfig,
  code: string,
  redirectUri: string,
  userAgent: string,
) {
  const url = new URL("https://api.modrinth.com/_internal/oauth/token");
  const body = new URLSearchParams({
    client_id: config.XMCL_MODRINTH_CLIENT_ID ||
      DEFAULT_MODRINTH_CLIENT_ID,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });
  if (config.XMCL_MODRINTH_CLIENT_SECRET) {
    body.set("client_secret", config.XMCL_MODRINTH_CLIENT_SECRET);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": userAgent,
  };
  if (!config.XMCL_MODRINTH_CLIENT_SECRET && config.MODRINTH_SECRET) {
    headers.Authorization = config.MODRINTH_SECRET;
  }
  return new Request(url, {
    method: "POST",
    headers,
    body,
  });
}

export default new Hono<AppEnv>().get("/modrinth/auth", async (c) => {
  const request = createModrinthTokenRequest(
    getConfig(c),
    c.req.query("code") || "",
    c.req.query("redirect_uri") || "",
    c.req.header("User-Agent") || "",
  );
  const upstream = await fetch(request);

  return proxyResponse(upstream);
});
