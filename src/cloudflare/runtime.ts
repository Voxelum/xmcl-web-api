// deno-lint-ignore-file no-explicit-any
import { createMiddleware } from "hono/factory";
import type { Account } from "../account.ts";
import {
  adminSessionAuthenticator,
  billingOnlyAdminAccount,
  publicAdminAccount,
} from "../adminSession.ts";
import { getBillingRuntime } from "../billingRuntime.ts";
import type { AppConfig } from "../config.ts";
import type { DbFactory } from "../db.ts";
import { createProductionApp } from "../productionComposition.ts";
import { createS3SigV4Presigner } from "../s3SigV4.ts";
import { createDbMiddleware } from "../middleware/db.ts";
import type { AppEnv } from "../types.ts";

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

const productionAdminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const config = c.env as AppConfig;
  const authenticator = adminSessionAuthenticator(
    config.XMCL_ADMIN_SESSION_SECRET,
  );
  if (authenticator) c.set("adminOperationAuthenticator", authenticator);
  await getBillingRuntime(c);
  c.set("adminOperationAccountReader", {
    read: async (accountId) => {
      const db = await c.get("getDb")();
      const [account] = await db.collection("xmcl_accounts").find({
        _id: accountId,
      }).toArray();
      if (account) return publicAdminAccount(account as Account);
      const billingAccount = billingOnlyAdminAccount(
        accountId,
        await c.var.billingService!.adminOverview(),
      );
      if (billingAccount) return billingAccount;
      throw new Error("account_not_found");
    },
  });
  c.set("adminOperationAccountSearch", {
    search: async (query) => {
      const value = query.trim();
      if (!value) return { items: [] };
      const db = await c.get("getDb")();
      const accounts = await db.collection("xmcl_accounts").find({
        $or: [
          { _id: value },
          { "identities.email": value.toLowerCase() },
          { "identities.displayName": value },
        ],
      }).toArray();
      const items: Array<
        | ReturnType<typeof publicAdminAccount>
        | NonNullable<ReturnType<typeof billingOnlyAdminAccount>>
      > = accounts.slice(0, 20).map((account) =>
        publicAdminAccount(account as Account)
      );
      if (items.length === 0) {
        const billingAccount = billingOnlyAdminAccount(
          value,
          await c.var.billingService!.adminOverview(),
        );
        if (billingAccount) items.push(billingAccount);
      }
      return { items };
    },
  });
  c.set("adminOperationAuditEvents", async () => {
    const db = await c.get("getDb")();
    const records = await db.collection("xmcl_audit").find({}).toArray();
    return {
      items: records
        .sort((left, right) =>
          String(right.occurredAt).localeCompare(String(left.occurredAt))
        )
        .slice(0, 100)
        .map((record) => ({
          eventId: String(record.auditId ?? record._id),
          schemaVersion: 1 as const,
          actor: { type: "account", id: String(record.accountId) },
          action: String(record.action),
          resourceType: "account",
          resourceId: String(record.accountId),
          correlationId: String(
            record.requestId ?? record.auditId ?? record._id,
          ),
          occurredAt: String(record.occurredAt),
        })),
    };
  });
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
      if (routeSurface === "api") {
        app.use("/v1/admin/*", productionAdminMiddleware);
      }
    },
    env,
    { SHARED_NODE_WORKSPACE_SIGNER: signer },
    { routeSurface },
  );
}
