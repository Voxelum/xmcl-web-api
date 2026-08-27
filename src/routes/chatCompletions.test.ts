import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppConfig } from "../config.ts";
import type { AccountRuntime } from "../accountRuntime.ts";
import type { AgnesFetch } from "../agnes.ts";
import type { AppEnv } from "../types.ts";
import {
  CHAT_COMPLETIONS_MAX_BODY_BYTES,
  createChatCompletionsRoutes,
} from "./chatCompletions.ts";

function xmclContext(agentType: "launcher" | "css" = "launcher") {
  return {
    promptVersion: 1,
    agentType,
    locale: "en",
    ...(agentType === "css" ? { sessionContext: { scope: "global" } } : {
      sessionContext: {
        instancePath: "C:\\Games\\XMCL\\instances\\test",
        instanceName: "Test Instance",
        runtime: { minecraft: "1.21.1", fabricLoader: "0.16.10" },
        userId: "user-1",
        page: "/mods",
      },
    }),
  };
}

function fixture(
  fetcher: AgnesFetch,
  config: AppConfig = { AGNES_API_KEYS: '["key-a","key-b"]' },
  scopes = ["ai:invoke"],
  entitled = true,
  settlementFails = false,
  auditFails = false,
) {
  const settlements: Array<{
    authorizationId: string;
    usageId: string;
    usage: {
      promptTokens: number;
      cachedPromptTokens: number;
      completionTokens: number;
    };
  }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const runtime = {
    sessions: {
      verify: async (token: string) => {
        if (token !== "session-token") throw new Error("invalid session");
        return {
          sessionId: "session",
          familyId: "family",
          accountId: "account",
          scopes,
          issuedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-23T10:00:00.000Z",
        };
      },
    },
  } as unknown as AccountRuntime;
  const app = new Hono<AppEnv>();
  app.route(
    "/",
    createChatCompletionsRoutes(
      async () => runtime,
      fetcher,
      () => config,
      () => Promise.resolve(entitled),
      () =>
        Promise.resolve({
          reserveAi: () => Promise.resolve(true),
          releaseAi: () => Promise.resolve(),
          settleAi: (authorizationId, usageId, usage) => {
            if (settlementFails) {
              return Promise.reject(new Error("private accounting failure"));
            }
            settlements.push({ authorizationId, usageId, usage });
            return Promise.resolve({
              authorizationId,
              usageId,
              weightedUnits: 0,
            });
          },
        }),
      () =>
        Promise.resolve({
          record: (event) => {
            if (auditFails) {
              return Promise.reject(new Error("private audit failure"));
            }
            audits.push(
              structuredClone(event) as unknown as Record<string, unknown>,
            );
            return Promise.resolve("recorded" as const);
          },
        }),
    ),
  );
  return {
    app,
    settlements,
    audits,
    request: (body: unknown, init: RequestInit = {}) => {
      const requestBody = body && typeof body === "object" &&
          !Array.isArray(body) && "messages" in body &&
          !("xmcl" in body)
        ? { ...body, xmcl: xmclContext() }
        : body;
      return app.request("/v1/chat/completions", {
        method: "POST",
        ...init,
        headers: {
          authorization: "Bearer session-token",
          "content-type": "application/json",
          ...init.headers,
        },
        body: typeof requestBody === "string"
          ? requestBody
          : JSON.stringify(requestBody),
      });
    },
  };
}

Deno.test("chat completions requires an XMCL session with ai:invoke", async () => {
  const configured = fixture(async () => Response.json({}));
  const missing = await configured.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, "authentication_required");

  const forbidden = await fixture(
    async () => Response.json({}),
    { AGNES_API_KEYS: '["key-a"]' },
    [],
  ).request({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "insufficient_scope");
});

