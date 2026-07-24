import { AccountError } from "./account.ts";
import type {
  BillingService,
  PayPalReconciliationResult,
  PublicOrder,
} from "./billing.ts";
import type { Money } from "./ledger.ts";

export interface PayPalOrderProvider {
  createOrder(input: {
    orderId: string;
    accountId: string;
    amount: Money;
  }): Promise<{ providerOrderId: string; approvalUrl: string }>;
  captureOrder(input: {
    providerOrderId: string;
  }): Promise<{ captureId: string; status: "pending" | "completed" }>;
}

export interface PayPalWebhookVerifier {
  verify(input: {
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<boolean>;
}

export interface PayPalHttpProviderOptions {
  clientId: string;
  clientSecret: string;
  returnUrl?: string;
  cancelUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function responseJson(
  response: Response,
  errorCode: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) throw new AccountError(503, errorCode);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AccountError(503, "paypal_invalid_response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccountError(503, "paypal_invalid_response");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value) {
    throw new AccountError(503, code);
  }
  return value;
}

export class PayPalHttpProvider implements PayPalOrderProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PayPalHttpProviderOptions) {
    if (
      !options.clientId || !options.clientSecret || !options.returnUrl ||
      !options.cancelUrl
    ) {
      throw new Error(
        "PayPal provider credentials and redirect URLs are required",
      );
    }
    this.baseUrl = (options.apiBaseUrl ?? "https://api-m.paypal.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createOrder(input: {
    orderId: string;
    accountId: string;
    amount: Money;
  }) {
    const token = await this.accessToken();
    const response = await this.fetchImpl(
      `${this.baseUrl}/v2/checkout/orders`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          prefer: "return=representation",
          "paypal-request-id": input.orderId,
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: input.orderId,
            amount: {
              currency_code: input.amount.currency,
              value: (input.amount.amountMinor / 100).toFixed(2),
            },
          }],
          application_context: {
            return_url: this.options.returnUrl!,
            cancel_url: this.options.cancelUrl!,
            user_action: "PAY_NOW",
          },
        }),
      },
    );
    const value = await responseJson(response, "paypal_order_create_failed");
    const links = Array.isArray(value.links) ? value.links : [];
    const approval = links.find((link) =>
      link && typeof link === "object" &&
      ["approve", "payer-action"].includes(
        String((link as { rel?: unknown }).rel ?? ""),
      )
    );
    return {
      providerOrderId: requiredString(value.id, "paypal_invalid_response"),
      approvalUrl: requiredString(
        approval && typeof approval === "object"
          ? (approval as { href?: unknown }).href
          : undefined,
        "paypal_invalid_response",
      ),
    };
  }

  async captureOrder(input: { providerOrderId: string }) {
    const token = await this.accessToken();
    const response = await this.fetchImpl(
      `${this.baseUrl}/v2/checkout/orders/${
        encodeURIComponent(input.providerOrderId)
      }/capture`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: "{}",
      },
    );
    const value = await responseJson(response, "paypal_capture_failed");
    return {
      captureId: requiredString(value.id, "paypal_invalid_response"),
      status: value.status === "COMPLETED"
        ? "completed" as const
        : "pending" as const,
    };
  }

  private async accessToken() {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${
          btoa(
            `${this.options.clientId}:${this.options.clientSecret}`,
          )
        }`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "accept-language": "en_US",
      },
      body: "grant_type=client_credentials",
    });
    const value = await responseJson(response, "paypal_authentication_failed");
    return requiredString(value.access_token, "paypal_authentication_failed");
  }
}

export class PayPalHttpWebhookVerifier implements PayPalWebhookVerifier {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: PayPalHttpProviderOptions & { webhookId: string },
  ) {
    if (!options.webhookId) throw new Error("PayPal webhook ID is required");
    this.baseUrl = (options.apiBaseUrl ?? "https://api-m.paypal.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verify(input: {
    rawBody: string;
    headers: Record<string, string>;
  }) {
    const requiredHeaders = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    if (requiredHeaders.some((name) => !input.headers[name])) return false;
    let webhookEvent: unknown;
    try {
      webhookEvent = JSON.parse(input.rawBody);
    } catch {
      return false;
    }
    const token = await this.accessToken();
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: input.headers["paypal-auth-algo"],
          cert_url: input.headers["paypal-cert-url"],
          transmission_id: input.headers["paypal-transmission-id"],
          transmission_sig: input.headers["paypal-transmission-sig"],
          transmission_time: input.headers["paypal-transmission-time"],
          webhook_id: this.options.webhookId,
          webhook_event: webhookEvent,
        }),
      },
    );
    if (!response.ok) return false;
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return false;
    }
    return value !== null && typeof value === "object" &&
      (value as { verification_status?: unknown }).verification_status ===
        "SUCCESS";
  }

  private async accessToken() {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${
          btoa(
            `${this.options.clientId}:${this.options.clientSecret}`,
          )
        }`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const value = await responseJson(response, "paypal_authentication_failed");
    return requiredString(value.access_token, "paypal_authentication_failed");
  }
}

export interface PayPalWebhookResult {
  accepted: true;
  duplicate: boolean;
}

export class FakePayPalProvider implements PayPalOrderProvider {
  readonly createCalls: Array<
    { orderId: string; accountId: string; amount: Money }
  > = [];
  readonly captureCalls: string[] = [];
  private createFailures = 0;

