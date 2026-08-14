import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { getCloudflareDb } from "../../src/cloudflare/runtime.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "../../src/cloudflare/types.ts";
import type { AppConfig } from "../../src/config.ts";
import { createDbMiddleware } from "../../src/middleware/db.ts";
import { getBillingRuntime } from "../../src/billingRuntime.ts";
import { MongoBillingStore } from "../../src/ledger.ts";
import { AllowanceMeter } from "../../src/allowanceMetering.ts";
import { XmclPlusService } from "../../src/xmclPlus.ts";
import { runtimeEnvironmentError } from "../../src/runtimeEnvironment.ts";
import {
  runTurnMeteringSweep,
  TurnCredentialMeter,
} from "../../src/turnMetering.ts";
import { getAccountRuntime } from "../../src/accountRuntime.ts";
import { getSharedHostingRuntime } from "../../src/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../../src/productionComposition.ts";
import { createS3SigV4Presigner } from "../../src/s3SigV4.ts";
import { createBillingRoutes } from "../../src/routes/billing.ts";
import { createSharedHostingRoutes } from "../../src/routes/sharedHosting.ts";
import { createSharedHostingServiceRoutes } from "../../src/routes/sharedHostingServices.ts";
import { createSharedNodeTransportRoutes } from "../../src/routes/sharedNodeTransport.ts";
import { createWaffoRoutes } from "../../src/routes/waffo.ts";
import { createXmclPlusRoutes } from "../../src/routes/xmclPlus.ts";
import { createSessionRoutes } from "../../src/routes/session.ts";
import { createAccountRoutes } from "../../src/routes/account.ts";
import { createChatCompletionsRoutes } from "../../src/routes/chatCompletions.ts";
import { createRtcRoutes } from "../../src/routes/rtc.ts";
import operations from "../../src/routes/operations.ts";
import { authenticateXmclRequest } from "../../src/middleware/xmclAuth.ts";
import type { Account } from "../../src/account.ts";
import type { AdminBillingOverview } from "../../src/billing.ts";
import type {
  AdminPrincipal,
  AdminPrincipalAuthenticator,
} from "../../src/operations.ts";
import type { AppEnv } from "../../src/types.ts";
import { observeWorkerRequest } from "../../src/cloudflare/observability.ts";
import {
  type DiscordAlert,
  sendDiscordAlert,
} from "../../src/discordAlerting.ts";
import {
  AlertCooldownObject,
  claimAlertCooldown,
  releaseAlertCooldown,
} from "../../src/cloudflare/alertCooldown.ts";

export { AlertCooldownObject };

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
const adminReadPaths = new Set([
  "/v1/admin/audit-events",
  "/v1/admin/billing/overview",
  "/v1/admin/reconciliation",
]);
const app = new Hono<AppEnv>();
type StagingBindings = AppConfig & AppEnv["Bindings"];
const ALERT_COOLDOWN_MS = 15 * 60_000;

