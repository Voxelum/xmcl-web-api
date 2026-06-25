import { Hono } from "hono";
import { gte, lt } from "semver";
import { getLatest } from "../shared/latest.ts";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

// SignPath Foundation publisher used by the launcher's appx code-signing
// pipeline. Must match `PUBLISHER` in the launcher's build workflow.
const PUBLISHER =
  "CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US";

const MANIFEST_URI = "https://api.xmcl.app/appinstaller";

// Generates the AppInstaller manifest for the latest stable launcher release.
export default new Hono<AppEnv>().get("/appinstaller", async (c) => {
  const latest = await getLatest(false, null, null, getConfig(c).GITHUB_PAT, {
    gte,
    lt,
  });
  const tag = latest?.tag_name ?? "v0.0.0";
  const version = tag.startsWith("v") ? tag.substring(1) : tag;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller
    xmlns="http://schemas.microsoft.com/appx/appinstaller/2018"
    Version="${version}.0"
    Uri="${MANIFEST_URI}" >
    <MainPackage
        Name="XMCL"
        Publisher="${PUBLISHER}"
        Version="${version}.0"
        ProcessorArchitecture="x64"
        Uri="https://api.xmcl.app/appx?version=${version}" />
    <UpdateSettings>
    </UpdateSettings>
</AppInstaller>`;

  return c.body(xml, 200, {
    "Content-Type": "application/appinstaller",
    "Cache-Control": "public, max-age=300",
  });
});

