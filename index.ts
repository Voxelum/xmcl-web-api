import { createDbMiddleware } from "./src/middleware/db.ts";
import { geoipMiddleware } from "./src/middleware/geoip.ts";
import { getDb } from "./src/platform/db_deno.ts";
import { upgradeGroupDeno } from "./src/realtime/group_deno.ts";
import { matchGroupUpgrade } from "./src/realtime/match.ts";
import {
  runServerControlScheduledSweep,
  type ServerControlScheduledWork,
} from "./src/lib/serverControlScheduling.ts";
import { createProductionApp } from "./src/lib/productionComposition.ts";

// Deno entry point. It injects geoip and the Deno-native MongoDB driver into
// the shared app. Translation cache misses only write the Mongo request ledger;
// the external batch worker performs translation.
const app = createProductionApp((a) => {
  a.use("*", geoipMiddleware);
  a.use("*", createDbMiddleware(getDb));
}, Deno.env.toObject());

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
