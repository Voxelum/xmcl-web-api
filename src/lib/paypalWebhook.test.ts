import assert from "node:assert/strict";
import {
  MAXIMUM_PAYPAL_WEBHOOK_BYTES,
  PayPalWebhookBodyTooLargeError,
  readPayPalWebhookRawBody,
} from "./paypalWebhook.ts";

Deno.test("PayPal webhook reader rejects oversized streams before buffering them all", async () => {
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      emitted++;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (emitted === 6) controller.close();
    },
  });
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    body: stream as unknown as BodyInit,
  });

  await assert.rejects(
    () => readPayPalWebhookRawBody(request),
    PayPalWebhookBodyTooLargeError,
  );
  assert.equal(emitted, Math.floor(MAXIMUM_PAYPAL_WEBHOOK_BYTES / (1024 * 1024)) + 1);
});
