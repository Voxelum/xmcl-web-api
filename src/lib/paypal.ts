import { AccountError } from "./account.ts";
import type { BillingService, PublicOrder } from "./billing.ts";
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

  async captureOrder(accountId: string, orderId: string): Promise<PublicOrder> {
    const order = await this.billing.orderForAccount(accountId, orderId);
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
      updatedAt: order.createdAt,
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
