import { Router } from "oak";

export default new Router().get("/flights", (ctx) => {
  const params = ctx.request.url.searchParams;
  const version = params.get("version");
  const locale = params.get("locale");
  const build = params.get("build");

  if (!version || !locale) {
    ctx.response.body = {}
    return;
  }

  if (build && Number(build) > 1002) {
    ctx.response.body = {
      i18nSearch: ['zh-CN']
    }
  } else {
    ctx.response.body = {
    };
  }
});