async function alertStaging(
  env: StagingBindings,
  alert: Omit<DiscordAlert, "environment" | "occurredAt"> & {
    occurredAt?: string;
  },
) {
  const webhookUrl = env.XMCL_STAGING_DISCORD_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;
  if (!env.ALERT_COOLDOWN) {
    console.error({
      event: "alert.cooldown_not_configured",
      alertEvent: alert.event,
    });
    return;
  }
  const now = Date.now();
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown(
      env.ALERT_COOLDOWN,
      alert.event,
      now,
      ALERT_COOLDOWN_MS,
    );
  } catch (error) {
    console.error({
      event: "alert.cooldown_failed",
      alertEvent: alert.event,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return;
  }
  if (!claimed) return;
  try {
    await sendDiscordAlert(webhookUrl, {
      ...alert,
      environment: "staging",
      occurredAt: alert.occurredAt ?? new Date(now).toISOString(),
    });
  } catch (error) {
    await releaseAlertCooldown(env.ALERT_COOLDOWN, alert.event).catch(() => {});
    console.error({
      event: "alert.discord_delivery_failed",
      alertEvent: alert.event,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return;
  }
}

app.use("*", createDbMiddleware(getCloudflareDb));
const stagingCors = () =>
  cors({
    origin: (origin, c) => {
      const allowed = String(
        c.env.XMCL_STAGING_BILLING_CORS_ORIGINS ?? "",
      ).split(",").map((value) => value.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
app.use("/v1/auth/*", stagingCors());
app.use("/v1/sessions/*", stagingCors());
app.use("/v1/account", stagingCors());
app.use("/v1/account/*", stagingCors());
app.use("/v1/admin/*", stagingCors());
app.use("/v1/chat/*", stagingCors());
app.use("/v1/rtc/*", stagingCors());
app.use("/v1/shared-hosting/*", async (c, next) => {
  await getBillingRuntime(c);
  await next();
});
app.use("/v1/xmcl-plus/*", async (c, next) => {
  await getBillingRuntime(c);
  await next();
});
app.use("/v1/admin/*", async (c, next) => {
  await getBillingRuntime(c);
  const config = c.env as StagingBindings;
  const authenticator = stagingAdminAuthenticator(
    config.XMCL_STAGING_ADMIN_ACCESS_TOKEN,
    config.XMCL_STAGING_ADMIN_SESSION_SECRET,
  );
  if (authenticator) c.set("adminOperationAuthenticator", authenticator);
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

      return {
        items,
      };
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
          correlationId: String(record.requestId ?? record.auditId ?? record._id),
          occurredAt: String(record.occurredAt),
        })),
    };
  });
  await next();
});
const composeSharedRuntime = async (
  c: Context<AppEnv>,
  next: Next,
) => {
  const signer = workspaceSigner(c.env as StagingBindings);
  if (
    !hasSharedNodeRuntimeSettings(c.env as StagingBindings, {
      SHARED_NODE_WORKSPACE_SIGNER: signer,
    })
  ) {
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
app.route("/", createSessionRoutes());
app.route("/", createAccountRoutes());
app.route("/", createChatCompletionsRoutes());
app.route("/", createRtcRoutes());
app.post("/v1/admin/session", async (c) => {
  const config = c.env as StagingBindings;
  if (
    !config.XMCL_STAGING_ADMIN_SESSION_SECRET ||
    !config.XMCL_STAGING_ADMIN_EMAILS
  ) {
    return c.json({ error: "admin_auth_unavailable" }, 503);
  }
  try {
    const principal = await authenticateXmclRequest(c);
    if (!isRecentBrowserOAuthAdminPrincipal(principal!)) {
      return c.json({ error: "admin_reauthentication_required" }, 401);
    }
    const account = await (await getAccountRuntime(c)).accounts.requireAccount(
      principal!.accountId,
    );
    const allowedEmails = new Set(
      config.XMCL_STAGING_ADMIN_EMAILS.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const email = verifiedAllowedAdminEmail(account, allowedEmails);
    if (!email) return c.json({ error: "admin_forbidden" }, 403);
    return c.json(
      await issueStagingAdminSession(
        config.XMCL_STAGING_ADMIN_SESSION_SECRET,
        account.accountId,
      ),
    );
  } catch {
    return c.json({ error: "admin_authentication_required" }, 401);
  }
});
app.route("/", operations);

export function stagingAdminAuthenticator(
  staticToken: string | undefined,
  sessionSecret?: string,
): AdminPrincipalAuthenticator | undefined {
  if (!staticToken && !sessionSecret) return undefined;
  return {
    async authenticate(authorization) {
      const actualToken = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!actualToken) return undefined;
      if (staticToken && await secureTokenEqual(actualToken, staticToken)) {
        return {
          id: "staging-billing-operator",
          scopes: ["billing_operator"],
          authenticatedAt: new Date().toISOString(),
        };
      }
      return sessionSecret
        ? await verifyStagingAdminSession(sessionSecret, actualToken)
        : undefined;
    },
  };
}

export async function issueStagingAdminSession(
  secret: string,
  accountId: string,
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000);
  const payload = encodeAdminPayload({
    version: 2,
    accountId,
    authenticatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return {
    accessToken: `${payload}.${await signAdminPayload(secret, payload)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyStagingAdminSession(
  secret: string,
  token: string,
): Promise<AdminPrincipal | undefined> {
  const [payload, signature, ...extra] = token.split(".");
  if (!payload || !signature || extra.length > 0) return undefined;
  if (
    !await secureTokenEqual(
      signature,
      await signAdminPayload(secret, payload),
    )
  ) return undefined;
  try {
    const claims = decodeAdminPayload(payload);
    const authenticatedAt = Date.parse(String(claims.authenticatedAt));
    const expiresAt = Date.parse(String(claims.expiresAt));
    const now = Date.now();
    if (
      claims.version !== 2 ||
      typeof claims.accountId !== "string" ||
      typeof claims.authenticatedAt !== "string" ||
      typeof claims.expiresAt !== "string" ||
      !Number.isFinite(authenticatedAt) ||
      !Number.isFinite(expiresAt) ||
      authenticatedAt > now + 60_000 ||
      expiresAt <= now ||
      expiresAt <= authenticatedAt ||
      expiresAt - authenticatedAt > 15 * 60_000 + 1_000
    ) return undefined;
    return {
      id: claims.accountId,
      scopes: ["admin"],
      authenticatedAt: claims.authenticatedAt,
    };
  } catch {
    return undefined;
  }
}

function encodeAdminPayload(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeAdminPayload(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
  ) as {
    version?: unknown;
    accountId?: unknown;
    authenticatedAt?: unknown;
    expiresAt?: unknown;
  };
}

async function signAdminPayload(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    ),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function isRecentBrowserOAuthAdminPrincipal(
  principal: Pick<
    import("../../src/session.ts").XmclPrincipal,
    "authenticatedAt" | "authenticationMethod"
  >,
  now = new Date(),
) {
  if (
    principal.authenticationMethod !== "browser_oauth" ||
    !principal.authenticatedAt
  ) return false;
  const authenticatedAt = Date.parse(principal.authenticatedAt);
  const age = now.getTime() - authenticatedAt;
  return Number.isFinite(authenticatedAt) && age >= -60_000 &&
    age <= 15 * 60_000;
}

export function verifiedAllowedAdminEmail(
  account: Account,
  allowedEmails: ReadonlySet<string>,
) {
  return account.identities
    .filter((identity) => identity.emailVerified === true)
    .map((identity) => identity.email?.toLowerCase())
    .find((value): value is string => !!value && allowedEmails.has(value));
}

function publicAdminAccount(account: Account) {
  return {
    accountId: account.accountId,
    status: account.status,
    createdAt: account.createdAt,
    ...(account.deletionEffectiveAt
      ? { deletionEffectiveAt: account.deletionEffectiveAt }
      : {}),
    identities: account.identities.map((identity) => ({
      provider: identity.provider,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.emailVerified ? { emailVerified: true } : {}),
      linkedBy: identity.linkedBy,
      linkedAt: identity.linkedAt,
    })),
  };
}

export function billingOnlyAdminAccount(
  accountId: string,
  overview: AdminBillingOverview,
) {
  const exists =
    overview.accounts.some((account) => account.accountId === accountId) ||
    overview.orders.some((order) => order.accountId === accountId) ||
    overview.ledger.some((entry) => entry.accountId === accountId);
  if (!exists) return undefined;
  const activityDates = [
    ...overview.orders
      .filter((order) => order.accountId === accountId)
      .map((order) => order.createdAt),
    ...overview.ledger
      .filter((entry) => entry.accountId === accountId)
      .map((entry) => entry.occurredAt),
  ].sort();
  return {
    accountId,
    status: "billing_only",
    createdAt: activityDates[0] ?? overview.generatedAt,
    identities: [],
  };
}

async function secureTokenEqual(actual: string, expected: string) {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

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
    return await observeWorkerRequest(request, async () => {
      const environmentError = runtimeEnvironmentError(env, "staging");
      if (environmentError) {
        return Response.json(
          { status: "unavailable", error: environmentError },
          { status: 503 },
        );
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", environment: "staging" });
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        try {
          await getCloudflareDb(env);
          return Response.json({ status: "ready", environment: "staging" });
        } catch (error) {
          console.error({
            event: "waffo_staging.readiness_failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorCode: typeof error === "object" && error !== null &&
                "code" in error
              ? String(error.code)
              : undefined,
          });
          ctx.waitUntil(alertStaging(env, {
            severity: "critical",
            event: "waffo_staging.readiness_failed",
            summary: "Together staging readiness could not reach its database.",
            fields: {
              errorName: error instanceof Error ? error.name : "UnknownError",
            },
          }));
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
      const isSharedHostingPreflight = request.method === "OPTIONS" &&
        url.pathname.startsWith("/v1/shared-hosting/");
      const isPlusRead = request.method === "GET" &&
        plusReadPaths.has(url.pathname);
      const isPlusMutation = request.method === "POST" &&
        (url.pathname === "/v1/xmcl-plus/subscribe" ||
          url.pathname === "/v1/xmcl-plus/cancel");
      const isPlusPreflight = request.method === "OPTIONS" &&
        url.pathname.startsWith("/v1/xmcl-plus/");
      const isAccountSurface = isStagingAccountRequest(
        request.method,
        url.pathname,
      );
      const isAdminSurface = isStagingAdminRequest(
        request.method,
        url.pathname,
      );
      const isUsageSurface = isStagingUsageRequest(
        request.method,
        url.pathname,
      );
      const isWebhook = request.method === "POST" &&
        url.pathname === webhookPath;
      const isSharedNodeTransport = url.pathname.startsWith(
        "/v1/internal/shared-nodes/",
      );
      if (
        !isBillingRead && !isBillingMutation && !isBillingPreflight &&
        !isSharedHostingRead && !isSharedHostingPreflight &&
        !isPlusRead && !isPlusMutation &&
        !isPlusPreflight && !isAccountSurface && !isAdminSurface &&
        !isUsageSurface && !isWebhook && !isSharedNodeTransport
      ) {
        return new Response("Not Found", { status: 404 });
      }
      let response: Response;
      try {
        response = await app.fetch(request, env, ctx);
      } catch (error) {
        if (isWebhook) {
          ctx.waitUntil(alertStaging(env, {
            severity: "critical",
            event: "waffo_staging.webhook_failed",
            summary: "A Waffo webhook request failed before it could be reconciled.",
            fields: {
              status: 500,
              cfRay: request.headers.get("cf-ray") ?? "unavailable",
            },
          }));
        }
        throw error;
      }
      if (isWebhook && response.status >= 500) {
        ctx.waitUntil(alertStaging(env, {
          severity: "critical",
          event: "waffo_staging.webhook_failed",
          summary: "A Waffo webhook request failed before it could be reconciled.",
          fields: {
            status: response.status,
            cfRay: request.headers.get("cf-ray") ?? "unavailable",
          },
        }));
      }
      return response;
    });
  },

  scheduled(
    controller: ScheduledController,
    env: StagingBindings,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      (async () => {
        const environmentError = runtimeEnvironmentError(env, "staging");
        if (environmentError) {
          await alertStaging(env, {
            severity: "critical",
            event: "waffo_staging.environment_invalid",
            summary: "Together staging failed its deployment isolation guard.",
            fields: { reason: environmentError },
          });
          throw new Error(environmentError);
        }
        const scheduledAt = new Date(controller.scheduledTime);
        try {
          const aiResult = await new AllowanceMeter(
            new MongoBillingStore(await getCloudflareDb(env)),
            () => scheduledAt,
          ).settlePendingAi();
          console.log({
            event: "ai.staging_settlement.completed",
            scheduledAt: scheduledAt.toISOString(),
            settledCount: aiResult.settled.length,
            failedCount: aiResult.failed.length,
          });
          if (aiResult.failed.length > 0) {
            console.warn({
              event: "ai.staging_settlement.pending",
              scheduledAt: scheduledAt.toISOString(),
              failedCount: aiResult.failed.length,
            });
            await alertStaging(env, {
              severity: "warning",
              event: "ai.staging_settlement.pending",
              summary: "AI usage settlement is still pending after a scheduled retry.",
              occurredAt: scheduledAt.toISOString(),
              fields: { failedCount: aiResult.failed.length },
            });
          }
        } catch (error) {
          console.error({
            event: "ai.staging_settlement.failed",
            scheduledAt: scheduledAt.toISOString(),
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          await alertStaging(env, {
            severity: "critical",
            event: "ai.staging_settlement.failed",
            summary: "The scheduled AI usage settlement sweep failed.",
            occurredAt: scheduledAt.toISOString(),
            fields: {
              errorName: error instanceof Error ? error.name : "UnknownError",
            },
          });
          throw error;
        }
        try {
          const result = await new XmclPlusService(
            new MongoBillingStore(await getCloudflareDb(env)),
            { currency: env.BILLING_CURRENCY ?? "USD" },
          ).renewDue(scheduledAt);
          console.log({
            event: "xmcl_plus.staging_renewal.completed",
            scheduledAt: scheduledAt.toISOString(),
            ...result,
          });
          if (result.paymentDue.length > 0) {
            console.warn({
              event: "xmcl_plus.staging_renewal.payment_due",
              scheduledAt: scheduledAt.toISOString(),
              subscriptionIds: result.paymentDue,
            });
          }
        } catch (error) {
          console.error({
            event: "xmcl_plus.staging_renewal.failed",
            scheduledAt: scheduledAt.toISOString(),
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          await alertStaging(env, {
            severity: "critical",
            event: "xmcl_plus.staging_renewal.failed",
            summary: "The scheduled Together Home renewal sweep failed.",
            occurredAt: scheduledAt.toISOString(),
            fields: {
              errorName: error instanceof Error ? error.name : "UnknownError",
            },
          });
          throw error;
        }
        const analyticsToken = env.CLOUDFLARE_TURN_ANALYTICS_API_TOKEN ??
          env.CLOUDFLARE_ANALYTICS_API_TOKEN;
        if (env.CLOUDFLARE_ACCOUNT_ID && analyticsToken) {
          try {
            const turnResult = await runTurnMeteringSweep(
              new TurnCredentialMeter(
                new MongoBillingStore(await getCloudflareDb(env)),
              ),
              {
                accountId: env.CLOUDFLARE_ACCOUNT_ID,
                apiToken: analyticsToken,
              },
              scheduledAt,
            );
            console.log({
              event: "turn.staging_metering.completed",
              scheduledAt: scheduledAt.toISOString(),
              ...turnResult,
            });
          } catch (error) {
            console.error({
              event: "turn.staging_metering.failed",
              scheduledAt: scheduledAt.toISOString(),
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
            await alertStaging(env, {
              severity: "critical",
              event: "turn.staging_metering.failed",
              summary: "The scheduled TURN Analytics settlement sweep failed.",
              occurredAt: scheduledAt.toISOString(),
              fields: {
                errorName: error instanceof Error ? error.name : "UnknownError",
              },
            });
            throw error;
          }
        } else {
          console.warn({ event: "turn.staging_metering.not_configured" });
          await alertStaging(env, {
            severity: "critical",
            event: "turn.staging_metering.not_configured",
            summary: "TURN metering configuration is incomplete.",
            occurredAt: scheduledAt.toISOString(),
          });
        }
      })(),
    );
  },
};

export function isStagingAccountRequest(method: string, path: string) {
  const isAuthRoute =
    (method === "GET" && /^\/v1\/auth\/[^/]+\/authorize$/.test(path)) ||
    (method === "POST" &&
      /^\/v1\/auth\/[^/]+\/(?:exchange|launcher-exchange)$/.test(path));
  const isSessionRoute = method === "POST" &&
    (path === "/v1/sessions/refresh" || path === "/v1/sessions/revoke");
  const isAccountRoute = (method === "GET" &&
    (path === "/v1/account" || path === "/v1/account/identities")) ||
    (method === "POST" &&
      (/^\/v1\/account\/identities\/[^/]+\/(?:authorize|complete)$/.test(
        path,
      ) ||
        path === "/v1/account/merge/prepare" ||
        path === "/v1/account/merge/confirm" ||
        path === "/v1/account/deletion" ||
        path === "/v1/account/deletion/cancel")) ||
    (method === "DELETE" &&
      /^\/v1\/account\/identities\/[^/]+$/.test(path));
  const isPreflight = method === "OPTIONS" &&
    (path.startsWith("/v1/auth/") ||
      path.startsWith("/v1/sessions/") ||
      path === "/v1/account" ||
      path.startsWith("/v1/account/"));
  return isAuthRoute || isSessionRoute || isAccountRoute || isPreflight;
}

export function isStagingAdminRequest(method: string, path: string) {
  if (method === "OPTIONS" && path.startsWith("/v1/admin/")) return true;
  if (method === "POST" && path === "/v1/admin/session") return true;
  return method === "GET" &&
    (adminReadPaths.has(path) ||
      path === "/v1/admin/accounts" ||
      /^\/v1\/admin\/accounts\/[^/]+$/.test(path));
}

export function isStagingUsageRequest(method: string, path: string) {
  return (method === "POST" &&
    (path === "/v1/chat/completions" || path === "/v1/rtc/official")) ||
    (method === "OPTIONS" &&
      (path.startsWith("/v1/chat/") || path.startsWith("/v1/rtc/")));
}
