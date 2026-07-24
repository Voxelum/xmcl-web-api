import type { Hono } from "hono";
import { createApp, type CreateAppOptions } from "../app.ts";
import { type AppConfig, getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import {
  getSharedHostingRuntime,
  hasSharedNodeSettings,
} from "./sharedHostingRuntime.ts";
import type { SharedNodeWorkspaceSigner } from "./sharedNodeTransport.ts";

interface SharedNodeProductionBindings {
  SHARED_NODE_WORKSPACE_SIGNER?: unknown;
}

export function hasSharedNodeRuntimeSettings(
  config: AppConfig,
  bindings?: SharedNodeProductionBindings,
) {
  const signer = bindings?.SHARED_NODE_WORKSPACE_SIGNER;
  return hasSharedNodeSettings(config) &&
    typeof signer === "object" &&
    signer !== null &&
    typeof (signer as SharedNodeWorkspaceSigner).presign === "function";
}

export function productionAppOptions(
  config?: AppConfig,
  bindings?: SharedNodeProductionBindings,
): CreateAppOptions {
  return {
    commercialRoutes: false,
    billingRoutes: true,
    paymentRoutes: false,
    sharedNodeTransportRoutes: config
      ? hasSharedNodeRuntimeSettings(config, bindings)
      : false,
  };
}

/**
 * Builds production entry points without test doubles. Account/session routes
 * remain available through their Mongo-backed runtime. Public payment routes use
 * the durable Mongo ledger; PayPal, shared-hosting, and other commercial routes
 * stay unmounted until provider reconciliation and remaining adapters compose.
 */
export function createProductionApp(
  register?: (app: Hono<AppEnv>) => void,
  config?: AppConfig,
  bindings?: SharedNodeProductionBindings,
) {
  return createApp((app) => {
    register?.(app);
    app.use("*", async (c, next) => {
      if (hasSharedNodeRuntimeSettings(getConfig(c), bindings)) {
        if (!c.get("getDb")) {
          return c.json({ error: "shared_hosting_unavailable" }, 503);
        }
        const runtime = await getSharedHostingRuntime(
          c,
          (bindings?.SHARED_NODE_WORKSPACE_SIGNER as SharedNodeWorkspaceSigner),
        );
        c.set("sharedHostingService", runtime.sharedHosting);
        c.set("sharedHostingScheduler", runtime.scheduler);
        c.set("sharedNodeTransport", runtime.transport);
        c.set("sharedNodeProvisioner", runtime.provisioner);
        c.set("sharedHostingBillingScheduledWork", runtime.billingScheduledWork);
      }
      await next();
    });
  }, productionAppOptions(config, bindings));
}
