import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import appinstaller from "./routes/appinstaller.ts";
import appx from "./routes/appx.ts";
import backupStoragePolicy from "./routes/backupStoragePolicy.ts";
import elyby from "./routes/elyby.ts";
import flights from "./routes/flights.ts";
import multiplayer from "./routes/multiplayer.ts";
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
import waffo from "./routes/waffo.ts";
import usageSettlement from "./routes/usageSettlement.ts";
import worker from "./routes/worker.ts";
import ai from "./routes/ai.ts";
import modpackDeployments from "./routes/modpackDeployments.ts";
import sharedHosting from "./routes/sharedHosting.ts";
import sharedHostingServices from "./routes/sharedHostingServices.ts";
import sharedNodeTransport from "./routes/sharedNodeTransport.ts";
import sharedModdedRuntime from "./routes/sharedModdedRuntime.ts";
import sharedWorldSeeds from "./routes/sharedWorldSeeds.ts";
import chatCompletions from "./routes/chatCompletions.ts";
import xmclPlus from "./routes/xmclPlus.ts";
import type { AppEnv } from "./types.ts";
import { AccountError } from "./account.ts";
import { handleAccountError, requestId } from "./accountHttp.ts";

/**
 * Builds the shared Hono application. This is the single source of truth for all
 * HTTP routes and is reused by every platform entry point (Deno, Cloudflare
 * Workers, Azure Functions). Platform-specific behaviour (DB connector,
 * realtime upgrade, geo) is injected via context variables set in per-platform
 * middleware.
 */
export interface CreateAppOptions {
  /**
   * Limits the mounted route family for an isolated public domain. The
   * default keeps the historical all-routes composition used by tests and
   * non-Cloudflare runtimes.
   */
  routeSurface?: "all" | "api" | "ai" | "signaling";
  /**
   * Test composition can mount routes with injected fakes. Production only
   * enables these routes once its complete durable composition is available.
   */
  commercialRoutes?: boolean;
  sharedHostingServiceRoutes?: boolean;
  /** Public payment routes can be enabled without shared-hosting composition. */
  billingRoutes?: boolean;
  /** Mounts XMCL Together Home subscription and allowance routes. */
  xmclPlusRoutes?: boolean;
  /** Mounts authenticated internal node transport after complete composition. */
  sharedNodeTransportRoutes?: boolean;
  /** Mounts the configured Waffo checkout and signed webhook routes. */
  paymentRoutes?: boolean;
  /**
   * Most deployments retain the historical permissive CORS middleware. Isolated
   * control planes can opt out and attach CORS only to their reviewed routes.
   */
  corsOptions?: Parameters<typeof cors>[0] | false;
  /** Isolated control planes mount account/session routes only after their guard. */
  accountSessionRoutes?: boolean;
  /** Local demo disables the real provider-backed chat proxy. */
  chatCompletionsRoutes?: boolean;
}

export function createApp(
  register?: (app: Hono<AppEnv>) => void,
  options: CreateAppOptions = {},
) {
  const app = new Hono<AppEnv>();
  const surface = options.routeSurface ?? "all";
  const allRoutes = surface === "all";
  const apiRoutes = allRoutes || surface === "api";
  const aiRoutes = allRoutes || surface === "ai";
  const signalingRoutes = allRoutes || surface === "signaling";

  if (options.corsOptions !== false) {
    app.use("*", cors(options.corsOptions));
  }

  // Platform entry points inject their middleware here (geo, DB, realtime
  // upgrade) before the shared routes run.
  register?.(app);

  if (apiRoutes) {
    app.route("/", latest);
    app.route("/", releases);
    app.route("/", notifications);
    app.route("/", flights);
    app.route("/", translation);
    app.route("/", zulu);
    app.route("/", elyby);
    app.route("/", modrinth);
    app.route("/", kookBadge);
    app.route("/", appx);
    app.route("/", appinstaller);
    app.route("/", prebuilds);
    app.route("/", backupStoragePolicy);
  }
  if (signalingRoutes) {
    app.route("/", multiplayer);
    app.route("/", rtc);
  }
  if (options.accountSessionRoutes !== false && apiRoutes) {
    app.route("/", session);
    app.route("/", account);
  }
  if (options.chatCompletionsRoutes !== false && aiRoutes) {
    app.route("/", chatCompletions);
  }
  if (apiRoutes) {
    const enableCommercialRoutes = options.commercialRoutes !== false;
    if (enableCommercialRoutes || options.billingRoutes === true) {
      app.route("/", billing);
    }
    if (enableCommercialRoutes || options.xmclPlusRoutes === true) {
      app.route("/", xmclPlus);
    }
    if (enableCommercialRoutes || options.paymentRoutes === true) {
      app.route("/", waffo);
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
      app.route("/", xmclPlus);
      app.route("/", sharedHostingServices);
      app.route("/", sharedModdedRuntime);
      app.route("/", sharedWorldSeeds);
    }
    if (
      !enableCommercialRoutes &&
      options.sharedHostingServiceRoutes === true
    ) {
      app.route("/", sharedHostingServices);
    }
    if (options.sharedNodeTransportRoutes === true) {
      app.route("/", sharedNodeTransport);
    }
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
    if (err instanceof AccountError) {
      return handleAccountError(err, c);
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    const id = requestId(c);
    console.error({
      event: "app.exception",
      requestId: id,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      errorName: err.name,
    });
    return c.json(
      {
        error: "internal_error",
        message: "Internal Server Error",
        requestId: id,
      },
      500,
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
