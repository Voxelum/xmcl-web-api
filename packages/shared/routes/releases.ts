import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

// Redirect to the GitHub release asset.
export default new Hono<AppEnv>().get("/releases/:filename", (c) => {
  const fileName = c.req.param("filename");
  const version = fileName.split("-")[1];
  return c.redirect(
    `https://github.com/Voxelum/x-minecraft-launcher/releases/download/v${version}/${fileName}`,
  );
});
