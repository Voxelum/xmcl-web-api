import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import appinstaller from "./routes/appinstaller.ts";
import appx from "./routes/appx.ts";
import backupStoragePolicy from "./routes/backupStoragePolicy.ts";
import elyby from "./routes/elyby.ts";
import flights from "./routes/flights.ts";
import group from "./routes/group.ts";
import kookBadge from "./routes/kookBadge.ts";
import latest from "./routes/latest.ts";
import modrinth from "./routes/modrinth.ts";
import worldBackups from "./routes/worldBackups.ts";
import notifications from "./routes/notifications.ts";
import prebuilds from "./routes/prebuilds.ts";
import releases from "./routes/releases.ts";
import rtc from "./routes/rtc.ts";
import translation from "./routes/translation.ts";
import operations from "./routes/operations.ts";
import zulu from "./routes/zulu.ts";
import account from "./routes/account.ts";
import session from "./routes/session.ts";
import servers from "./routes/servers.ts";
import billing from "./routes/billing.ts";
import paypal from "./routes/paypal.ts";
import usageSettlement from "./routes/usageSettlement.ts";
import worker from "./routes/worker.ts";
import ai from "./routes/ai.ts";
import modpackDeployments from "./routes/modpackDeployments.ts";
import sharedHosting from "./routes/sharedHosting.ts";
import sharedHostingServices from "./routes/sharedHostingServices.ts";
import sharedNodeTransport from "./routes/sharedNodeTransport.ts";
import sharedModdedRuntime from "./routes/sharedModdedRuntime.ts";
import type { AppEnv } from "./types.ts";

/**
 * Builds the shared Hono application. This is the single source of truth for all
 * HTTP routes and is reused by every platform entry point (Deno, Cloudflare
 * Workers, Azure Functions). Platform-specific behaviour (DB connector,
 * realtime upgrade, geo) is injected via context variables set in per-platform
 * middleware.
 */
export interface CreateAppOptions {
  /**
   * Test composition can mount routes with injected fakes. Production only
   * enables these routes once its complete durable composition is available.
   */
  commercialRoutes?: boolean;
  /** Public payment routes can be enabled without shared-hosting composition. */
  billingRoutes?: boolean;
  /** Mounts authenticated internal node transport after complete composition. */
  sharedNodeTransportRoutes?: boolean;
  /** PayPal routes stay separately gated until provider reconciliation is deployed. */
  paymentRoutes?: boolean;
}

export function createApp(
  register?: (app: Hono<AppEnv>) => void,
  options: CreateAppOptions = {},
) {
  const app = new Hono<AppEnv>();

  app.use("*", cors());

  // Platform entry points inject their middleware here (geo, DB, realtime
  // upgrade) before the shared routes run.
  register?.(app);

  app.route("/", latest);
  app.route("/", releases);
  app.route("/", notifications);
  app.route("/", flights);
  app.route("/", translation);
  app.route("/", group);
  app.route("/", rtc);
  app.route("/", zulu);
  app.route("/", elyby);
  app.route("/", modrinth);
  app.route("/", kookBadge);
  app.route("/", appx);
  app.route("/", appinstaller);
  app.route("/", prebuilds);
  app.route("/", backupStoragePolicy);
  app.route("/", session);
  app.route("/", account);
  const enableCommercialRoutes = options.commercialRoutes !== false;
  if (enableCommercialRoutes || options.billingRoutes === true) {
    app.route("/", billing);
  }
  if (enableCommercialRoutes || options.paymentRoutes === true) {
    app.route("/", paypal);
  }
  if (enableCommercialRoutes) {
    app.route("/", worldBackups);
    app.route("/", servers);
    app.route("/", operations);
    app.route("/", usageSettlement);
    app.route("/", worker);
    app.route("/", ai);
    app.route("/", modpackDeployments);
    app.route("/", sharedHosting);
    app.route("/", sharedHostingServices);
    app.route("/", sharedModdedRuntime);
  }
  if (options.sharedNodeTransportRoutes === true) {
    app.route("/", sharedNodeTransport);
  }

  // Index: list the registered routes (mirrors the original `/`).
  app.get("/", (c) => {
    const seen = new Set<string>();
    const paths = app.routes
      .map((r) => r.path)
      .filter((p) => {
        if (p === "/" || seen.has(p)) return false;
        seen.add(p);
        return true;
      });
    return c.json(paths);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    console.error(err);
    return c.json(
      { error: "Internal Server Error", message: err.message },
      500,
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
