import { createProductionApp } from "../src/lib/productionComposition.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { geoipMiddleware } from "../src/middleware/geoip.ts";
import { getDb } from "../src/platform/db_npm.ts";
import { createSharedModdedCompilerRoutes } from "../src/routes/sharedModdedRuntime.ts";
import { createAzureCompilerControlPlane } from "./compilerControlPlane.ts";

/**
 * Azure keeps account and internal node composition from the shared production
 * app, then conditionally adds only private compiler callbacks.
 */
export function createAzureHttpApp(
  environment: Record<string, string | undefined>,
) {
  const signer = createS3SigV4Presigner({
    endpoint: environment.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: environment.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: environment.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: environment.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: environment.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
  const compilerControlPlane = createAzureCompilerControlPlane(
    environment,
    signer,
  );
  const app = createProductionApp(
    (hono) => {
      hono.use("*", geoipMiddleware);
      hono.use("*", createDbMiddleware(getDb));
      compilerControlPlane?.register(hono);
    },
    environment,
    { SHARED_NODE_WORKSPACE_SIGNER: signer },
  );
  if (compilerControlPlane) {
    app.route("/", createSharedModdedCompilerRoutes());
  }
  return app;
}
