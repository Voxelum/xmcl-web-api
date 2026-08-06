import {
  TaxCategory,
  WaffoPancake,
  WaffoPancakeError,
  type WebhookEvent,
  type WebhookEventData,
  WebhookEventType,
} from "@waffo/pancake-ts";
import { AccountError } from "./account.ts";
import type {
  BillingService,
  ProviderReconciliationResult,
  PublicOrder,
} from "./billing.ts";
import type { Money } from "./ledger.ts";

export interface WaffoCheckoutProvider {
  createCheckout(input: {
    orderId: string;
    amount: Money;
  }): Promise<{ providerOrderId: string; approvalUrl: string }>;
}

export interface WaffoWebhookVerifier {
  verify(input: {
    rawBody: string;
    signature?: string;
  }): WebhookEvent<WebhookEventData>;
}

export interface WaffoSdkOptions {
  merchantId: string;
  privateKey: string;
  storeId: string;
  productId: string;
  environment: "test" | "prod";
  successUrl?: string;
  apiBaseUrl?: string;
  webhookPublicKey?: string;
  fetchImpl?: typeof fetch;
}

function displayAmount(amountMinor: number) {
  return `${Math.floor(amountMinor / 100)}.${
    String(amountMinor % 100).padStart(2, "0")
  }`;
}

function paymentAmount(currency: unknown, amount: unknown): Money {
  if (
    typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) ||
    typeof amount !== "string"
  ) {
    throw new AccountError(422, "invalid_webhook_payload");
  }
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(amount);
  if (!match) throw new AccountError(422, "invalid_webhook_payload");
  const amountMinor = Number(match[1]) * 100 +
    Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new AccountError(422, "invalid_webhook_payload");
  }
  return { currency, amountMinor };
}

export class WaffoSdkProvider
  implements WaffoCheckoutProvider, WaffoWebhookVerifier {
  private readonly client: WaffoPancake;

  constructor(private readonly options: WaffoSdkOptions) {
    if (
      !options.merchantId || !options.privateKey || !options.storeId ||
      !options.productId
    ) {
      throw new Error("Complete Waffo provider settings are required");
    }
    this.client = new WaffoPancake({
      merchantId: options.merchantId,
      privateKey: options.privateKey,
      ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
      ...(options.webhookPublicKey
        ? { webhookPublicKey: options.webhookPublicKey }
        : {}),
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  async createCheckout(input: { orderId: string; amount: Money }) {
    try {
      const session = await this.client.checkout.createSession({
        productId: this.options.productId,
        currency: input.amount.currency,
        priceSnapshot: {
          amount: displayAmount(input.amount.amountMinor),
          taxCategory: TaxCategory.SaaS,
        },
        orderMerchantExternalId: input.orderId,
        metadata: { xmclOrderId: input.orderId },
        ...(this.options.successUrl
          ? { successUrl: this.options.successUrl }
          : {}),
      });
      return {
        providerOrderId: session.sessionId,
        approvalUrl: session.checkoutUrl,
      };
    } catch (error) {
      if (error instanceof WaffoPancakeError || error instanceof TypeError) {
        throw new AccountError(503, "waffo_provider_unavailable");
      }
      throw error;
    }
  }

  verify(input: { rawBody: string; signature?: string }) {
    return this.client.webhooks.verify<WebhookEventData>(
      input.rawBody,
      input.signature,
      { environment: this.options.environment },
    );
  }
}

export interface WaffoWebhookResult {
  accepted: true;
  duplicate: boolean;
}

export class WaffoService {
  constructor(
    private readonly billing: BillingService,
    private readonly provider: WaffoCheckoutProvider,
    private readonly verifier: WaffoWebhookVerifier,
    private readonly expected: {
      storeId: string;
      environment: "test" | "prod";
    },
  ) {}

  async createOrder(input: {
    accountId: string;
    idempotencyKey: string;
    amountMinor: number;
  }): Promise<PublicOrder> {
    return await this.billing.createOrder({
      ...input,
      provider: "waffo",
      createProviderOrder: (orderId, amount) =>
        this.provider.createCheckout({ orderId, amount }),
    });
  }

  async reconcilePendingOrders(at: Date, limit?: number) {
    const candidates = await this.billing.stalePendingProviderOrders(
      "waffo",
      at,
      limit,
    );
    const result = {
      attempted: [] as string[],
      finalized: [] as string[],
      stillPending: [] as string[],
      failed: [] as string[],
    };
    for (const candidate of candidates) {
      const outcome: ProviderReconciliationResult = await this.billing
        .reconcilePendingProviderOrder(
          candidate.orderId,
          "waffo",
          (orderId, amount) =>
            this.provider.createCheckout({ orderId, amount }),
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

  async receiveWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WaffoWebhookResult> {
    let event: WebhookEvent<WebhookEventData>;
    try {
      event = this.verifier.verify({
        rawBody,
        signature: headers["x-waffo-signature"],
      });
    } catch {
      throw new AccountError(
        401,
        "invalid_webhook_signature",
        "The Waffo webhook signature could not be verified.",
      );
    }
    if (
      !event.id || event.storeId !== this.expected.storeId ||
      event.mode !== this.expected.environment
    ) {
      throw new AccountError(422, "invalid_webhook_payload");
    }
    if (event.eventType !== WebhookEventType.OrderCompleted) {
      return {
        accepted: true,
        duplicate: await this.billing.markWebhookDuplicate(event.id, rawBody),
      };
    }
    if (
      !event.data?.orderMerchantExternalId ||
      event.data.paymentStatus !== "succeeded"
    ) {
      throw new AccountError(422, "invalid_webhook_payload");
    }
    const result = await this.billing.recordWaffoCredit(
      event.data.orderMerchantExternalId,
      event.id,
      rawBody,
      paymentAmount(
        event.data.currency,
        event.data.subtotal ?? event.data.amount,
      ),
    );
    return { accepted: true, duplicate: result.duplicate };
  }
}

export class FakeWaffoProvider implements WaffoCheckoutProvider {
  readonly createCalls: Array<{ orderId: string; amount: Money }> = [];
  private failedOnce = false;

  constructor(
    private readonly options: {
      failCreate?: boolean;
      failCreateOnce?: boolean;
    } = {},
  ) {}

  async createCheckout(input: { orderId: string; amount: Money }) {
    this.createCalls.push(structuredClone(input));
    if (
      this.options.failCreate ||
      (this.options.failCreateOnce && !this.failedOnce)
    ) {
      this.failedOnce = true;
      throw new AccountError(503, "waffo_provider_unavailable");
    }
    return {
      providerOrderId: `cs_${input.orderId}`,
      approvalUrl: `https://checkout.waffo.invalid/${input.orderId}`,
    };
  }
}

export class FakeWaffoWebhookVerifier implements WaffoWebhookVerifier {
  readonly verifiedInputs: Array<{ rawBody: string; signature?: string }> = [];

  constructor(
    private readonly resolve: (
      input: { rawBody: string; signature?: string },
    ) => WebhookEvent<WebhookEventData> = ({ rawBody }) =>
      JSON.parse(rawBody) as WebhookEvent<WebhookEventData>,
  ) {}

  verify(input: { rawBody: string; signature?: string }) {
    this.verifiedInputs.push(structuredClone(input));
    return this.resolve(input);
  }
}
