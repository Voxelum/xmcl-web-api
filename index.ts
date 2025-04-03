import { oakCors } from "https://deno.land/x/cors/mod.ts";
import "https://deno.land/x/dotenv@v3.1.0/load.ts";
import { Application, Router } from "oak";

import afdianBadge from "./api/afdian-badge.ts";
import flights from "./api/flights.ts";
import group from "./api/group.ts";
import releases from "./api/releases.ts";
import kookBadge from "./api/kook-badge.ts";
import latest from "./api/latest.ts";
import elyby from "./api/ely.by.ts"
import translation from "./api/translation.ts";
import rtc from "./api/rtc.ts";
import modrinthAuth from "./api/modrinth.ts";
import { mongoDbMiddleware } from "./middlewares/mongoDb.ts";

const app = new Application();
const router = new Router();

router.use(mongoDbMiddleware)
  .use(latest.routes())
  .use(afdianBadge.routes())
  .use(kookBadge.routes())
  .use(rtc.routes())
  .use(group.routes())
  .use(elyby.routes())
  .use(translation.routes())
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
