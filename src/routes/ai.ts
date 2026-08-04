import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Context } from "hono";
import { requestId } from "../lib/accountHttp.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import {
  AiRequestError,
  AiRequestService,
  type AiServiceDependencies,
} from "../lib/ai/service.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

function apiError(
  c: { json: (body: unknown, status: ContentfulStatusCode) => Response },
  status: ContentfulStatusCode,
  error: string,
  id: string,
) {
  return c.json({ error, message: error, requestId: id }, status);
}

function idempotencyKey(
  c: { req: { header(name: string): string | undefined } },
) {
  const key = c.req.header("idempotency-key");
  return key && key.length <= 255 ? key : undefined;
}

function parseRequestBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.input !== "string" || body.input.length === 0 ||
    (body.model !== undefined &&
      (typeof body.model !== "string" || body.model.length === 0)) ||
    Object.keys(body).some((key) => key !== "input" && key !== "model")
  ) return undefined;
  return { input: body.input, model: body.model as string | undefined };
}

function service(dependencies: AiServiceDependencies | undefined) {
  return new AiRequestService(dependencies ?? { models: [] });
}

function toAiResponse(
  c: { json: (body: unknown, status: ContentfulStatusCode) => Response },
  error: unknown,
  id: string,
) {
  if (error instanceof AiRequestError) {
    return apiError(c, error.status, error.code, id);
  }
  return apiError(c, 500, "ai_request_failed", id);
}

export function createAiRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
  resolveAi: (c: Context<AppEnv>) => AiServiceDependencies | undefined = (c) =>
    c.get("aiServiceDependencies"),
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/ai/*", xmclAuth(["ai:invoke"], resolve));

  app.get("/v1/ai/models", (c) => {
    const dependencies = resolveAi(c);
    if (!dependencies) {
      return apiError(c, 503, "ai_service_not_configured", requestId(c));
    }
    return c.json(service(dependencies).listModels());
  });

  app.post("/v1/ai/:capability", async (c) => {
    const id = requestId(c);
    const key = idempotencyKey(c);
    if (!key) return apiError(c, 422, "invalid_idempotency_key", id);
    const body = parseRequestBody(await c.req.json().catch(() => undefined));
    if (!body) return apiError(c, 400, "invalid_ai_request", id);
    try {
      return c.json(
        await service(resolveAi(c)).execute({
          requestId: id,
          accountId: c.get("xmclPrincipal")!.accountId,
          capability: c.req.param("capability"),
          model: body.model,
          input: body.input,
          idempotencyKey: key,
        }),
      );
    } catch (error) {
      return toAiResponse(c, error, id);
    }
  });

  app.get(
    "/v1/ai/usage",
    (c) => apiError(c, 503, "ai_usage_not_configured", requestId(c)),
  );

  return app;
}

export default createAiRoutes();
