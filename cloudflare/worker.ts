// deno-lint-ignore-file no-explicit-any
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../src/config.ts";
import { createProductionApp } from "../src/lib/productionComposition.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { matchGroupUpgrade } from "../src/realtime/match.ts";
import { runServerControlScheduledSweep } from "../src/lib/serverControlScheduling.ts";
import { runSharedHostingBillingScheduledSweep } from "../src/lib/sharedHostingScheduling.ts";
import { runSharedNodeScheduledSweep } from "../src/lib/sharedNodeScheduling.ts";
import {
  createSharedHostingRuntime,
} from "../src/lib/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../src/lib/productionComposition.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import {
  HmacPayPalWebhookProxyIdentity,
} from "../src/lib/paypalWebhookProxyIdentity.ts";
import {
  PayPalWebhookBodyTooLargeError,
  readPayPalWebhookRawBody,
} from "../src/lib/paypalWebhook.ts";
import {
  HmacStagingM3ProxyIdentity,
  readStagingM3ProxyRawBody,
  StagingM3ProxyBodyTooLargeError,
} from "../src/lib/stagingM3ProxyIdentity.ts";
import {
  isStagingM3CorsRequest,
  isStagingM3PathCandidate,
  STAGING_M3_CORS_HEADERS,
  stagingM3AzureTarget,
} from "../src/lib/stagingM3Routes.ts";
import type { AppEnv } from "../src/types.ts";
import type { DbFactory } from "../src/db.ts";
import type { ExecutionContext, ScheduledController } from "./cf_types.ts";
import { GroupRoom } from "./group_room.ts";

// The Durable Object class must be exported from the worker module.
export { GroupRoom };

// bson initializes secure randomness at module evaluation time, which Cloudflare
// rejects in Worker global scope. Loading the Mongo connector on first database
// use keeps the Worker module side-effect free.
const getCloudflareDb: DbFactory = async (config) => {
  const { createDb } = await import("../src/platform/db_npm.ts");
  return createDb(config);
};

export const PAYPAL_WEBHOOK_PATH = "/v1/webhooks/paypal";
export const PAYPAL_WEBHOOK_AZURE_TARGET = "/api/v1/webhooks/paypal";
export const PAYPAL_WEBHOOK_STAGING_HOST =
  "xmcl-web-api-shared-sgp-staging.cijhn.workers.dev";
const PAYPAL_WEBHOOK_PROXY_TIMEOUT_MS = 10_000;
const PAYPAL_WEBHOOK_PROXY_MAX_RESPONSE_BYTES = 64 * 1024;
const STAGING_M3_PROXY_TIMEOUT_MS = 10_000;
const STAGING_M3_PROXY_MAX_RESPONSE_BYTES = 64 * 1024;
const payPalForwardedHeaders = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
  "paypal-webhook-id",
  "webhook-id",
] as const;

interface PayPalWebhookProxySettings {
  url: string;
  keyId: string;
  secret: string;
}

interface StagingM3ProxySettings {
  url: string;
  keyId: string;
  secret: string;
  corsOrigins: readonly string[];
}

/**
 * The proxy destination is deployment configuration, never a request input.
 * Reject every form that could make this an open proxy or change the Azure
 * Function route being authenticated.
 */
export function paypalWebhookProxySettings(
  env: AppConfig,
): PayPalWebhookProxySettings | undefined {
  if (
    !validKeyId(env.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID) ||
    !hasHmacSecret(env.XMCL_PAYPAL_WEBHOOK_PROXY_SECRET) ||
    typeof env.PAYPAL_WEBHOOK_PROXY_URL !== "string"
  ) {
    return undefined;
  }
  try {
    const url = new URL(env.PAYPAL_WEBHOOK_PROXY_URL);
    if (
      url.protocol !== "https:" || !url.hostname || url.username ||
      url.password || url.search || url.hash ||
      url.pathname !== PAYPAL_WEBHOOK_AZURE_TARGET
    ) {
      return undefined;
    }
    return {
      url: url.href,
      keyId: env.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID,
      secret: env.XMCL_PAYPAL_WEBHOOK_PROXY_SECRET,
    };
  } catch {
    return undefined;
  }
}

