import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppConfig, getConfig } from "../config.ts";
import {
  AgnesClient,
  AgnesConfigurationError,
  type AgnesFetch,
  AgnesUpstreamError,
  DEFAULT_AGNES_MODEL,
  parseAgnesApiKeys,
} from "../agnes.ts";
import { handleAccountError, requestId } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import {
  buildLauncherAgentSystemPrompt,
  parseLauncherAgentRequestContext,
} from "../launcherAgentPrompt.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import { proxyResponse } from "../proxy.ts";
import type { AppEnv } from "../types.ts";

export const CHAT_COMPLETIONS_MAX_BODY_BYTES = 4 * 1024 * 1024;

type ConfigResolver = (c: Context<AppEnv>) => AppConfig;

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
    (body.model !== undefined &&
      (typeof body.model !== "string" || body.model.length === 0 ||
        body.model.length > 128))
  ) {
    return undefined;
  }
  const { xmcl: _xmcl, ...upstreamBody } = body;
  return JSON.stringify({
    ...upstreamBody,
    model: defaultModel,
    messages: [
      {
        role: "system",
        content: buildLauncherAgentSystemPrompt(launcherContext, toolNames),
      },
      ...body.messages,
    ],
  });
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
  fetcher: AgnesFetch = fetch,
  resolveConfig: ConfigResolver = getConfig,
) {
  const app = new Hono<AppEnv>();
  let client: AgnesClient | undefined;
  let clientConfiguration: string | undefined;

  app.onError(handleAccountError);
  app.use(
    "/v1/chat/completions",
    xmclAuth(["ai:invoke"], resolveAccount),
  );

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
    const body = parseChatRequest(bytes, model);
    if (!body) {
      return openAiError(
        c,
        400,
        "A valid XMCL agent context and non-system chat history are required",
        "invalid_chat_request",
      );
    }

    try {
      if (!client || clientConfiguration !== config.AGNES_API_KEYS) {
        client = new AgnesClient(
          parseAgnesApiKeys(config.AGNES_API_KEYS),
          fetcher,
        );
        clientConfiguration = config.AGNES_API_KEYS;
      }
      const upstream = await client.chatCompletions(
        body,
        c.req.raw.signal,
      );
      const response = proxyResponse(upstream);
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof AgnesConfigurationError) {
        return openAiError(
          c,
          503,
          "AI service is not configured",
          "ai_service_not_configured",
        );
      }
      if (error instanceof AgnesUpstreamError) {
        console.error("Agnes request failed", { requestId: requestId(c) });
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
