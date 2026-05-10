import { Router } from "oak";
import { isChineseIP } from "../shared/geo.ts";

// Redirect Windows .appx downloads to the appropriate edge:
//   - mainland-CN clients -> cdn.xmcl.app (EdgeOne, sponsored CDN)
//   - everyone else       -> github.com releases (origin)
//
// Mirrors the Azure Functions /appx behaviour in azure/index.ts.
//
// Used by:
//   - the AppInstaller manifest served by /appinstaller (MainPackage Uri)
//   - winget (deploy-release.yml passes ?version=<v> as the installer URL)
export default new Router().get("/appx", (ctx) => {
  const version = ctx.request.url.searchParams.get("version");

  if (!version) {
    ctx.response.status = 400;
    ctx.response.headers.set("Content-Type", "text/plain");
    ctx.response.body = "Missing version query parameter";
    return;
  }

  const target = isChineseIP(ctx.request.headers)
    ? `https://cdn.xmcl.app/v${version}/xmcl-${version}-win32-x64.appx`
    : `https://github.com/Voxelum/x-minecraft-launcher/releases/download/v${version}/xmcl-${version}-win32-x64.appx`;

  ctx.response.redirect(target);
});

