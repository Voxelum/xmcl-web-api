import { Application, Router } from "https://deno.land/x/oak@v11.1.0/mod.ts";
import "https://deno.land/x/dotenv@v3.1.0/load.ts";

import latest from "./api/latest.ts";
import afdianBadge from "./api/afdian-badge.ts";
import kookBadge from "./api/kook-badge.ts";
import rtc from "./api/rtc.ts";
import group from "./api/group.ts";
import proxy from "./api/proxy.ts";
import mcbbs from "./api/mcbbs.ts";
import { mongoDbMiddleware } from "./middlewares/mongoDb.ts";

const app = new Application();
const router = new Router();

router.use(mongoDbMiddleware);
latest(router);
afdianBadge(router);
kookBadge(router);
rtc(router)
group(router);
proxy(router);
mcbbs(router);

router.get("/", ({ response }) => {
  response.body = "API is online";
});

app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8080 });
