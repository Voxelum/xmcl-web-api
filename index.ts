import { oakCors } from "https://deno.land/x/cors/mod.ts";
import "https://deno.land/x/dotenv@v3.1.0/load.ts";
import { Application, Router } from "oak";

import elyby from "./api/ely.by.ts";
import flights from "./api/flights.ts";
import group from "./api/group.ts";
import kookBadge from "./api/kook-badge.ts";
import prebuilds from "./api/prebuilds.ts";
import latest from "./api/latest.ts";
import modrinthAuth from "./api/modrinth.ts";
import notifications from "./api/notifications.ts";
import releases from "./api/releases.ts";
import rtc from "./api/rtc.ts";
import translation from "./api/translation.ts";
import zulu from "./api/zulu.ts";
import { mongoDbMiddleware } from "./middlewares/mongoDb.ts";

const app = new Application();
const router = new Router();

router.use(mongoDbMiddleware)
  .use(latest.routes())
  .use(prebuilds.routes())
  .use(kookBadge.routes())
  .use(rtc.routes())
  .use(group.routes())
  .use(elyby.routes())
  .use(notifications.routes())
  .use(translation.routes())
  .use(zulu.routes())
  .use(releases.routes())
  .use(modrinthAuth.routes())
  .use(flights.routes());

router.get("/", ({ response }) => {
  response.body = JSON.stringify([...router.keys()]);
});

app.use(oakCors()); // Enable CORS for All Routes
app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8080 });
