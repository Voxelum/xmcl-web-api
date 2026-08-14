import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppConfig, getConfig } from "../config.ts";
import {
  AiProviderClient,
  AgnesConfigurationError,
  type AgnesFetch,
  AgnesUpstreamError,
  DEFAULT_AGNES_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  defaultAgnesFetch,
  parseAgnesApiKeys,
  parseDeepSeekApiKeys,
} from "../agnes.ts";
import { handleAccountError, requestId } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import { BillingEntitlementReader } from "../entitlements.ts";
import {
  AllowanceMeter,
  type OpenAiTokenUsage,
} from "../allowanceMetering.ts";
import {
  buildLauncherAgentSystemPrompt,
  parseLauncherAgentRequestContext,
} from "../launcherAgentPrompt.ts";
import { MongoBillingStore } from "../ledger.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import { proxyResponse } from "../proxy.ts";
import type { AppEnv } from "../types.ts";

export const CHAT_COMPLETIONS_MAX_BODY_BYTES = 4 * 1024 * 1024;

type ConfigResolver = (c: Context<AppEnv>) => AppConfig;
type AiEntitlementResolver = (
  c: Context<AppEnv>,
  accountId: string,
) => Promise<boolean>;
type AiAllowanceMeter = Pick<
  AllowanceMeter,
  "reserveAi" | "releaseAi" | "recordAiDelivery" | "settleAi"
>;
type AiAllowanceMeterResolver = (
  c: Context<AppEnv>,
) => Promise<AiAllowanceMeter>;

const DEFAULT_MAX_COMPLETION_TOKENS = 8_192;

function openAiError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  code: string,
) {
  return c.json({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code,
    },
  }, status);
}

async function readRequestBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength && /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > CHAT_COMPLETIONS_MAX_BODY_BYTES
  ) {
    throw new BodyTooLargeError();
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
      if (length > CHAT_COMPLETIONS_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

class BodyTooLargeError extends Error {}

function parseChatRequest(bytes: Uint8Array, defaultModel: string) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const body = value as Record<string, unknown>;
  const launcherContext = parseLauncherAgentRequestContext(body.xmcl);
  const toolNames = parseToolNames(body.tools);
  if (
    !Array.isArray(body.messages) || body.messages.length === 0 ||
    !launcherContext || !toolNames ||
    body.messages.some((message) =>
      !message || typeof message !== "object" || Array.isArray(message) ||
      !["user", "assistant", "tool"].includes(
        String((message as Record<string, unknown>).role),
      )
    ) ||
    (body.stream !== undefined && typeof body.stream !== "boolean") ||
    (body.max_tokens !== undefined &&
      (!Number.isSafeInteger(body.max_tokens) ||
        Number(body.max_tokens) <= 0 ||
        Number(body.max_tokens) > DEFAULT_MAX_COMPLETION_TOKENS)) ||
    (body.model !== undefined &&
      (typeof body.model !== "string" || body.model.length === 0 ||
        body.model.length > 128))
  ) {
    return undefined;
  }
  const { xmcl: _xmcl, ...upstreamBody } = body;
  const maxTokens = Number(body.max_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS);
  const requestBody = {
    ...upstreamBody,
    model: defaultModel,
    max_tokens: maxTokens,
    ...(body.stream
      ? {
        stream_options: {
          ...(
            body.stream_options && typeof body.stream_options === "object" &&
              !Array.isArray(body.stream_options)
              ? body.stream_options
              : {}
          ),
          include_usage: true,
        },
      }
      : {}),
    messages: [
      {
        role: "system",
        content: buildLauncherAgentSystemPrompt(launcherContext, toolNames),
      },
      ...body.messages,
    ],
  };
  const serialized = JSON.stringify(requestBody);
  return {
    body: serialized,
    stream: body.stream === true,
    maximumUnits: new TextEncoder().encode(serialized).byteLength +
      maxTokens * 4,
  };
}

function parseUsageObject(value: unknown): OpenAiTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const details = record.prompt_tokens_details;
  const cached = details && typeof details === "object" &&
      !Array.isArray(details)
    ? (details as Record<string, unknown>).cached_tokens ?? 0
    : record.prompt_cache_hit_tokens ?? 0;
  if (
    !Number.isSafeInteger(record.prompt_tokens) ||
    !Number.isSafeInteger(record.completion_tokens) ||
    !Number.isSafeInteger(cached)
  ) return undefined;
  return {
    promptTokens: Number(record.prompt_tokens),
    cachedPromptTokens: Number(cached),
    completionTokens: Number(record.completion_tokens),
  };
}

