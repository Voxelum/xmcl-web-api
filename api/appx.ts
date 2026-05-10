import { Router } from "oak";

// Redirect Windows .appx downloads to the EdgeOne CDN (cdn.xmcl.app),
// which mirrors GitHub Releases. Mirrors the Azure Functions /appx behaviour
// in azure/index.ts.
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

  ctx.response.redirect(
    `https://cdn.xmcl.app/v${version}/xmcl-${version}-win32-x64.appx`,
  );
});