  constructor(
    private readonly options: {
      failCreate?: boolean;
      failCreateOnce?: boolean;
      failCapture?: boolean;
    } = {},
  ) {}

  async createOrder(input: {
    orderId: string;
    accountId: string;
    amount: Money;
  }) {
    this.createCalls.push(structuredClone(input));
    if (
      this.options.failCreate ||
      (this.options.failCreateOnce && this.createFailures++ === 0)
    ) {
      throw new AccountError(503, "paypal_provider_unavailable");
    }
    return {
      providerOrderId: `paypal_${input.orderId}`,
      approvalUrl: `https://paypal.invalid/checkout/${input.orderId}`,
    };
  }

  async captureOrder(input: { providerOrderId: string }) {
    this.captureCalls.push(input.providerOrderId);
    if (this.options.failCapture) {
      throw new AccountError(503, "paypal_provider_unavailable");
    }
    return {
      captureId: `capture_${input.providerOrderId}`,
      status: "pending" as const,
    };
  }
}

/**
 * Test-only verifier. Its input deliberately has no parsed event, ensuring
 * callers cannot accidentally normalize raw webhook bytes before verification.
 */
export class FakePayPalWebhookVerifier implements PayPalWebhookVerifier {
  readonly verifiedRawBodies: string[] = [];

  constructor(
    private readonly accepts: (input: {
      rawBody: string;
      headers: Record<string, string>;
    }) => boolean = () => true,
  ) {}

  async verify(input: { rawBody: string; headers: Record<string, string> }) {
    this.verifiedRawBodies.push(input.rawBody);
    return this.accepts(input);
  }
}

export class PayPalService {
  constructor(
    private readonly billing: BillingService,
    private readonly provider: PayPalOrderProvider,
    private readonly verifier: PayPalWebhookVerifier,
  ) {}

  async createOrder(input: {
    accountId: string;
    idempotencyKey: string;
    amountMinor: number;
  }): Promise<PublicOrder> {
    return await this.billing.createOrder({
      ...input,
      createProviderOrder: (orderId, amount) =>
        this.provider.createOrder({
          orderId,
          accountId: input.accountId,
          amount,
        }),
    });
  }

  /**
   * Trusted scheduled recovery for locally persisted PayPal intents. No raw
   * PayPal response is retained or logged; only the durable order fields are
   * conditionally finalized by BillingService.
   */
  async reconcilePendingOrders(
    at: Date,
    limit?: number,
  ): Promise<{
    attempted: string[];
    finalized: string[];
    stillPending: string[];
    failed: string[];
  }> {
    const candidates = await this.billing.stalePendingPayPalOrders(at, limit);
    const result = {
      attempted: [] as string[],
      finalized: [] as string[],
      stillPending: [] as string[],
      failed: [] as string[],
    };
    for (const candidate of candidates) {
      const outcome: PayPalReconciliationResult = await this.billing
        .reconcilePendingPayPalOrder(
          candidate.orderId,
          (orderId, amount) =>
            this.provider.createOrder({
              orderId,
              accountId: candidate.accountId,
              amount,
            }),
        );
      if (outcome.attempted) result.attempted.push(outcome.orderId);
      if (outcome.outcome === "finalized") {
        result.finalized.push(outcome.orderId);
      }
      if (outcome.outcome === "still_pending") {
        result.stillPending.push(outcome.orderId);
      }
      if (outcome.outcome === "failed") result.failed.push(outcome.orderId);
    }
    return result;
  }

  async captureOrder(accountId: string, orderId: string): Promise<PublicOrder> {
    const order = await this.billing.orderForAccount(accountId, orderId);
    if (!order.providerOrderId) {
      throw new AccountError(409, "order_provider_pending");
    }
    await this.provider.captureOrder({
      providerOrderId: order.providerOrderId,
    });
    // PayPal capture is never a credit signal. A verified webhook owns crediting.
    return {
      orderId: order.orderId,
      cashAmount: order.amount,
      approvalUrl: order.approvalUrl,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt ?? order.createdAt,
    };
  }

  async receiveWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<PayPalWebhookResult> {
    if (!await this.verifier.verify({ rawBody, headers })) {
      throw new AccountError(
        401,
        "invalid_webhook_signature",
        "The PayPal webhook signature could not be verified.",
      );
    }
    let event: {
      id?: unknown;
      event_type?: unknown;
      resource?: {
        supplementary_data?: { related_ids?: { order_id?: unknown } };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new AccountError(422, "invalid_webhook_payload");
    }
    if (typeof event.id !== "string" || !event.id) {
      throw new AccountError(422, "invalid_webhook_payload");
    }
    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
      return {
        accepted: true,
        duplicate: await this.billing.markWebhookDuplicate(event.id, rawBody),
      };
    }
    const providerOrderId = event.resource?.supplementary_data?.related_ids
      ?.order_id;
    if (typeof providerOrderId !== "string" || !providerOrderId) {
      throw new AccountError(422, "invalid_webhook_payload");
    }
    const result = await this.billing.recordPaypalCredit(
      providerOrderId,
      event.id,
      rawBody,
    );
    return { accepted: true, duplicate: result.duplicate };
  }
}
