import { createProductionApp } from "../../src/productionComposition.ts";
import {
  runServerControlScheduledSweep,
  type ServerControlScheduledWork,
} from "../../src/serverControlScheduling.ts";
import { createDbMiddleware } from "../../src/middleware/db.ts";
import { geoipMiddleware } from "../../src/middleware/geoip.ts";
import { getDb } from "../../src/db_npm.ts";
import { isRetiredServicePath } from "../../src/realtime.ts";

// Local Deno entry point. It uses the same npm MongoDB adapter as production so
// local behavior does not require a separate runtime-specific implementation.
const app = createProductionApp((a) => {
  a.use("*", geoipMiddleware);
  a.use("*", createDbMiddleware(getDb));
}, Deno.env.toObject());

Deno.serve({ port: 8080 }, (request) => {
  if (isRetiredServicePath(request)) {
    return new Response("This API path has been retired", { status: 410 });
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
