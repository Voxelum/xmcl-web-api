import { Hono } from "hono";
import { forwardHeaders, proxyResponse } from "../proxy.ts";
import type { AppEnv } from "../types.ts";

export default new Hono<AppEnv>().get("/elyby/authlib", async (c) => {
  const upstream = await fetch(
    "https://raw.githubusercontent.com/Voxelum/xmcl-static-resource/refs/heads/main/elyby.json",
    { headers: forwardHeaders(c.req.raw) },
  );
  return proxyResponse(upstream);
});
