import { defineApi } from "../type.ts";

export default defineApi((router) => {
  router.get("/curseforge/(.*)", async (ctx) => {
    const path = ctx.request.url.pathname.substring('/curseforge'.length)
    if (!path) {
      ctx.response.status = 400;
    } else {
      const url = new URL(path + ctx.request.url.search, "https://api.curseforge.com");
      const response = await fetch(url, {
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.body({ type: 'stream' }).value,
      });
      ctx.response.status = response.status;
      ctx.response.body = response.body;
    }
  }).get("/modrinth/(.*)", async (ctx) => {
    const path = ctx.request.url.pathname.substring('/modrinth'.length)
    if (!path) {
      ctx.response.status = 400;
    } else {
      const url = new URL(path + ctx.request.url.search, "https://api.modrinth.com");
      const response = await fetch(url, {
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.body({ type: 'stream' }).value,
      });
      ctx.response.status = response.status;
      ctx.response.body = response.body;
    }
  });
});
