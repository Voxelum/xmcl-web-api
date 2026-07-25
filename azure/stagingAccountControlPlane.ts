import type { Context, Hono } from "hono";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import {
  HmacStagingAccountProxyIdentity,
  MongoStagingAccountProxyNonceStore,
  readStagingAccountProxyRawBody,
  StagingAccountProxyBodyTooLargeError,
} from "../src/lib/stagingAccountProxyIdentity.ts";
import {
  authorizeQueryUsesConfiguredCallback,
  isStagingAccountCorsRequest,
  STAGING_ACCOUNT_CORS_HEADERS,
  stagingAccountAzureTarget,
} from "../src/lib/stagingAccountRoutes.ts";
import type { AccountRuntimeResolver } from "../src/middleware/xmclAuth.ts";
import { createAccountRoutes } from "../src/routes/account.ts";
import { createSessionRoutes } from "../src/routes/session.ts";
import type { AppEnv } from "../src/types.ts";

interface StagingAccountControlPlaneSettings {
  keyId: string;
  secret: string;
  corsOrigins: readonly string[];
}

export interface AzureStagingAccountControlPlaneDependencies {
  now?: () => number;
  resolveAccountRuntime?: AccountRuntimeResolver;
}

/**
 * Azure-only staging M1 account/session plane. Its guard authenticates the
 * Worker request before the existing account/session route implementations run.
 */
export class AzureStagingAccountControlPlane {
  constructor(
    private readonly settings: StagingAccountControlPlaneSettings,
    private readonly dependencies: AzureStagingAccountControlPlaneDependencies,
  ) {}

