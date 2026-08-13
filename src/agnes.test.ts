import assert from "node:assert/strict";
import {
  AGNES_CHAT_COMPLETIONS_URL,
  AiProviderClient,
  AgnesClient,
  AgnesConfigurationError,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  parseAgnesApiKeys,
  parseDeepSeekApiKeys,
} from "./agnes.ts";

Deno.test("Agnes key configuration is strict and deduplicated", () => {
  assert.deepEqual(parseAgnesApiKeys('[" key-a ","key-b"]'), [
    "key-a",
    "key-b",
  ]);
  assert.throws(
    () => parseAgnesApiKeys("key-a,key-b"),
    AgnesConfigurationError,
  );
  assert.throws(
    () => parseAgnesApiKeys('["key-a","key-a"]'),
    AgnesConfigurationError,
  );
});

Deno.test("DeepSeek key configuration is optional but otherwise strict", () => {
  assert.deepEqual(parseDeepSeekApiKeys(undefined), []);
  assert.deepEqual(parseDeepSeekApiKeys('["deepseek-key"]'), ["deepseek-key"]);
  assert.throws(
    () => parseDeepSeekApiKeys("deepseek-key"),
    AgnesConfigurationError,
  );
});

Deno.test("Agnes client rotates keys between requests", async () => {
  const keyOrder: string[] = [];
  const client = new AgnesClient(["key-a", "key-b"], async (input, init) => {
    assert.equal(input, AGNES_CHAT_COMPLETIONS_URL);
    const authorization = new Headers(init?.headers).get("authorization")!;
    keyOrder.push(authorization.endsWith("key-a") ? "a" : "b");
    return Response.json({ ok: true });
  });

  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.deepEqual(keyOrder, ["a", "b"]);
});

Deno.test("Agnes client omits an undefined AbortSignal from RequestInit", async () => {
  const client = new AgnesClient(["key-a"], async (_input, init) => {
    assert.equal(Object.hasOwn(init ?? {}, "signal"), false);
    return Response.json({ ok: true });
  });

  assert.equal((await client.chatCompletions("{}")).status, 200);
});

Deno.test("Agnes client fails over on 429 and cools down that key", async () => {
  let now = Date.parse("2026-07-22T10:00:00.000Z");
  const keyOrder: string[] = [];
  const client = new AgnesClient(
    ["key-a", "key-b"],
    async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization")!;
      keyOrder.push(authorization.endsWith("key-a") ? "a" : "b");
      if (authorization.endsWith("key-a")) {
        return Response.json({ error: "limited" }, {
          status: 429,
          headers: { "retry-after": "30" },
        });
      }
      return Response.json({ ok: true });
    },
    () => now,
  );

  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.deepEqual(keyOrder, ["a", "b", "b"]);

  now += 30_001;
  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.deepEqual(keyOrder, ["a", "b", "b", "a", "b"]);
});

Deno.test("Agnes client bounds retries and reports all keys cooling down", async () => {
  let calls = 0;
  const client = new AgnesClient(
    ["key-a", "key-b"],
    async () => {
      calls += 1;
      return Response.json({ error: "limited" }, {
        status: 429,
        headers: { "retry-after": "12" },
      });
    },
    () => 1_000,
  );

  const first = await client.chatCompletions("{}");
  assert.equal(first.status, 429);
  assert.equal(calls, 2);
  assert.deepEqual(await first.json(), { error: "limited" });

  const second = await client.chatCompletions("{}");
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "12");
  assert.equal(calls, 2);
});

Deno.test("Agnes client does not replay non-rate-limit failures", async () => {
  let calls = 0;
  const client = new AgnesClient(["key-a", "key-b"], async () => {
    calls += 1;
    return Response.json({ error: "invalid key" }, { status: 401 });
  });

  assert.equal((await client.chatCompletions("{}")).status, 401);
  assert.equal(calls, 1);
});

Deno.test("Agnes client tries the remaining key after a network failure", async () => {
  let calls = 0;
  const client = new AgnesClient(["key-a", "key-b"], async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return Response.json({ ok: true });
  });

  assert.equal((await client.chatCompletions("{}")).status, 200);
  assert.equal(calls, 2);
});

Deno.test("AI provider falls back to DeepSeek and replaces the model", async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const client = new AiProviderClient(
    ["agnes-key"],
    ["deepseek-key"],
    "deepseek-v4-flash",
    async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        model: JSON.parse(String(init?.body)).model,
      });
      return url === AGNES_CHAT_COMPLETIONS_URL
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ ok: true });
    },
  );

  const response = await client.chatCompletions(
    JSON.stringify({ model: "agnes-2.5-flash", messages: [] }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { url: AGNES_CHAT_COMPLETIONS_URL, model: "agnes-2.5-flash" },
    { url: DEEPSEEK_CHAT_COMPLETIONS_URL, model: "deepseek-v4-flash" },
  ]);
});