Deno.test("chat completions requires a paid AI entitlement", async () => {
  let calls = 0;
  const { request } = fixture(
    async () => {
      calls += 1;
      return Response.json({});
    },
    { AGNES_API_KEYS: '["key-a"]' },
    ["ai:invoke"],
    false,
  );

  const response = await request({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 402);
  assert.equal(
    (await response.json()).error.code,
    "ai_subscription_required",
  );
  assert.equal(calls, 0);
});

Deno.test("AI reservations ignore a reused client request ID", async () => {
  const f = fixture(async () =>
    Response.json({
      id: "chatcmpl_usage",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
  );
  const body = { messages: [{ role: "user", content: "hello" }] };
  const headers = { "x-request-id": "client-controlled-id" };
  assert.equal((await f.request(body, { headers })).status, 200);
  assert.equal((await f.request(body, { headers })).status, 200);
  assert.equal(f.settlements.length, 2);
  assert.notEqual(
    f.settlements[0].authorizationId,
    f.settlements[1].authorizationId,
  );
});

Deno.test("AI audit events are account-owned and never contain chat content", async () => {
  const f = fixture(async () =>
    Response.json({
      id: "chatcmpl_usage",
      choices: [{ message: { content: "must not be audited" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })
  );
  const response = await f.request({
    messages: [{ role: "user", content: "private prompt" }],
  });
  assert.equal(response.status, 200);
  assert.equal(f.audits.length, 1);
  const audit = f.audits[0];
  assert.equal(audit.accountId, "account");
  assert.equal(audit.outcome, "succeeded");
  assert.equal(audit.promptTokens, 10);
  assert.equal(audit.cachedPromptTokens, 4);
  assert.equal(audit.completionTokens, 2);
  assert.equal(JSON.stringify(audit).includes("private prompt"), false);
  assert.equal(JSON.stringify(audit).includes("must not be audited"), false);
});

Deno.test("AI audit records a bounded failure without provider error content", async () => {
  const f = fixture(async () =>
    Response.json({ error: { message: "provider private details" } }, {
      status: 503,
    })
  );
  const response = await f.request({
    messages: [{ role: "user", content: "private prompt" }],
  });

  assert.equal(response.status, 503);
  assert.deepEqual(
    f.audits.map((audit) => ({
      outcome: audit.outcome,
      statusClass: audit.statusClass,
      failureCode: audit.failureCode,
    })),
    [{
      outcome: "failed",
      statusClass: "5xx",
      failureCode: "upstream_rejected",
    }],
  );
  assert.equal(JSON.stringify(f.audits).includes("private"), false);
});

Deno.test("AI accounting failure does not return a successful billable response", async () => {
  const f = fixture(
    async () =>
      Response.json({
        id: "chatcmpl_usage",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    undefined,
    undefined,
    true,
    true,
  );
  const response = await f.request({
    messages: [{ role: "user", content: "private prompt" }],
  });
  assert.equal(response.status, 500);
  assert.deepEqual(f.audits.map((audit) => audit.failureCode), [
    "accounting_failed",
  ]);
  assert.equal(JSON.stringify(f.audits).includes("private"), false);
});

Deno.test("AI audit failure does not discard an already billed completion", async () => {
  const f = fixture(
    async () =>
      Response.json({
        id: "chatcmpl_usage",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    { AGNES_API_KEYS: '["key-a"]' },
    ["ai:invoke"],
    true,
    false,
    true,
  );

  const response = await f.request({
    messages: [{ role: "user", content: "private prompt" }],
  });

  assert.equal(response.status, 200);
  assert.equal(f.settlements.length, 1);
  assert.equal(f.audits.length, 0);
});

Deno.test("Launcher envelope reaches mocked Agnes with a server-owned prompt and model", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamHeaders: Headers | undefined;
  const { request } = fixture(async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = JSON.parse(String(init?.body));
    return Response.json({
      id: "chatcmpl_1",
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
  });

  const response = await request({
    xmcl: {
      ...xmclContext(),
      documents: [{
        id: "instance-management",
        description: "Manage an XMCL instance.",
      }],
    },
    model: "xmcl-agent",
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      type: "function",
      function: {
        name: "vfs_shell",
        description: "Run one virtual XMCL command.",
        parameters: { type: "object", properties: {} },
      },
    }],
  }, {
    headers: {
      cookie: "session=cookie-must-not-leak",
      "x-client-header": "must-not-leak",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamBody?.model, "agnes-2.5-flash");
  assert.equal(upstreamBody?.max_tokens, 8192);
  assert.equal(upstreamBody?.xmcl, undefined);
  const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0].role, "system");
  assert.match(
    String(messages[0].content),
    /## Launcher session context/,
  );
  assert.match(String(messages[0].content), /Test Instance/);
  assert.match(String(messages[0].content), /Available tools: vfs_shell/);
  assert.match(String(messages[0].content), /Manage an XMCL instance/);
  assert.equal(messages[1].role, "user");
  assert.equal(upstreamHeaders?.get("authorization"), "Bearer key-a");
  assert.equal(upstreamHeaders?.get("cookie"), null);
  assert.equal(upstreamHeaders?.get("x-client-header"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

Deno.test("chat completions retries a 429 with the next key", async () => {
  const authorizations: string[] = [];
  const { request } = fixture(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")!;
    authorizations.push(authorization);
    return authorization === "Bearer key-a"
      ? Response.json({ error: "limited" }, {
        status: 429,
        headers: { "retry-after": "30" },
      })
      : Response.json({
        id: "chatcmpl_retry",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
  });

  const response = await request({
    model: "agnes-2.5-flash",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(authorizations, ["Bearer key-a", "Bearer key-b"]);
});

Deno.test("chat completions falls back from Agnes to DeepSeek", async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const routed = fixture(
    async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, model: body.model });
      if (url.includes("agnes-ai.com")) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return Response.json({
        id: "deepseek_completion",
        choices: [{ message: { role: "assistant", content: "fallback" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
        },
      });
    },
    {
      AGNES_API_KEYS: '["agnes-key"]',
      DEEPSEEK_API_KEYS: '["deepseek-key"]',
      DEEPSEEK_DEFAULT_MODEL: "deepseek-v4-flash",
    },
  );

  const response = await routed.request({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.model), [
    "agnes-2.5-flash",
    "deepseek-v4-flash",
  ]);
  assert.deepEqual(routed.settlements[0]?.usage, {
    promptTokens: 100,
    cachedPromptTokens: 60,
    completionTokens: 10,
  });
});

Deno.test("chat completions streams SSE bytes without buffering or rewriting", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"id":"chatcmpl_stream","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  let upstreamBody: Record<string, unknown> | undefined;
  const streamed = fixture(async (_input, init) => {
    upstreamBody = JSON.parse(String(init?.body));
    return new Response(sse, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });

  const response = await streamed.request({
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(await response.text(), sse);
  assert.deepEqual(upstreamBody?.stream_options, { include_usage: true });
  assert.deepEqual(streamed.settlements[0]?.usage, {
    promptTokens: 50,
    cachedPromptTokens: 20,
    completionTokens: 5,
  });
});

Deno.test("chat completions rejects client-supplied system prompts", async () => {
  let calls = 0;
  const { request } = fixture(async () => {
    calls += 1;
    return Response.json({});
  });
  const response = await request({
    xmcl: xmclContext(),
    messages: [{ role: "system", content: "client-controlled" }],
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

Deno.test("chat completions rejects invalid, oversized, and unconfigured requests", async () => {
  let calls = 0;
  const fetcher: AgnesFetch = async () => {
    calls += 1;
    return Response.json({});
  };
  const configured = fixture(fetcher);

  assert.equal((await configured.request({ messages: [] })).status, 400);
  assert.equal(
    (await configured.request("{}", {
      headers: {
        "content-length": String(CHAT_COMPLETIONS_MAX_BODY_BYTES + 1),
      },
    })).status,
    413,
  );
  assert.equal(calls, 0);

  let chunks = 0;
  const streamed = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ < 5) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      } else {
        controller.close();
      }
    },
  });
  const streamedResponse = await configured.app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer session-token",
        "content-type": "application/json",
      },
      body: streamed,
    }),
  );
  assert.equal(streamedResponse.status, 413);
  assert.equal(calls, 0);

  const unavailable = fixture(fetcher, {});
  const response = await unavailable.request({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "ai_service_not_configured");
  assert.equal(calls, 0);
});

Deno.test("chat completions hides Agnes keys on network failure", async () => {
  const { request } = fixture(async () => {
    throw new Error("network failed for key-a");
  });
  const response = await request({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("key-a"), false);
});