export function parseAiUsage(
  contentType: string | null,
  payload: string,
): { usageId?: string; usage: OpenAiTokenUsage } | undefined {
  const values: unknown[] = [];
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    for (const line of payload.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        values.push(JSON.parse(data));
      } catch {
        continue;
      }
    }
  } else {
    try {
      values.push(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const usage = parseUsageObject(values[index]);
    if (!usage) continue;
    const id = (values[index] as Record<string, unknown>).id;
    return {
      ...(typeof id === "string" && id ? { usageId: id } : {}),
      usage,
    };
  }
  return undefined;
}

function parseToolNames(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const names: string[] = [];
  for (const tool of value) {
    if (
      !tool || typeof tool !== "object" || Array.isArray(tool) ||
      (tool as Record<string, unknown>).type !== "function"
    ) return undefined;
    const fn = (tool as Record<string, unknown>).function;
    if (
      !fn || typeof fn !== "object" || Array.isArray(fn) ||
      typeof (fn as Record<string, unknown>).name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(
        (fn as Record<string, unknown>).name as string,
      )
    ) return undefined;
    names.push((fn as Record<string, unknown>).name as string);
  }
  return names;
}

function configuredModel(config: AppConfig): string | undefined {
  const model = config.AGNES_DEFAULT_MODEL?.trim() || DEFAULT_AGNES_MODEL;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model) ? model : undefined;
}

