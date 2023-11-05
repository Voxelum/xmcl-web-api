import { defineApi } from "../type.ts";

export default defineApi((router) => {
  router.get("/flights", (ctx) => {
    ctx.response.body = {
    };
  });
});
