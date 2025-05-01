import { gte, lt } from "https://deno.land/std@0.178.0/semver/mod.ts";
import { Router } from "oak";
import { getLatest } from "../shared/latest.ts";


export default new Router().get("/latest", async (ctx) => {
  const request = ctx.request;
  const includePrerelease = request.url.searchParams.has("prerelease");
  const version = request.url.searchParams.get("version");
  const langs = request.headers.get("Accept-Language");

  const result = await getLatest(!!includePrerelease, version, langs, Deno.env.get("GITHUB_PAT"), {
    gte, lt
  })

  ctx.response.body = result;
});