/**
 * The M3 destination is a reviewed Azure `/api` base, never a request value.
 * Individual paths are constructed from the strict route allowlist below.
 */
export function stagingM3ProxySettings(
  env: AppConfig,
): StagingM3ProxySettings | undefined {
  const corsOrigins = parseStagingM3CorsOrigins(env.XMCL_STAGING_M3_CORS_ORIGINS);
  if (
    !validKeyId(env.XMCL_STAGING_M3_PROXY_KEY_ID) ||
    !hasHmacSecret(env.XMCL_STAGING_M3_PROXY_SECRET) ||
    !corsOrigins ||
    typeof env.XMCL_STAGING_M3_PROXY_URL !== "string"
  ) {
    return undefined;
  }
  try {
    const url = new URL(env.XMCL_STAGING_M3_PROXY_URL);
    if (
      url.protocol !== "https:" || !url.hostname || url.username ||
      url.password || url.search || url.hash || url.pathname !== "/api"
    ) {
      return undefined;
    }
    return {
      url: url.href,
      keyId: env.XMCL_STAGING_M3_PROXY_KEY_ID,
      secret: env.XMCL_STAGING_M3_PROXY_SECRET,
      corsOrigins,
    };
  } catch {
    return undefined;
  }
}

/**
 * Returns `undefined` unless this is the one fixed PayPal delivery endpoint.
 * Its caller can then fall through to the normal, payment-disabled app.
 */
