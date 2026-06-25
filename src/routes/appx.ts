import { Hono } from "hono";
import { isChineseRequest } from "../geo.ts";
import type { AppEnv } from "../types.ts";

// Redirect Windows .appx downloads to the appropriate edge:
//   - mainland-CN clients -> cdn.xmcl.app (sponsored CDN)
//   - everyone else       -> github.com releases (origin)
export default new Hono<AppEnv>().get("/appx", (c) => {
  const version = c.req.query("version");
  if (!version) {
    return c.text("Missing version query parameter", 400);
  }

  const target = isChineseRequest(c)
    ? `https://cdn.xmcl.app/v${version}/xmcl-${version}-win32-x64.appx`
    : `https://github.com/Voxelum/x-minecraft-launcher/releases/download/v${version}/xmcl-${version}-win32-x64.appx`;

  return c.redirect(target);
});

