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
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAXIMUM_PAYPAL_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new PayPalWebhookBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export function decodePayPalWebhookBody(raw: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}
