import { createProductionApp } from "../../packages/shared/lib/productionComposition.ts";
import {
  runServerControlScheduledSweep,
  type ServerControlScheduledWork,
} from "../../packages/shared/lib/serverControlScheduling.ts";
import { createDbMiddleware } from "../../packages/shared/middleware/db.ts";
import { geoipMiddleware } from "../../packages/shared/middleware/geoip.ts";
import { getDb } from "../../packages/shared/platform/db_npm.ts";
import { isRetiredServicePath } from "../../packages/shared/realtime/match.ts";

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
