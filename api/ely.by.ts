import { Router } from "oak";
import { hasherMiddlware } from "../middlewares/hasher.ts";

export default new Router().use(hasherMiddlware).get("/elyby/authlib", async (ctx) => {
  const response = await fetch('https://raw.githubusercontent.com/Voxelum/xmcl-static-resource/refs/heads/main/elyby.json', {
    headers: ctx.request.headers,
  })
  ctx.response.status = response.status
  ctx.response.headers = response.headers
  ctx.response.body = response.body
});