export async function proxyPayPalWebhook(
  request: Request,
  env: AppConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const incoming = new URL(request.url);
  const settings = paypalWebhookProxySettings(env);
  const webhookTarget = incoming.hostname === PAYPAL_WEBHOOK_STAGING_HOST &&
    incoming.pathname === PAYPAL_WEBHOOK_PATH;
  if (
    webhookTarget &&
    (!settings || request.method !== "POST" || incoming.search)
  ) {
    return new Response("Not Found", { status: 404 });
  }
  if (!settings) return undefined;
  if (
    !webhookTarget || request.method !== "POST" || incoming.search
  ) {
    return undefined;
  }

  let raw: Uint8Array;
  try {
    raw = await readPayPalWebhookRawBody(request);
  } catch (error) {
    if (error instanceof PayPalWebhookBodyTooLargeError) {
      return new Response(JSON.stringify({ error: "payload_too_large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "invalid_webhook_payload" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = forwardedPayPalHeaders(request.headers);
  const identity = new HmacPayPalWebhookProxyIdentity({
    keyId: settings.keyId,
    secret: settings.secret,
  });
  let phase = "identity";
  let timedOut = false;
  try {
    const identityHeaders = await identity.signOutgoing({
      method: "POST",
      target: PAYPAL_WEBHOOK_AZURE_TARGET,
      body: raw,
    });
    for (const [name, value] of Object.entries(identityHeaders)) {
      headers.set(name, value);
    }
    phase = "backend_fetch";
    const controller = new AbortController();
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      PAYPAL_WEBHOOK_PROXY_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(settings.url, {
        method: "POST",
        headers,
        body: raw as unknown as BodyInit,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("backend redirect rejected");
      }
      const responseHeaders = responseHeadersFor(response);
      const responseBody = await readLimitedResponse(
        response,
        PAYPAL_WEBHOOK_PROXY_MAX_RESPONSE_BYTES,
      );
      return new Response(responseBody, {
        status: response.status,
        headers: responseHeaders,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error("paypal_webhook_proxy_unavailable", {
      event: "paypal_webhook_proxy_unavailable",
      error: timedOut || (error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "AbortError"))
        ? "timeout"
        : "fetch_failure",
      phase,
    });
    const status = timedOut || (error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      )
      ? 503
      : 502;
    return new Response(JSON.stringify({ error: "paypal_webhook_proxy_unavailable" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Handles a browser preflight locally. It is not a backend proxy route and is
 * intentionally limited to the same path/method/header allowlist as the
 * authenticated M3 API calls.
 */
export function stagingM3CorsPreflight(
  request: Request,
  env: AppConfig,
) {
  const incoming = new URL(request.url);
  if (
    incoming.hostname !== PAYPAL_WEBHOOK_STAGING_HOST ||
    !isStagingM3PathCandidate(incoming.pathname) ||
    request.method !== "OPTIONS"
  ) {
    return undefined;
  }
  const settings = stagingM3ProxySettings(env);
  const origin = request.headers.get("origin") ?? undefined;
  const requestedMethod = request.headers.get("access-control-request-method") ??
    undefined;
  if (
    !settings || incoming.search || !origin ||
    !settings.corsOrigins.includes(origin) ||
    !isStagingM3CorsRequest(requestedMethod, incoming.pathname) ||
    !validCorsRequestHeaders(request.headers.get(
      "access-control-request-headers",
    ) ?? undefined)
  ) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": requestedMethod!.toUpperCase(),
      "access-control-allow-headers": STAGING_M3_CORS_HEADERS.join(", "),
      "access-control-max-age": "600",
      "vary": "origin",
    },
  });
}

/**
 * Staging M3 is a fixed, narrow Worker-to-Azure control-plane proxy. It never
 * opens the Worker Mongo connector and never accepts a caller-selected target.
 */
export async function proxyStagingM3(
  request: Request,
  env: AppConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const incoming = new URL(request.url);
  const isStagingCandidate = incoming.hostname === PAYPAL_WEBHOOK_STAGING_HOST &&
    isStagingM3PathCandidate(incoming.pathname);
  if (!isStagingCandidate) return undefined;

  const settings = stagingM3ProxySettings(env);
  const target = stagingM3AzureTarget(request.method, incoming.pathname);
  if (!settings || !target || incoming.search) {
    return new Response("Not Found", { status: 404 });
  }

  const origin = request.headers.get("origin") ?? undefined;
  if (origin && !settings.corsOrigins.includes(origin)) {
    return new Response("Not Found", { status: 404 });
  }

  let raw = new Uint8Array();
  if (request.method === "POST") {
    try {
      raw = await readStagingM3ProxyRawBody(request);
    } catch (error) {
      if (error instanceof StagingM3ProxyBodyTooLargeError) {
        return new Response(JSON.stringify({ error: "payload_too_large" }), {
          status: 413,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const headers = forwardedStagingM3Headers(request.headers);
  const identity = new HmacStagingM3ProxyIdentity({
    keyId: settings.keyId,
    secret: settings.secret,
  });
  let timedOut = false;
  try {
    const identityHeaders = await identity.signOutgoing({
      method: request.method,
      target,
      body: raw,
    });
    for (const [name, value] of Object.entries(identityHeaders)) {
      headers.set(name, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STAGING_M3_PROXY_TIMEOUT_MS);
    try {
      const response = await fetchImpl(stagingM3TargetUrl(settings.url, target), {
        method: request.method,
        headers,
        body: request.method === "POST" ? raw as unknown as BodyInit : undefined,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("backend redirect rejected");
      }
      return new Response(
        await readLimitedResponse(response, STAGING_M3_PROXY_MAX_RESPONSE_BYTES),
        {
          status: response.status,
          headers: responseHeadersFor(response, true),
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error("staging_m3_proxy_unavailable", {
      event: "staging_m3_proxy_unavailable",
      error: timedOut || (error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "AbortError"))
        ? "timeout"
        : "fetch_failure",
    });
    return new Response(
      JSON.stringify({ error: "staging_m3_proxy_unavailable" }),
      {
        status: timedOut || (error instanceof DOMException &&
            (error.name === "TimeoutError" || error.name === "AbortError"))
          ? 503
          : 502,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

function forwardedPayPalHeaders(source: Headers) {
  const headers = new Headers();
  const contentType = source.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  for (const name of payPalForwardedHeaders) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function forwardedStagingM3Headers(source: Headers) {
  const headers = new Headers();
  for (
    const name of [
      "content-type",
      "authorization",
      "idempotency-key",
      "origin",
    ]
  ) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function stagingM3TargetUrl(base: string, target: string) {
  const url = new URL(base);
  url.pathname = target;
  return url.href;
}

function parseStagingM3CorsOrigins(value: string | undefined) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const origins = value.split(",").map((origin) => origin.trim());
  if (!origins.length || origins.some((origin) => !validHttpsOrigin(origin))) {
    return undefined;
  }
  const normalized = origins.map((origin) => new URL(origin).origin);
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

function validCorsRequestHeaders(value: string | undefined) {
  if (!value) return true;
  return value.split(",").every((name) =>
    STAGING_M3_CORS_HEADERS.includes(name.trim().toLowerCase() as never)
  );
}

function responseHeadersFor(response: Response, includeCors = false) {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (includeCors) {
    for (
      const name of [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-max-age",
        "vary",
      ]
    ) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return headers;
}

async function readLimitedResponse(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength && /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new Error("backend response exceeds proxy limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("backend response exceeds proxy limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validKeyId(value: string | undefined): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function hasHmacSecret(value: string | undefined): value is string {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength >= 32;
}

/**
 * Cloudflare Workers entry point. Reuses the shared Hono app and injects the
 * Cloudflare-specific platform behaviour:
 *  - `/group/:id` realtime upgrades are forwarded to the GroupRoom Durable
 *    Object (intercepted before the app so CORS never touches the 101 response).
 *  - `/translation` records cache misses in Mongo for an external batch worker.
 *  - geo is resolved natively via `request.cf.country` (see src/geo.ts).
 */
const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env as any;
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
    c.set(
      "billingAdminOperationAdapter",
      env.BILLING_ADMIN_OPERATION_ADAPTER,
    );
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
    c.set(
      "adminOperationReconciliation",
      env.ADMIN_OPERATION_RECONCILIATION,
    );
  }
  if (env.ADMIN_OPERATION_ACCOUNT_READER) {
    c.set("adminOperationAccountReader", env.ADMIN_OPERATION_ACCOUNT_READER);
  }
  await next();
});

function createCloudflareApp(
  env: AppConfig,
) {
  const signer = createS3SigV4Presigner({
    endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
  return createProductionApp((a) => {
    a.use("*", createDbMiddleware(getCloudflareDb));
    a.use("*", platformMiddleware);
  }, env, { SHARED_NODE_WORKSPACE_SIGNER: signer });
}

export default {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Make the proxy decision before constructing the Hono app. In particular,
    // no Cloudflare Mongo connector is imported or invoked for this path.
    const preflight = stagingM3CorsPreflight(request, env);
    if (preflight) return preflight;
    const stagingM3 = await proxyStagingM3(request, env);
    if (stagingM3) return stagingM3;
    const proxied = await proxyPayPalWebhook(request, env);
    if (proxied) return proxied;
    const group = matchGroupUpgrade(request);
    if (group !== undefined) {
      const ns = env.GROUP_ROOM;
      const stub = ns.get(ns.idFromName(group));
      return stub.fetch(request);
    }
    return createCloudflareApp(env).fetch(request, env, ctx);
  },

  scheduled(
    controller: ScheduledController,
    env: any,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      (async () => {
        try {
          if (env.SERVER_CONTROL_SCHEDULED_WORK) {
            await runServerControlScheduledSweep(
              env.SERVER_CONTROL_SCHEDULED_WORK,
              new Date(controller.scheduledTime).toISOString(),
            );
          }
          const scheduledAt = new Date(controller.scheduledTime).toISOString();
          const signer = createS3SigV4Presigner({
            endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
            region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
            bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
            accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
            secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
          });
          if (hasSharedNodeRuntimeSettings(env, {
            SHARED_NODE_WORKSPACE_SIGNER: signer,
          })) {
            const runtime = createSharedHostingRuntime(
              await getCloudflareDb(env),
              env,
              signer,
            );
            await runSharedHostingBillingScheduledSweep(
              runtime.billingScheduledWork,
              scheduledAt,
            );
            await runtime.scheduler.processCapacityRequests();
            await runSharedNodeScheduledSweep(
              runtime.transport,
              scheduledAt,
            );
          } else if (env.SHARED_HOSTING_BILLING_SCHEDULED_WORK) {
            await runSharedHostingBillingScheduledSweep(
              env.SHARED_HOSTING_BILLING_SCHEDULED_WORK,
              scheduledAt,
            );
          } else if (env.SHARED_NODE_SCHEDULED_WORK) {
            await runSharedNodeScheduledSweep(
              env.SHARED_NODE_SCHEDULED_WORK,
              scheduledAt,
            );
          }
          await env.RECONCILIATION_SCHEDULED_WORK?.run?.();
        } catch (e) {
          console.error(e);
        }
      })(),
    );
  },
};
