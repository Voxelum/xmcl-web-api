import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

interface KookResponse {
  open_id: string | null;
  name: string;
  icon: string;
  online_count: string;
}

// The original Deno service read ./favicon-kook.svg from disk (Deno.readFile),
// which isn't portable to workerd/Azure. Fetch it from the repo raw URL once
// per isolate and cache it instead.
const SVG_URL =
  "https://raw.githubusercontent.com/Voxelum/xmcl-web-api/main/favicon-kook.svg";
let cachedSvg: string | undefined;

async function getSvg(): Promise<string> {
  if (cachedSvg === undefined) {
    const response = await fetch(SVG_URL);
    cachedSvg = response.ok ? await response.text() : "";
  }
  return cachedSvg;
}

export default new Hono<AppEnv>().get("/kook-badge", async (c) => {
  const response = await fetch(
    "https://kookapp.cn/api/guilds/2998646379574089/widget.json",
  );
  const content = (await response.json()) as KookResponse;
  const svg = await getSvg();

  return c.json({
    schemaVersion: 1,
    label: "KOOK",
    logoSvg: svg,
    message: `${content.online_count} 人在线`,
    labelColor: "87eb00",
  });
});
