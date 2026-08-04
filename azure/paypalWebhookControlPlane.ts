import type { Hono } from "hono";
import { AccountError } from "../src/lib/account.ts";
import { createBillingRuntime } from "../src/lib/billingRuntime.ts";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import {
  HmacPayPalWebhookProxyIdentity,
  MongoPayPalWebhookProxyNonceStore,
} from "../src/lib/paypalWebhookProxyIdentity.ts";
import {
  PayPalHttpWebhookVerifier,
  type PayPalOrderProvider,
  PayPalService,
} from "../src/lib/paypal.ts";
import {
  decodePayPalWebhookBody,
  PayPalWebhookBodyTooLargeError,
  readPayPalWebhookRawBody,
} from "../src/lib/paypalWebhook.ts";
import type { AppEnv } from "../src/types.ts";

export const PAYPAL_WEBHOOK_AZURE_TARGET = "/api/v1/webhooks/paypal";
export const PAYPAL_WEBHOOK_ROUTE = "/v1/webhooks/paypal";

interface PayPalWebhookControlPlaneSettings {
  keyId: string;
  secret: string;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  apiBaseUrl: string;
}

export interface AzurePayPalWebhookControlPlaneDependencies {
  now?: () => number;
  createPayPalService?: (
    db: Db,
    config: AppConfig,
  ) => Pick<PayPalService, "receiveWebhook">;
}

/**
 * Azure-only, Worker-authenticated endpoint for PayPal Sandbox deliveries.
 * It deliberately owns no public order, capture, balance, or ledger routes.
 */
export class AzurePayPalWebhookControlPlane {
  constructor(
    private readonly settings: PayPalWebhookControlPlaneSettings,
    private readonly config: AppConfig,
    private readonly dependencies: AzurePayPalWebhookControlPlaneDependencies,
  ) {}

  register(app: Hono<AppEnv>) {
    app.post(PAYPAL_WEBHOOK_ROUTE, async (c) => {
      let raw: Uint8Array;
      try {
        raw = await readPayPalWebhookRawBody(c.req.raw);
      } catch (error) {
        if (error instanceof PayPalWebhookBodyTooLargeError) {
          return c.json({ error: "payload_too_large" }, 413);
        }
        return c.json({ error: "invalid_webhook_payload" }, 422);
      }

      // `azure/index.ts` preserves the unmodified public Azure `/api` target
      // before stripping it for shared Hono route matching.
      if (
        c.req.header("x-xmcl-original-target") !== PAYPAL_WEBHOOK_AZURE_TARGET
      ) {
        return c.json({ error: "unauthorized" }, 401);
      }

      const getDb = c.get("getDb");
      if (!getDb) return c.json({ error: "paypal_webhook_unavailable" }, 503);
      let db: Db;
      try {
        db = await getDb();
      } catch {
        return c.json({ error: "paypal_webhook_unavailable" }, 503);
      }

      const identity = new HmacPayPalWebhookProxyIdentity({
        keyId: this.settings.keyId,
        secret: this.settings.secret,
        nonceStore: new MongoPayPalWebhookProxyNonceStore(db),
        now: this.dependencies.now,
      });
      try {
        await identity.verifyIncoming({
          method: c.req.method,
          target: PAYPAL_WEBHOOK_AZURE_TARGET,
          headers: c.req.raw.headers,
          body: raw,
        });
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }

      let rawBody: string;
      try {
        rawBody = decodePayPalWebhookBody(raw);
      } catch {
        return c.json({ error: "invalid_webhook_payload" }, 422);
      }

      try {
        const paypal = (this.dependencies.createPayPalService ??
          createPayPalWebhookService)(db, this.config);
        const result = await paypal.receiveWebhook(
          rawBody,
          requestHeaders(c.req.raw.headers),
        );
        return c.json(result, 202);
      } catch (error) {
        if (error instanceof AccountError) {
          return c.json({ error: error.code }, error.status);
        }
        return c.json({ error: "paypal_webhook_unavailable" }, 503);
      }
    });
  }
}

export function createAzurePayPalWebhookControlPlane(
  config: AppConfig,
  dependencies: AzurePayPalWebhookControlPlaneDependencies = {},
) {
  const settings = paypalWebhookControlPlaneSettings(config);
  return settings
    ? new AzurePayPalWebhookControlPlane(settings, config, dependencies)
    : undefined;
}

export function paypalWebhookControlPlaneSettings(
  config: AppConfig,
): PayPalWebhookControlPlaneSettings | undefined {
  if (
    !hasText(config.MONGO_CONNECION_STRING) ||
    !validBillingRates(config.BILLING_RATES_JSON) ||
    !hasText(config.PAYPAL_CLIENT_ID) ||
    !hasText(config.PAYPAL_CLIENT_SECRET) ||
    !hasText(config.PAYPAL_WEBHOOK_ID) ||
    !sandboxPayPalApiBase(config.PAYPAL_API_BASE_URL) ||
    !validKeyId(config.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID) ||
    !hasHmacSecret(config.XMCL_PAYPAL_WEBHOOK_PROXY_SECRET)
  ) {
    return undefined;
  }
  return {
    keyId: config.XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID,
    secret: config.XMCL_PAYPAL_WEBHOOK_PROXY_SECRET,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    webhookId: config.PAYPAL_WEBHOOK_ID,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
  };
}

function createPayPalWebhookService(
  db: Db,
  config: AppConfig,
): Pick<PayPalService, "receiveWebhook"> {
  const billing = createBillingRuntime(db, config).billing;
  const options = {
    clientId: config.PAYPAL_CLIENT_ID!,
    clientSecret: config.PAYPAL_CLIENT_SECRET!,
    webhookId: config.PAYPAL_WEBHOOK_ID!,
    apiBaseUrl: config.PAYPAL_API_BASE_URL!,
  };
  return new PayPalService(
    billing,
    disabledPayPalOrderProvider,
    new PayPalHttpWebhookVerifier(options),
  );
}

const disabledPayPalOrderProvider: PayPalOrderProvider = {
  async createOrder() {
    throw new AccountError(503, "paypal_orders_disabled");
  },
  async captureOrder() {
    throw new AccountError(503, "paypal_orders_disabled");
  },
};

function requestHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validBillingRates(value: string | undefined) {
  if (!hasText(value)) return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function validKeyId(value: string | undefined): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function hasHmacSecret(value: string | undefined): value is string {
  return typeof value === "string" &&
    new TextEncoder().encode(value).byteLength >= 32;
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
