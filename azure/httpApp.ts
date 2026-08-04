import { createProductionApp } from "../src/lib/productionComposition.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { geoipMiddleware } from "../src/middleware/geoip.ts";
import { getDb } from "../src/platform/db_npm.ts";
import { createSharedModdedCompilerRoutes } from "../src/routes/sharedModdedRuntime.ts";
import { createAzureCompilerControlPlane } from "./compilerControlPlane.ts";
import {
  createAzurePayPalWebhookControlPlane,
} from "./paypalWebhookControlPlane.ts";
import { createAzureStagingM3ControlPlane } from "./stagingM3ControlPlane.ts";
import {
  createAzureStagingAccountControlPlane,
} from "./stagingAccountControlPlane.ts";

/**
 * Azure has no public account/session surface by default. It conditionally
 * composes narrowly guarded staging M1, M3, webhook, and compiler planes.
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
  const paypalWebhookControlPlane = createAzurePayPalWebhookControlPlane(
    environment,
  );
  const stagingM3ControlPlane = createAzureStagingM3ControlPlane(environment);
  const stagingAccountControlPlane = createAzureStagingAccountControlPlane(
    environment,
  );
  const app = createProductionApp(
    (hono) => {
      hono.use("*", geoipMiddleware);
      hono.use("*", createDbMiddleware(getDb));
      compilerControlPlane?.register(hono);
      paypalWebhookControlPlane?.register(hono);
      stagingM3ControlPlane?.register(hono);
      stagingAccountControlPlane?.register(hono);
    },
    environment,
    { SHARED_NODE_WORKSPACE_SIGNER: signer },
    {
      billingRoutes: false,
      paymentRoutes: false,
      // Azure only emits CORS on the exact M3 staging routes after the
      // control plane has validated a configured staging origin.
      corsOptions: false,
      // Account/session handlers are mounted only behind the M1 HMAC guard.
      accountSessionRoutes: false,
    },
  );
  if (compilerControlPlane) {
    app.route("/", createSharedModdedCompilerRoutes());
  }
  return app;
}
