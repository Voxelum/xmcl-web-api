import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import appinstaller from "./routes/appinstaller.ts";
import appx from "./routes/appx.ts";
import elyby from "./routes/elyby.ts";
import flights from "./routes/flights.ts";
import group from "./routes/group.ts";
import kookBadge from "./routes/kookBadge.ts";
import latest from "./routes/latest.ts";
import modrinth from "./routes/modrinth.ts";
import notifications from "./routes/notifications.ts";
import prebuilds from "./routes/prebuilds.ts";
import releases from "./routes/releases.ts";
import rtc from "./routes/rtc.ts";
import translation from "./routes/translation.ts";
import zulu from "./routes/zulu.ts";
import type { AppEnv } from "./types.ts";

/**
 * Builds the shared Hono application. This is the single source of truth for all
 * HTTP routes and is reused by every platform entry point (Deno, Cloudflare
 * Workers, Azure Functions). Platform-specific behaviour (DB connector, realtime
 * upgrade, translation queue, geo) is injected via context variables set in
 * per-platform middleware.
 */
export function createApp(register?: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();

  app.use("*", cors());

  // Platform entry points inject their middleware here (geo, DB, realtime
  // upgrade, translation queue) before the shared routes run.
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

  // Temporary debug endpoint for diagnosing Cosmos DB auth on Deno Deploy
  app.get("/debug/db", async (c) => {
    const { getConfig } = await import("./config.ts");
    const config = getConfig(c);
    const connStr = config.MONGO_CONNECION_STRING || "";
    
    // Try raw MongoClient connection to isolate the issue
    let connectResult = "not attempted";
    let driverVersion = "unknown";
    let debugUrl = "";
    try {
      const mongodb = await import("npm:mongodb");
      const { MongoClient, version } = mongodb;
      driverVersion = version || "n/a";

      // Parse connection string into components
      const m = connStr.match(/^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@([^/?]+)(\/[^?]*)?\??(.*)$/);
      if (!m) throw new Error("Cannot parse connection string");
      const [, scheme, user, pass, host, , queryStr] = m;
      // Remove appName (contains @ which confuses parsers) and authMechanism from query
      const params = (queryStr || "").split("&").filter(
        (p) => !p.startsWith("appName=") && !p.startsWith("authMechanism=")
      );
      const cleanQuery = params.length > 0 ? "?" + params.join("&") : "";
      const url = `${scheme}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${cleanQuery}`;
      debugUrl = url.replace(/:([^@]+)@/, ":***@"); // redact password for debug
      const client = new MongoClient(url, {
        authMechanism: "SCRAM-SHA-1",
        appName: "xmcl-mongo",
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await client.connect();
      await client.db(config.MONGODB_NAME || "xmcl-api").command({ ping: 1 });
      connectResult = "success";
      await client.close();
    } catch (e: unknown) {
      connectResult = `error: ${(e as Error).message}`;
    }

    return c.json({
      hasConnStr: !!connStr,
      connStrLen: connStr.length,
      hasAuthMechanism: connStr.includes("authMechanism="),
      startsWithMongo: connStr.startsWith("mongodb://"),
      dbName: config.MONGODB_NAME || "xmcl-api",
      driverVersion,
      debugUrl,
      connectResult,
    });
  });

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
    return c.json({ error: "Internal Server Error", message: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
