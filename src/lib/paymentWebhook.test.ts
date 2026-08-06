import assert from "node:assert/strict";
import {
  MAXIMUM_PAYMENT_WEBHOOK_BYTES,
  PaymentWebhookBodyTooLargeError,
  readPaymentWebhookRawBody,
} from "./paymentWebhook.ts";

Deno.test("payment webhook reader rejects oversized bodies", async () => {
  const declared = new Request("https://api.example/webhook", {
    method: "POST",
    headers: {
      "content-length": String(MAXIMUM_PAYMENT_WEBHOOK_BYTES + 1),
    },
    body: "small",
  });
  await assert.rejects(
    () => readPaymentWebhookRawBody(declared),
    PaymentWebhookBodyTooLargeError,
  );

  const streamed = new Request("https://api.example/webhook", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new Uint8Array(MAXIMUM_PAYMENT_WEBHOOK_BYTES + 1),
        );
        controller.close();
      },
    }),
  });
  await assert.rejects(
    () => readPaymentWebhookRawBody(streamed),
    PaymentWebhookBodyTooLargeError,
  );
});
