import type { Hono } from "hono";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import type { BillingService } from "../src/lib/billing.ts";
import {
  HmacStagingM3ProxyIdentity,
  MongoStagingM3ProxyNonceStore,
  readStagingM3ProxyRawBody,
  StagingM3ProxyBodyTooLargeError,
} from "../src/lib/stagingM3ProxyIdentity.ts";
import {
  isStagingM3CorsRequest,
  STAGING_M3_CORS_HEADERS,
  stagingM3AzureTarget,
} from "../src/lib/stagingM3Routes.ts";
import type { PayPalService } from "../src/lib/paypal.ts";
import type { AccountRuntimeResolver } from "../src/middleware/xmclAuth.ts";
import { xmclAuth } from "../src/middleware/xmclAuth.ts";
import { createBillingRoutes } from "../src/routes/billing.ts";
import { createPayPalRoutes } from "../src/routes/paypal.ts";
import type { AppEnv } from "../src/types.ts";

interface StagingM3ControlPlaneSettings {
  keyId: string;
  secret: string;
  corsOrigins: readonly string[];
}

export interface AzureStagingM3ControlPlaneDependencies {
  now?: () => number;
  billing?: BillingService;
  paypal?: PayPalService;
  resolveAccountRuntime?: AccountRuntimeResolver;
}

/**
 * Azure-only M3 Sandbox checkout plane. Every mounted API route first passes a
 * durable Worker HMAC replay check, then the normal bearer-token account
 * middleware and durable Mongo billing runtime. No balance-credit endpoint is
 * composed here.
 */
export class AzureStagingM3ControlPlane {
  constructor(
    private readonly settings: StagingM3ControlPlaneSettings,
    private readonly dependencies: AzureStagingM3ControlPlaneDependencies,
  ) {}

