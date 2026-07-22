import { createMiddleware } from "hono/factory";
import { getConfig } from "./src/config.ts";
import { createDbMiddleware } from "./src/middleware/db.ts";
import { geoipMiddleware } from "./src/middleware/geoip.ts";
import { getDb } from "./src/platform/db_deno.ts";
import { setupDenoTranslation } from "./src/platform/translation_deno.ts";
import { upgradeGroupDeno } from "./src/realtime/group_deno.ts";
import { matchGroupUpgrade } from "./src/realtime/match.ts";
import type { AppEnv } from "./src/types.ts";
import {
  type ServerControlScheduledWork,
  runServerControlScheduledSweep,
} from "./src/lib/serverControlScheduling.ts";
import { createProductionApp } from "./src/lib/productionComposition.ts";

// Deno entry point. Injects the Deno-specific platform behaviour (geoip
// country lookup, Deno.Kv translation queue, Deno-native MongoDB driver)
// into the shared Hono app, and intercepts realtime group upgrades before
// the app so CORS never touches the immutable 101 WebSocket response.
const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const config = getConfig(c);
  c.set("enqueueTranslation", setupDenoTranslation(config).enqueue);
  await next();
});

const app = createProductionApp(Deno.env.toObject(), (a) => {
  a.use("*", geoipMiddleware);
  a.use("*", createDbMiddleware(getDb));
  a.use("*", platformMiddleware);
});

Deno.serve({ port: 8080 }, (request) => {
  const group = matchGroupUpgrade(request);
  if (group !== undefined) {
    return upgradeGroupDeno(request, group);
  }
  return app.fetch(request);
});

export default app;

/** Deno cron hosts call this with the same injected ServerControl adapter as Workers. */
export function runDenoServerControlScheduledSweep(
  work: ServerControlScheduledWork | undefined,
  at = new Date().toISOString(),
) {
  return runServerControlScheduledSweep(work, at);
}
