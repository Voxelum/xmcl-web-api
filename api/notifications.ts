import { Router } from "oak";
import { Range } from "https://deno.land/std@0.178.0/semver/mod.ts";
import { getNofications } from "../shared/notifications.ts";

export interface Notification {
  created_at: Date
  updated_at: Date
  id: string
  title: string
  body: string
  tags: string[]
}

export default new Router().get("/notifications", async (ctx) => {
  const request = ctx.request;

  const version = request.url.searchParams.get("version");
  const osRelease = request.url.searchParams.get("osRelease");
  const os = request.url.searchParams.get("os");
  const arch = request.url.searchParams.get("arch");
  const env = request.url.searchParams.get("env");
  const build = request.url.searchParams.get("build");
  const locale = request.url.searchParams.get("locale");

  try {
    const result = await getNofications(os, arch, env, locale, version, Deno.env.get('GITHUB_PAT'), {
      inRange(version, range) {
        const r = new Range(range);
        return r.test(version);
      },
    })
    ctx.response.status = 200;
    ctx.response.headers.set("Content-Type", "application/json");
    ctx.response.body = result;
  } catch (e) {
    ctx.response.status = 400;
    ctx.response.body = {
      error: "Failed to fetch notifications",
      message: (e as any).message,
    };
  }
})