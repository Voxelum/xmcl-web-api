import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { getCloudflareDb } from "../../src/cloudflare/runtime.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "../../src/cloudflare/types.ts";
import type { AppConfig } from "../../src/config.ts";
import { createDbMiddleware } from "../../src/middleware/db.ts";
import { getBillingRuntime } from "../../src/billingRuntime.ts";
import {
  createSharedHostingRuntime,
  getSharedHostingRuntime,
} from "../../src/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../../src/productionComposition.ts";
import { createS3SigV4Presigner } from "../../src/s3SigV4.ts";
import { runSharedHostingBillingScheduledSweep } from "../../src/sharedHostingScheduling.ts";
import { runSharedNodeScheduledSweep } from "../../src/sharedNodeScheduling.ts";
import { createBillingRoutes } from "../../src/routes/billing.ts";
import { createSharedHostingRoutes } from "../../src/routes/sharedHosting.ts";
import { createSharedHostingServiceRoutes } from "../../src/routes/sharedHostingServices.ts";
import { createSharedNodeTransportRoutes } from "../../src/routes/sharedNodeTransport.ts";
import { createWaffoRoutes } from "../../src/routes/waffo.ts";
import { createXmclPlusRoutes } from "../../src/routes/xmclPlus.ts";
import type { AppEnv } from "../../src/types.ts";

const webhookPath = "/v1/webhooks/waffo";
const checkoutPath = "/v1/billing/waffo/orders";
const billingReadPaths = new Set([
  "/v1/billing/balance",
  "/v1/billing/rates",
  "/v1/billing/orders",
  "/v1/billing/ledger",
  "/v1/billing/usage",
]);
const sharedHostingReadPaths = new Set([
  "/v1/shared-hosting/plans",
  "/v1/shared-hosting/regions",
  "/v1/shared-hosting/subscriptions",
]);
const plusReadPaths = new Set([
  "/v1/xmcl-plus/offer",
  "/v1/xmcl-plus/status",
  "/v1/xmcl-plus/allowances",
]);
const app = new Hono<AppEnv>();
type StagingBindings = AppConfig & AppEnv["Bindings"];

app.use("*", createDbMiddleware(getCloudflareDb));
const stagingCors = () =>
  cors({
    origin: (origin, c) => {
      const allowed = String(
        c.env.XMCL_STAGING_BILLING_CORS_ORIGINS ?? "",
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
  });
app.use("/v1/billing/*", stagingCors());
app.use("/v1/shared-hosting/*", stagingCors());
app.use("/v1/xmcl-plus/*", stagingCors());
app.use("/v1/shared-hosting/*", async (c, next) => {
  await getBillingRuntime(c);
  await next();
});
app.use("/v1/xmcl-plus/*", async (c, next) => {
  await getBillingRuntime(c);
  await next();
});
const composeSharedRuntime = async (
  c: Context<AppEnv>,
  next: Next,
) => {
  const signer = workspaceSigner(c.env as StagingBindings);
  if (!hasSharedNodeRuntimeSettings(c.env as StagingBindings, {
    SHARED_NODE_WORKSPACE_SIGNER: signer,
  })) {
    return c.json({ error: "shared_hosting_unavailable" }, 503);
  }
  await getSharedHostingRuntime(c, signer);
  await next();
};
app.use("/v1/shared-hosting/services", composeSharedRuntime);
app.use("/v1/shared-hosting/services/*", composeSharedRuntime);
app.use("/v1/internal/shared-nodes/*", composeSharedRuntime);
app.route("/", createBillingRoutes());
app.route("/", createSharedHostingRoutes());
app.route("/", createSharedHostingServiceRoutes());
app.route("/", createSharedNodeTransportRoutes());
app.route("/", createXmclPlusRoutes());
app.route("/", createWaffoRoutes());

function workspaceSigner(env: StagingBindings) {
  return createS3SigV4Presigner({
    endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
}

export default {
  async fetch(
    request: Request,
    env: StagingBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", environment: "test" });
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      try {
        await getCloudflareDb(env);
        return Response.json({ status: "ready", environment: "test" });
      } catch (error) {
        console.error({
          event: "waffo_staging.readiness_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: typeof error === "object" && error !== null &&
              "code" in error
            ? String(error.code)
            : undefined,
        });
        return Response.json({ status: "unavailable" }, { status: 503 });
      }
    }
    const isBillingRead = request.method === "GET" &&
      (billingReadPaths.has(url.pathname) ||
        /^\/v1\/billing\/orders\/[^/]+$/.test(url.pathname));
    const isBillingMutation = request.method === "POST" &&
      url.pathname === checkoutPath;
    const isBillingPreflight = request.method === "OPTIONS" &&
      url.pathname.startsWith("/v1/billing/");
    const isSharedHostingRead = request.method === "GET" &&
      (sharedHostingReadPaths.has(url.pathname) ||
        url.pathname === "/v1/shared-hosting/services" ||
        /^\/v1\/shared-hosting\/services\/[^/]+\/export$/.test(url.pathname));
    const isSharedHostingMutation = request.method === "POST" &&
      (url.pathname === "/v1/shared-hosting/subscriptions" ||
        url.pathname === "/v1/shared-hosting/services" ||
        /^\/v1\/shared-hosting\/subscriptions\/[^/]+\/cancel$/.test(
          url.pathname,
        ) ||
        /^\/v1\/shared-hosting\/services\/[^/]+\/(?:start|stop)$/.test(
          url.pathname,
        ));
    const isSharedHostingPreflight = request.method === "OPTIONS" &&
      url.pathname.startsWith("/v1/shared-hosting/");
    const isPlusRead = request.method === "GET" &&
      plusReadPaths.has(url.pathname);
    const isPlusMutation = request.method === "POST" &&
      (url.pathname === "/v1/xmcl-plus/subscribe" ||
        url.pathname === "/v1/xmcl-plus/cancel");
    const isPlusPreflight = request.method === "OPTIONS" &&
      url.pathname.startsWith("/v1/xmcl-plus/");
    const isWebhook = request.method === "POST" &&
      url.pathname === webhookPath;
    const isSharedNodeTransport =
      url.pathname.startsWith("/v1/internal/shared-nodes/");
    if (
      !isBillingRead && !isBillingMutation && !isBillingPreflight &&
      !isSharedHostingRead && !isSharedHostingMutation &&
      !isSharedHostingPreflight && !isPlusRead && !isPlusMutation &&
      !isPlusPreflight && !isWebhook && !isSharedNodeTransport
    ) {
      return new Response("Not Found", { status: 404 });
    }
    return app.fetch(request, env, ctx);
  },

  scheduled(
    controller: ScheduledController,
    env: StagingBindings,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil((async () => {
      const signer = workspaceSigner(env);
      if (!hasSharedNodeRuntimeSettings(env, {
        SHARED_NODE_WORKSPACE_SIGNER: signer,
      })) {
        throw new Error("shared node production settings are incomplete");
      }
      const runtime = createSharedHostingRuntime(
        await getCloudflareDb(env),
        env,
        signer,
      );
      const scheduledAt = new Date(controller.scheduledTime).toISOString();
      const failures: unknown[] = [];
      for (
        const task of [
          () => runSharedNodeScheduledSweep(runtime.transport, scheduledAt),
          () =>
            runSharedHostingBillingScheduledSweep(
              runtime.billingScheduledWork,
              scheduledAt,
            ),
        ]
      ) {
        try {
          await task();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "shared hosting scheduled work failed");
      }
    })());
  },
};