  register(app: Hono<AppEnv>) {
    const guard = async (
      c: Context<AppEnv>,
      next: () => Promise<void>,
    ) => {
      const url = new URL(c.req.url);
      const path = c.req.path;
      if (c.req.method === "OPTIONS") {
        return this.preflight(
          c.req.header("origin"),
          path,
          url.search,
          c.req.header("access-control-request-method"),
          c.req.header("access-control-request-headers"),
        );
      }

      const target = stagingAccountAzureTarget(
        c.req.method,
        path,
        url.search,
      );
      if (
        !target ||
        !authorizeTargetUsesConfiguredCallback(
          path,
          url.search,
          this.settings.corsOrigins,
        )
      ) {
        return c.json({ error: "not_found" }, 404);
      }
      const origin = c.req.header("origin");
      if (!this.setCors(origin, c.res.headers)) {
        return c.json({ error: "forbidden" }, 403);
      }
      if (c.req.header("x-xmcl-original-target") !== target) {
        return c.json({ error: "unauthorized" }, 401);
      }

      let raw: Uint8Array;
      try {
        raw = await readStagingAccountProxyRawBody(c.req.raw.clone());
      } catch (error) {
        if (error instanceof StagingAccountProxyBodyTooLargeError) {
          return c.json({ error: "payload_too_large" }, 413);
        }
        return c.json({ error: "unauthorized" }, 401);
      }

      const getDb = c.get("getDb");
      if (!getDb) return c.json({ error: "staging_account_unavailable" }, 503);
      let db: Db;
      try {
        db = await getDb();
      } catch {
        return c.json({ error: "staging_account_unavailable" }, 503);
      }

      const identity = new HmacStagingAccountProxyIdentity({
        keyId: this.settings.keyId,
        secret: this.settings.secret,
        nonceStore: new MongoStagingAccountProxyNonceStore(db),
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
    };

    // These route-family guards also stop the unreviewed session launcher and
    // account merge/deletion handlers from falling through to mounted routes.
    app.use("/v1/auth/*", guard);
    app.use("/v1/account/*", guard);
    app.use("/v1/sessions/*", guard);
    app.route(
      "/",
      createSessionRoutes(this.dependencies.resolveAccountRuntime, {
        launcherExchange: false,
      }),
    );
    app.route(
      "/",
      createAccountRoutes(this.dependencies.resolveAccountRuntime, {
        mergeRoutes: false,
        deletionRoutes: false,
      }),
    );
  }

  private preflight(
    origin: string | undefined,
    path: string,
    search: string,
    requestedMethod: string | undefined,
    requestedHeaders: string | undefined,
  ) {
    if (
      !this.validOrigin(origin) ||
      !isStagingAccountCorsRequest(requestedMethod, path, search) ||
      !authorizeTargetUsesConfiguredCallback(
        path,
        search,
        this.settings.corsOrigins,
      ) ||
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
    headers.set(
      "access-control-allow-headers",
      STAGING_ACCOUNT_CORS_HEADERS.join(", "),
    );
    headers.set("access-control-max-age", "600");
    return new Response(null, { status: 204, headers });
  }

  private validOrigin(origin: string | undefined) {
    return origin !== undefined && this.settings.corsOrigins.includes(origin);
  }

  private setCors(origin: string | undefined, headers: Headers) {
    if (!this.validOrigin(origin)) return false;
    headers.set("access-control-allow-origin", origin!);
    headers.append("vary", "origin");
    return true;
  }
}

export function createAzureStagingAccountControlPlane(
  config: AppConfig,
  dependencies: AzureStagingAccountControlPlaneDependencies = {},
) {
  const settings = stagingAccountControlPlaneSettings(config);
  return settings
    ? new AzureStagingAccountControlPlane(settings, dependencies)
    : undefined;
}

/**
 * The M1 proxy cannot accidentally turn on with only a Worker secret. It needs
 * a complete Mongo-backed account runtime, all fixed browser OAuth providers,
 * exact Pages origins, and their declared callbacks.
 */
export function stagingAccountControlPlaneSettings(
  config: AppConfig,
): StagingAccountControlPlaneSettings | undefined {
  const corsOrigins = parseCorsOrigins(
    config.XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS,
  );
  if (
    config.XMCL_STAGING_ACCOUNT_PROXY_ENABLED !== "true" ||
    !hasText(config.MONGO_CONNECION_STRING) ||
    !hasHmacSecret(config.XMCL_SESSION_SECRET) ||
    !hasText(config.XMCL_MICROSOFT_CLIENT_ID) ||
    !hasText(config.XMCL_MICROSOFT_CLIENT_SECRET) ||
    !hasText(config.XMCL_MODRINTH_CLIENT_ID) ||
    !hasText(config.XMCL_MODRINTH_CLIENT_SECRET) ||
    !hasText(config.XMCL_GOOGLE_CLIENT_ID) ||
    !hasText(config.XMCL_GOOGLE_CLIENT_SECRET) ||
    !hasText(config.XMCL_DISCORD_CLIENT_ID) ||
    !hasText(config.XMCL_DISCORD_CLIENT_SECRET) ||
    !validKeyId(config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID) ||
    !hasHmacSecret(config.XMCL_STAGING_ACCOUNT_PROXY_SECRET) ||
    !distinctWhenConfigured(
      config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID,
      config.XMCL_STAGING_M3_PROXY_KEY_ID,
      config.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID,
    ) ||
    !distinctWhenConfigured(
      config.XMCL_STAGING_ACCOUNT_PROXY_SECRET,
      config.XMCL_STAGING_M3_PROXY_SECRET,
      config.XMCL_PAYPAL_WEBHOOK_PROXY_SECRET,
    ) ||
    !corsOrigins ||
    !configuredCallbacksMatchOrigins(
      config.XMCL_OAUTH_REDIRECT_URIS,
      corsOrigins,
    )
  ) {
    return undefined;
  }
  return {
    keyId: config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID,
    secret: config.XMCL_STAGING_ACCOUNT_PROXY_SECRET,
    corsOrigins,
  };
}

function authorizeTargetUsesConfiguredCallback(
  path: string,
  search: string,
  corsOrigins: readonly string[],
) {
  return !isProviderAuthorizePath(path) ||
    authorizeQueryUsesConfiguredCallback(search, corsOrigins);
}

function isProviderAuthorizePath(path: string) {
  return /^\/v1\/auth\/(?:microsoft|modrinth|google|discord)\/authorize$/.test(
    path,
  );
}

function validCorsRequestHeaders(value: string | undefined) {
  if (!value) return true;
  return value.split(",").every((name) =>
    STAGING_ACCOUNT_CORS_HEADERS.includes(name.trim().toLowerCase() as never)
  );
}

function parseCorsOrigins(value: string | undefined) {
  if (!hasText(value)) return undefined;
  const parsed = value.split(",").map((origin) => origin.trim());
  if (!parsed.length || parsed.some((origin) => !validHttpsOrigin(origin))) {
    return undefined;
  }
  const normalized = parsed.map((origin) => new URL(origin).origin);
  return new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function configuredCallbacksMatchOrigins(
  value: string | undefined,
  corsOrigins: readonly string[],
) {
  if (!hasText(value)) return false;
  const declared = new Set(value.split(",").map((item) => item.trim()));
  return corsOrigins.every((origin) =>
    declared.has(`${origin}/oauth/callback`)
  );
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

function distinctWhenConfigured(
  value: string,
  ...otherValues: Array<string | undefined>
) {
  return otherValues.every((other) => !other || other !== value);
}
