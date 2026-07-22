import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AccountError, randomId } from "./account.ts";
import { OAuthProviderError } from "./oauth/types.ts";

export function requestId(c: Context) {
  const supplied = c.req.header("x-request-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : randomId("req");
}

export async function jsonBody(c: Context) {
  try {
    return await c.req.json() as Record<string, unknown>;
  } catch {
    throw new AccountError(422, "invalid_json");
  }
}

export function handleAccountError(error: Error, c: Context) {
  const id = requestId(c);
  if (error instanceof AccountError) {
    return c.json({
      error: error.code,
      message: error.message,
      requestId: id,
      ...(error.details === undefined ? {} : { details: error.details }),
    }, error.status as ContentfulStatusCode);
  }
  if (error instanceof OAuthProviderError) {
    const status = error.code === "provider_unavailable"
      ? 503
      : error.code === "provider_not_configured"
      ? 503
      : error.code === "provider_rejected"
      ? 502
      : 401;
    return c.json({
      error: error.code,
      message: error.message,
      requestId: id,
    }, status);
  }
  console.error("Account request failed", {
    requestId: id,
    error: error.name,
  });
  return c.json({
    error: "internal_error",
    message: "Internal server error",
    requestId: id,
  }, 500);
}
