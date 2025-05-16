import { Router } from "oak";
import { getFlights } from "../shared/flights.ts";

export default new Router().get("/flights", (ctx) => {
  const params = ctx.request.url.searchParams;
  const version = params.get("version");
  const locale = params.get("locale");
  const build = params.get("build");


  if (!version || !locale) {
    ctx.response.body = {}
    return;
  }

  const body = getFlights(version, locale, build);
  ctx.response.body = body;
});
