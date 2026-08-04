import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppConfig } from "../config.ts";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import type { AgnesFetch } from "../lib/agnes.ts";
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
) {
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
    ),
  );
  return {
    app,
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

Deno.test("Launcher envelope reaches mocked Agnes with a server-owned prompt and model", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamHeaders: Headers | undefined;
  const { request } = fixture(async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = JSON.parse(String(init?.body));
    return Response.json({
      id: "chatcmpl_1",
      choices: [{ message: { role: "assistant", content: "hello" } }],
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
      : Response.json({ choices: [] });
  });

  const response = await request({
    model: "agnes-2.5-flash",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(authorizations, ["Bearer key-a", "Bearer key-b"]);
});

Deno.test("chat completions streams SSE bytes without buffering or rewriting", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const { request } = fixture(async () =>
    new Response(sse, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    })
  );

  const response = await request({
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(await response.text(), sse);
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
