// deno-lint-ignore-file no-explicit-any
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../../config.ts";
import type { DbFactory } from "../../db.ts";
import { createProductionApp } from "../../lib/productionComposition.ts";
import { createS3SigV4Presigner } from "../../lib/s3SigV4.ts";
import { createDbMiddleware } from "../../middleware/db.ts";
import type { AppEnv } from "../../types.ts";

export type CloudflareRouteSurface = "api" | "ai" | "signaling";

// bson initializes secure randomness at module evaluation time, which Cloudflare
// rejects in Worker global scope. Load the connector only when a route uses it.
export const getCloudflareDb: DbFactory = async (config) => {
  const { createDb } = await import("../db_npm.ts");
  return createDb(config);
};

const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env as any;
  c.set("waitUntil", (promise) => c.executionCtx.waitUntil(promise));
  if (env.ADMIN_OPERATION_AUTHENTICATOR) {
    c.set("adminOperationAuthenticator", env.ADMIN_OPERATION_AUTHENTICATOR);
  }
  if (env.ADMIN_OPERATION_REPOSITORY) {
    c.set("adminOperationRepository", env.ADMIN_OPERATION_REPOSITORY);
  }
  if (env.ADMIN_OPERATION_AUDIT_LOG) {
    c.set("adminOperationAuditLog", env.ADMIN_OPERATION_AUDIT_LOG);
  }
  if (env.BILLING_ADMIN_OPERATION_ADAPTER) {
    c.set("billingAdminOperationAdapter", env.BILLING_ADMIN_OPERATION_ADAPTER);
  }
  if (env.SERVER_CONTROL_ADMIN_OPERATION_ADAPTER) {
    c.set(
      "serverControlAdminOperationAdapter",
      env.SERVER_CONTROL_ADMIN_OPERATION_ADAPTER,
    );
  }
  if (env.ADMIN_OPERATION_AUDIT_EVENTS) {
    c.set("adminOperationAuditEvents", env.ADMIN_OPERATION_AUDIT_EVENTS);
  }
  if (env.ADMIN_OPERATION_METRICS) {
    c.set("adminOperationMetrics", env.ADMIN_OPERATION_METRICS);
  }
  if (env.ADMIN_OPERATION_RECONCILIATION) {
    c.set("adminOperationReconciliation", env.ADMIN_OPERATION_RECONCILIATION);
  }
  if (env.ADMIN_OPERATION_ACCOUNT_READER) {
    c.set("adminOperationAccountReader", env.ADMIN_OPERATION_ACCOUNT_READER);
  }
  await next();
});

export function createCloudflareApp(
  env: AppConfig,
  routeSurface: CloudflareRouteSurface,
) {
  const signer = createS3SigV4Presigner({
    endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
  return createProductionApp(
    (app) => {
      app.use("*", createDbMiddleware(getCloudflareDb));
      app.use("*", platformMiddleware);
    },
    env,
    { SHARED_NODE_WORKSPACE_SIGNER: signer },
    { routeSurface },
  );
}
