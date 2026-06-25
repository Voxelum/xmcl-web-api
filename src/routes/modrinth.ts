import { Hono } from "hono";
import { proxyResponse } from "../proxy.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

export default new Hono<AppEnv>().get("/modrinth/auth", async (c) => {
  const url = new URL("https://api.modrinth.com/_internal/oauth/token");
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: getConfig(c).MODRINTH_SECRET || "",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": c.req.header("User-Agent") || "",
    },
    body: new URLSearchParams({
      client_id: "GFz0B21y",
      redirect_uri: c.req.query("redirect_uri") || "",
      code: c.req.query("code") || "",
      grant_type: "authorization_code",
    }),
  });

  return proxyResponse(upstream);
});
