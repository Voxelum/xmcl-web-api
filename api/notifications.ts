import { Router } from "oak";
import { Range } from "https://deno.land/std@0.178.0/semver/mod.ts";

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

  const labels = `os:${os},arch:${arch},env:${env},l:${locale}`;
  const pat = Deno.env.get("GITHUB_PAT");

  const response = await fetch(
    `https://api.github.com/repos/voxelum/xmcl-static-resource/issues?labels=${labels}&per_page=5&creator=ci010`,
    {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${pat}`,
      },
    },
  );
  function parseLabels(label: { name: string }[]) {
    const tags = label.filter(l => l.name.startsWith('t:')).map(l => l.name.substring(2));
    const versionCriteria = label.filter(l => l.name.startsWith('v:')).map(l => l.name.substring(2))[0];
    if (versionCriteria && version) {
      const range = new Range(versionCriteria);
      if (range.test(version)) {
        return false;
      }
    }
    return tags
  }
  const issues: any[] = await response.json();
  const notifications: Notification[] = issues.map((issue) => {
    const tags = parseLabels(issue.labels);
    if (tags) {
      return {
        created_at: new Date(issue.created_at),
        updated_at: new Date(issue.updated_at),
        tags,
        id: issue.id,
        title: issue.title,
        body: issue.body,
      }
    }
    return undefined
  }).filter((issue) => issue !== undefined) as Notification[];

  ctx.response.status = response.status;
  ctx.response.headers.set("Content-Type", "application/json");
  ctx.response.body = notifications;
})