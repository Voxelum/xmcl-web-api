import { Router } from "oak";

export default new Router().get("/flights", (ctx) => {
  ctx.response.body = {
  };
});