export function createChatCompletionsRoutes(
  resolveAccount: AccountRuntimeResolver = getAccountRuntime,
  fetcher: AgnesFetch = defaultAgnesFetch,
  resolveConfig: ConfigResolver = getConfig,
  resolveEntitlement: AiEntitlementResolver = async (c, accountId) =>
    (await new BillingEntitlementReader(
      new MongoBillingStore(await c.get("getDb")()),
    ).read(accountId)).ai,
  resolveMeter: AiAllowanceMeterResolver = async (c) =>
    new AllowanceMeter(new MongoBillingStore(await c.get("getDb")())),
) {
  const app = new Hono<AppEnv>();
  let client: AiProviderClient | undefined;
  let clientConfiguration: string | undefined;

  app.onError(handleAccountError);
  app.use(
    "/v1/chat/completions",
    xmclAuth(["ai:invoke"], resolveAccount),
  );
  app.use("/v1/chat/completions", async (c, next) => {
    const accountId = c.get("xmclPrincipal")!.accountId;
    if (!(await resolveEntitlement(c, accountId))) {
      return openAiError(
        c,
        402,
        "An active XMCL Together or shared hosting subscription is required",
        "ai_subscription_required",
      );
    }
    await next();
  });

  app.post("/v1/chat/completions", async (c) => {
    if (
      !c.req.header("content-type")?.toLowerCase().startsWith(
        "application/json",
      )
    ) {
      return openAiError(
        c,
        415,
        "Content-Type must be application/json",
        "unsupported_media_type",
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readRequestBody(c.req.raw);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return openAiError(
          c,
          413,
          `Request body exceeds ${CHAT_COMPLETIONS_MAX_BODY_BYTES} bytes`,
          "request_too_large",
        );
      }
      throw error;
    }

    const config = resolveConfig(c);
    const model = configuredModel(config);
    if (!model) {
      return openAiError(
        c,
        503,
        "AI service configuration is invalid",
        "ai_service_not_configured",
      );
    }
    const parsed = parseChatRequest(bytes, model);
    if (!parsed) {
      return openAiError(
        c,
        400,
        "A valid XMCL agent context and non-system chat history are required",
        "invalid_chat_request",
      );
    }

    const accountId = c.get("xmclPrincipal")!.accountId;
    const authorizationId = `ai_${crypto.randomUUID().replaceAll("-", "")}`;
    const meter = await resolveMeter(c);
    if (
      !(await meter.reserveAi(
        accountId,
        authorizationId,
        parsed.maximumUnits,
      ))
    ) {
      return openAiError(
        c,
        402,
        "The AI allowance for this billing period is exhausted",
        "ai_allowance_exhausted",
      );
    }

    try {
      const configuration = JSON.stringify([
        config.AGNES_API_KEYS,
        config.DEEPSEEK_API_KEYS,
        config.DEEPSEEK_DEFAULT_MODEL,
      ]);
      if (!client || clientConfiguration !== configuration) {
        client = new AiProviderClient(
          parseAgnesApiKeys(config.AGNES_API_KEYS),
          parseDeepSeekApiKeys(config.DEEPSEEK_API_KEYS),
          config.DEEPSEEK_DEFAULT_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
          fetcher,
        );
        clientConfiguration = configuration;
      }
      const upstream = await client.chatCompletions(
        parsed.body,
        c.req.raw.signal,
      );
      if (!upstream.ok) {
        await meter.releaseAi(authorizationId);
      } else {
        const usageResponse = upstream.clone();
        let deliveryRecorded = false;
        const settle = async () => {
          const measured = parseAiUsage(
            usageResponse.headers.get("content-type"),
            await usageResponse.text(),
          );
          if (!measured) {
            await meter.releaseAi(authorizationId);
            throw new Error("Agnes response did not include token usage");
          }
          const usageId = measured.usageId ?? authorizationId;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await meter.recordAiDelivery(
                authorizationId,
                usageId,
                measured.usage,
              );
              deliveryRecorded = true;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < 2) {
                await new Promise((resolve) =>
                  setTimeout(resolve, 100 * 2 ** attempt)
                );
              }
            }
          }
          if (!deliveryRecorded) throw lastError;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await meter.settleAi(
                authorizationId,
                usageId,
                measured.usage,
              );
              return;
            } catch (error) {
              lastError = error;
              if (attempt < 2) {
                await new Promise((resolve) =>
                  setTimeout(resolve, 100 * 2 ** attempt)
                );
              }
            }
          }
          throw lastError;
        };
        const work = settle().catch((error) => {
          if (!deliveryRecorded) throw error;
          console.error("AI usage settlement deferred", {
            requestId: authorizationId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        if (parsed.stream) {
          const backgroundWork = work.catch((error) => {
            console.error("AI usage settlement failed", {
              requestId: authorizationId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          const waitUntil = c.get("waitUntil");
          if (waitUntil) waitUntil(backgroundWork);
          else await backgroundWork;
        } else {
          await work;
        }
      }
      const response = proxyResponse(upstream);
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof AgnesConfigurationError) {
        await meter.releaseAi(authorizationId);
        return openAiError(
          c,
          503,
          "AI service is not configured",
          "ai_service_not_configured",
        );
      }
      if (error instanceof AgnesUpstreamError) {
        await meter.releaseAi(authorizationId);
        console.error("AI provider request failed", {
          requestId: requestId(c),
          provider: error.provider,
          causeName: error.causeName,
          causeMessage: error.causeMessage,
        });
        return openAiError(
          c,
          502,
          "AI provider is unavailable",
          "ai_provider_unavailable",
        );
      }
      throw error;
    }
  });

  return app;
}

export default createChatCompletionsRoutes();
