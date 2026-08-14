import { createProductionApp } from "../../src/productionComposition.ts";
import { createS3SigV4Presigner } from "../../src/s3SigV4.ts";
import { createDbMiddleware } from "../../src/middleware/db.ts";
import { geoipMiddleware } from "../../src/middleware/geoip.ts";
import { getDb } from "../../src/db_npm.ts";
import { cors } from "hono/cors";

/**
 * Azure is a cold API mirror. It intentionally mounts the same static `api`
 * surface as the primary Cloudflare API Worker, without AI, signaling, cron,
 * or platform-specific control planes.
 */
export function createAzureWorkspaceSigner(
  environment: Record<string, string | undefined>,
) {
  return createS3SigV4Presigner({
    endpoint: environment.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: environment.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: environment.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: environment.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: environment.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
}

export function createAzureHttpApp(
  environment: Record<string, string | undefined>,
) {
  const signer = createAzureWorkspaceSigner(environment);
  return createProductionApp(
    (hono) => {
      hono.use("*", geoipMiddleware);
      hono.use("*", createDbMiddleware(getDb));
      hono.use(
        "/v1/shared-hosting/services*",
        cors({
          origin: (origin) => {
            const allowed = String(
              environment.XMCL_SHARED_HOSTING_CORS_ORIGINS ?? "",
            ).split(",").map((value) => value.trim());
            return allowed.includes(origin) ? origin : null;
          },
          allowMethods: ["GET", "POST", "OPTIONS"],
          allowHeaders: [
            "Authorization",
            "Content-Type",
            "DPoP",
            "Idempotency-Key",
            "X-Request-Id",
          ],
          maxAge: 86400,
        }),
      );
    },
    environment,
    { SHARED_NODE_WORKSPACE_SIGNER: signer },
    { routeSurface: "api", sharedHostingServiceRoutes: true },
  );
}