  register(app: Hono<AppEnv>) {
    app.use("/v1/billing/*", async (c, next) => {
      const path = c.req.path;
      if (c.req.method === "OPTIONS") {
        return this.preflight(c.req.header("origin"), path, c.req.header(
          "access-control-request-method",
        ), c.req.header("access-control-request-headers"));
      }

      const target = stagingM3AzureTarget(c.req.method, path);
      if (!target) return c.json({ error: "not_found" }, 404);
      if (!this.setCors(c.req.header("origin"), c.res.headers)) {
        return c.json({ error: "forbidden" }, 403);
      }

      // Azure's adapter preserves the raw `/api/...` target before Hono route
      // matching. Requiring it prevents a signature for one endpoint being
      // replayed into another endpoint after prefix rewriting.
      if (c.req.header("x-xmcl-original-target") !== target) {
        return c.json({ error: "unauthorized" }, 401);
      }

      let raw: Uint8Array;
      try {
        // Verify a clone so the shared checkout route can still parse its
        // original JSON request body after this middleware returns.
        raw = await readStagingM3ProxyRawBody(c.req.raw.clone());
      } catch (error) {
        if (error instanceof StagingM3ProxyBodyTooLargeError) {
          return c.json({ error: "payload_too_large" }, 413);
        }
        return c.json({ error: "unauthorized" }, 401);
      }

      const getDb = c.get("getDb");
      if (!getDb) return c.json({ error: "staging_m3_unavailable" }, 503);
      let db: Db;
      try {
        db = await getDb();
      } catch {
        return c.json({ error: "staging_m3_unavailable" }, 503);
      }

      const identity = new HmacStagingM3ProxyIdentity({
        keyId: this.settings.keyId,
        secret: this.settings.secret,
        nonceStore: new MongoStagingM3ProxyNonceStore(db),
        now: this.dependencies.now,
      });
      try {
        await identity.verifyIncoming({
          method: c.req.method,
          target,
          headers: c.req.raw.headers,
          body: raw,
        });
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
    app.use(
      "/v1/billing/*",
      xmclAuth([], this.dependencies.resolveAccountRuntime),
    );

    app.route("/", createBillingRoutes(
      this.dependencies.billing,
      this.dependencies.resolveAccountRuntime,
      { authenticated: false },
    ));
    app.route("/", createPayPalRoutes(
      this.dependencies.paypal,
      this.dependencies.resolveAccountRuntime,
      { authenticated: false, webhook: false },
    ));
  }

  private preflight(
    origin: string | undefined,
    path: string,
    requestedMethod: string | undefined,
    requestedHeaders: string | undefined,
  ) {
    if (
      !this.validOrigin(origin) ||
      !isStagingM3CorsRequest(requestedMethod, path) ||
      !validCorsRequestHeaders(requestedHeaders)
    ) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const headers = new Headers();
    this.setCors(origin, headers);
    headers.set("access-control-allow-methods", requestedMethod!.toUpperCase());
    headers.set("access-control-allow-headers", STAGING_M3_CORS_HEADERS.join(", "));
    headers.set("access-control-max-age", "600");
    return new Response(null, { status: 204, headers });
  }

  private validOrigin(origin: string | undefined) {
    return origin === undefined || this.settings.corsOrigins.includes(origin);
  }

  private setCors(origin: string | undefined, headers: Headers) {
    if (origin === undefined) return true;
    if (!this.validOrigin(origin)) return false;
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "origin");
    return true;
  }
}

export function createAzureStagingM3ControlPlane(
  config: AppConfig,
  dependencies: AzureStagingM3ControlPlaneDependencies = {},
) {
  const settings = stagingM3ControlPlaneSettings(config);
  return settings
    ? new AzureStagingM3ControlPlane(settings, dependencies)
    : undefined;
}

/**
 * The explicit boolean makes this staging-only composition fail closed on every
 * Azure deployment by default. A live PayPal base is never accepted.
 */
export function stagingM3ControlPlaneSettings(
  config: AppConfig,
): StagingM3ControlPlaneSettings | undefined {
  const corsOrigins = parseCorsOrigins(config.XMCL_STAGING_M3_CORS_ORIGINS);
  if (
    config.XMCL_STAGING_M3_CHECKOUT_ENABLED !== "true" ||
    !hasText(config.MONGO_CONNECION_STRING) ||
    !validBillingRates(config.BILLING_RATES_JSON) ||
    !hasText(config.PAYPAL_CLIENT_ID) ||
    !hasText(config.PAYPAL_CLIENT_SECRET) ||
    !hasText(config.PAYPAL_WEBHOOK_ID) ||
    !sandboxPayPalApiBase(config.PAYPAL_API_BASE_URL) ||
    !validHttpsCallback(config.PAYPAL_RETURN_URL) ||
    !validHttpsCallback(config.PAYPAL_CANCEL_URL) ||
    !validKeyId(config.XMCL_STAGING_M3_PROXY_KEY_ID) ||
    !hasHmacSecret(config.XMCL_STAGING_M3_PROXY_SECRET) ||
    !corsOrigins
  ) {
    return undefined;
  }
  return {
    keyId: config.XMCL_STAGING_M3_PROXY_KEY_ID,
    secret: config.XMCL_STAGING_M3_PROXY_SECRET,
    corsOrigins,
  };
}

function validCorsRequestHeaders(value: string | undefined) {
  if (!value) return true;
  return value.split(",").every((name) =>
    STAGING_M3_CORS_HEADERS.includes(name.trim().toLowerCase() as never)
  );
}

function parseCorsOrigins(value: string | undefined) {
  if (!hasText(value)) return undefined;
  const parsed = value.split(",").map((origin) => origin.trim());
  if (!parsed.length || parsed.some((origin) => !validHttpsOrigin(origin))) {
    return undefined;
  }
  const normalized = parsed.map((origin) => new URL(origin).origin);
  return new Set(normalized).size === normalized.length ? normalized : undefined;
}

function validHttpsOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash &&
      value === url.origin;
  } catch {
    return false;
  }
}

function validHttpsCallback(value: string | undefined) {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username &&
      !url.password && !url.hash;
  } catch {
    return false;
  }
}

function sandboxPayPalApiBase(value: string | undefined): value is string {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "api-m.sandbox.paypal.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/";
  } catch {
    return false;
  }
}

function validBillingRates(value: string | undefined) {
  if (!hasText(value)) return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validKeyId(value: string | undefined): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function hasHmacSecret(value: string | undefined): value is string {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength >= 32;
}
