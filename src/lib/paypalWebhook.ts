export const MAXIMUM_PAYPAL_WEBHOOK_BYTES = 4 * 1024 * 1024;

export class PayPalWebhookBodyTooLargeError extends Error {
  constructor() {
    super("PayPal webhook body exceeds the maximum size");
    this.name = "PayPalWebhookBodyTooLargeError";
  }
}

export async function readPayPalWebhookRawBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength && /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > MAXIMUM_PAYPAL_WEBHOOK_BYTES
  ) {
    throw new PayPalWebhookBodyTooLargeError();
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAXIMUM_PAYPAL_WEBHOOK_BYTES) {
    throw new PayPalWebhookBodyTooLargeError();
  }
  return raw;
}

export function decodePayPalWebhookBody(raw: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}
