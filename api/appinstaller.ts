import { Router } from "oak";
import { gte, lt } from "https://deno.land/std@0.178.0/semver/mod.ts";
import { getLatest } from "../shared/latest.ts";

// SignPath Foundation publisher used by the launcher's appx code-signing
// pipeline. Must match `PUBLISHER` in the launcher's
// .github/workflows/build.yml. If code signing changes, update this.
const PUBLISHER =
  "CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US";

const MANIFEST_URI = "https://api.xmcl.app/appinstaller";

// Generates the AppInstaller manifest for the latest stable launcher release.
//
// Windows polls this URL forever after a user installs via .appinstaller.
// Returning a manifest with a higher top-level Version triggers an update;
// MainPackage.Uri tells Windows where to fetch the new .appx from.
//
// Replaces the static blob at xmcl.blob.core.windows.net/releases/xmcl.appinstaller
// that used to be uploaded by the launcher's deploy-release.yml.
export default new Router().get("/appinstaller", async (ctx) => {
  const pat = Deno.env.get("GITHUB_PAT");

  const latest = await getLatest(false, null, null, pat, { gte, lt });
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
        Uri="https://cdn.xmcl.app/v${version}/xmcl-${version}-win32-x64.appx" />
    <UpdateSettings>
    </UpdateSettings>
</AppInstaller>`;

  ctx.response.headers.set("Content-Type", "application/appinstaller");
  ctx.response.headers.set("Cache-Control", "public, max-age=300");
  ctx.response.body = xml;
});
