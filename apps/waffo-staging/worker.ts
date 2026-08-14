import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { getCloudflareDb } from "../../src/cloudflare/runtime.ts";
import type {
  ExecutionContext,
} from "../../src/cloudflare/types.ts";
import type { AppConfig } from "../../src/config.ts";
import { createDbMiddleware } from "../../src/middleware/db.ts";
import { getBillingRuntime } from "../../src/billingRuntime.ts";
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
import operations from "../../src/routes/operations.ts";
import { authenticateXmclRequest } from "../../src/middleware/xmclAuth.ts";
import type { Account } from "../../src/account.ts";
import type { AdminBillingOverview } from "../../src/billing.ts";
import type {
  AdminPrincipal,
  AdminPrincipalAuthenticator,
} from "../../src/operations.ts";
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
const adminReadPaths = new Set([
  "/v1/admin/audit-events",
  "/v1/admin/billing/overview",
  "/v1/admin/reconciliation",
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
app.post("/v1/admin/session", async (c) => {
  const config = c.env as StagingBindings;
  if (
    !config.XMCL_STAGING_ADMIN_ACCESS_TOKEN ||
    !config.XMCL_STAGING_ADMIN_EMAILS
  ) {
    return c.json({ error: "admin_auth_unavailable" }, 503);
  }
  try {
    const principal = await authenticateXmclRequest(c);
    const account = await (await getAccountRuntime(c)).accounts.requireAccount(
      principal!.accountId,
    );
    const allowedEmails = new Set(
      config.XMCL_STAGING_ADMIN_EMAILS.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const email = account.identities
      .map((identity) => identity.email?.toLowerCase())
      .find((value): value is string => !!value && allowedEmails.has(value));
    if (!email) return c.json({ error: "admin_forbidden" }, 403);
    return c.json(
      await issueStagingAdminSession(
        config.XMCL_STAGING_ADMIN_ACCESS_TOKEN,
        account.accountId,
      ),
    );
  } catch {
    return c.json({ error: "admin_authentication_required" }, 401);
  }
});
app.route("/", operations);

export function stagingAdminAuthenticator(
  expectedToken: string | undefined,
): AdminPrincipalAuthenticator | undefined {
  if (!expectedToken) return undefined;
  return {
    async authenticate(authorization) {
      const actualToken = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!actualToken) return undefined;
      if (await secureTokenEqual(actualToken, expectedToken)) {
        return {
          id: "staging-billing-operator",
          scopes: ["billing_operator"],
          mfaVerifiedAt: new Date().toISOString(),
        };
      }
      return await verifyStagingAdminSession(expectedToken, actualToken);
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
    version: 1,
    accountId,
    mfaVerifiedAt: now.toISOString(),
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
    if (
      claims.version !== 1 ||
      typeof claims.accountId !== "string" ||
      typeof claims.mfaVerifiedAt !== "string" ||
      typeof claims.expiresAt !== "string" ||
      Date.parse(claims.expiresAt) <= Date.now()
    ) return undefined;
    return {
      id: claims.accountId,
      scopes: ["admin"],
      mfaVerifiedAt: claims.mfaVerifiedAt,
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
    mfaVerifiedAt?: unknown;
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
      !isWebhook && !isSharedNodeTransport
    ) {
      return new Response("Not Found", { status: 404 });
    }
    return app.fetch(request, env, ctx);
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
