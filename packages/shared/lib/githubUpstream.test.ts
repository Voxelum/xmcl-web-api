import assert from "node:assert/strict";
import { GitHubUpstreamClient, GitHubUpstreamError } from "./githubUpstream.ts";

Deno.test("GitHub upstream caches successful responses without exposing its token", async () => {
  let calls = 0;
  let authorization: string | null = null;
  const logs: unknown[] = [];
  const client = new GitHubUpstreamClient(
    async (_input, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization");
      assert.equal(headers.get("user-agent"), "xmcl-web-api");
      return Response.json([{ tag_name: "v1.0.0" }], {
        headers: { etag: '"release-etag"' },
      });
    },
    () => 1_000,
    { warn: (value) => logs.push(value) },
  );
  const options = {
    resource: "releases" as const,
    token: "github-secret",
    freshForMs: 300_000,
    staleForMs: 3_600_000,
  };

  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    [{ tag_name: "v1.0.0" }],
  );
  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    [{ tag_name: "v1.0.0" }],
  );
  assert.equal(calls, 1);
  assert.equal(authorization, "Bearer github-secret");
  assert.equal(JSON.stringify(logs).includes("github-secret"), false);
});

Deno.test("GitHub upstream coalesces concurrent cache misses", async () => {
  let calls = 0;
  let resolveFetch!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const client = new GitHubUpstreamClient(async () => {
    calls += 1;
    return await pending;
  });
  const options = {
    resource: "notifications" as const,
    freshForMs: 300_000,
    staleForMs: 3_600_000,
  };

  const first = client.fetch("https://api.github.com/issues", options);
  const second = client.fetch("https://api.github.com/issues", options);
  assert.equal(calls, 1);
  resolveFetch(Response.json([{ id: 1 }]));

  assert.deepEqual(await (await first).json(), [{ id: 1 }]);
  assert.deepEqual(await (await second).json(), [{ id: 1 }]);
  assert.equal(calls, 1);
});

Deno.test("GitHub upstream serves stale data throughout a rate-limit cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const logs: unknown[] = [];
  const client = new GitHubUpstreamClient(
    async () => {
      calls += 1;
      if (calls === 1) return Response.json({ value: "cached" });
      return Response.json({ message: "rate limited and private" }, {
        status: 403,
        headers: { "retry-after": "30" },
      });
    },
    () => now,
    { warn: (value) => logs.push(value) },
  );
  const options = {
    resource: "releases" as const,
    token: "github-secret",
    freshForMs: 10,
    staleForMs: 60_000,
  };

  await client.fetch("https://api.github.com/releases", options);
  now += 11;
  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    { value: "cached" },
  );
  now += 1_000;
  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    { value: "cached" },
  );
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(logs).includes("private"), false);
  assert.equal(JSON.stringify(logs).includes("github-secret"), false);
  assert.equal(
    (logs[0] as { event: string }).event,
    "github.upstream.rate_limited",
  );
});

Deno.test("GitHub upstream suppresses repeated rate-limited misses", async () => {
  let now = 10_000;
  let calls = 0;
  const client = new GitHubUpstreamClient(
    async () => {
      calls += 1;
      return new Response("limited", {
        status: 429,
        headers: { "retry-after": "20" },
      });
    },
    () => now,
    { warn() {} },
  );
  const options = {
    resource: "workflow_runs" as const,
    freshForMs: 10,
    staleForMs: 100,
  };

  await assert.rejects(
    () => client.fetch("https://api.github.com/runs", options),
    GitHubUpstreamError,
  );
  now += 1_000;
  await assert.rejects(
    () => client.fetch("https://api.github.com/runs", options),
    GitHubUpstreamError,
  );
  assert.equal(calls, 1);
});

Deno.test("GitHub upstream negatively caches raw 404 responses", async () => {
  let calls = 0;
  const client = new GitHubUpstreamClient(async () => {
    calls += 1;
    return new Response("404: Not Found", { status: 404 });
  });
  const options = {
    resource: "release_changelog" as const,
    freshForMs: 60_000,
    staleForMs: 3_600_000,
    cacheNotFoundForMs: 600_000,
    api: false,
  };

  assert.equal(
    (await client.fetch("https://raw.githubusercontent.com/missing", options))
      .status,
    404,
  );
  assert.equal(
    (await client.fetch("https://raw.githubusercontent.com/missing", options))
      .status,
    404,
  );
  assert.equal(calls, 1);
});

Deno.test("GitHub upstream applies rate-limit cooldown across host URLs", async () => {
  let calls = 0;
  const client = new GitHubUpstreamClient(
    async () => {
      calls += 1;
      return new Response("limited", {
        status: 403,
        headers: { "retry-after": "60" },
      });
    },
    () => 1_000,
    { warn() {} },
  );
  const options = {
    resource: "notifications" as const,
    freshForMs: 10,
    staleForMs: 100,
  };

  await assert.rejects(
    () => client.fetch("https://api.github.com/issues?labels=one", options),
    GitHubUpstreamError,
  );
  await assert.rejects(
    () => client.fetch("https://api.github.com/issues?labels=two", options),
    GitHubUpstreamError,
  );
  assert.equal(calls, 1);
});

Deno.test("GitHub upstream uses stale data when a response body fails", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new GitHubUpstreamClient(
    async () => {
      calls += 1;
      if (calls === 1) return Response.json({ value: "cached" });
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("body failed"));
          },
        }),
      );
    },
    () => now,
    { warn() {} },
  );
  const options = {
    resource: "releases" as const,
    freshForMs: 10,
    staleForMs: 60_000,
  };

  await client.fetch("https://api.github.com/releases", options);
  now += 11;
  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    { value: "cached" },
  );
  now += 1_000;
  assert.deepEqual(
    await (await client.fetch("https://api.github.com/releases", options))
      .json(),
    { value: "cached" },
  );
  assert.equal(calls, 2);
});

Deno.test("GitHub upstream enforces its concurrent cache admission limit", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  const client = new GitHubUpstreamClient(
    () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }),
    () => 1_000,
    { warn() {} },
  );
  const options = {
    resource: "notifications" as const,
    freshForMs: 10,
    staleForMs: 100,
  };
  const pending = Array.from(
    { length: 256 },
    (_, index) =>
      client.fetch(`https://api.github.com/issues?labels=${index}`, options),
  );

  await assert.rejects(
    () =>
      client.fetch("https://api.github.com/issues?labels=overflow", options),
    GitHubUpstreamError,
  );
  assert.equal(resolvers.length, 256);
  resolvers.forEach((resolve, index) => resolve(Response.json({ index })));
  await Promise.all(pending);
});

Deno.test("GitHub upstream preserves the longest concurrent host cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const resolvers: Array<(response: Response) => void> = [];
  const client = new GitHubUpstreamClient(
    () => {
      calls += 1;
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    },
    () => now,
    { warn() {} },
  );
  const options = {
    resource: "notifications" as const,
    freshForMs: 10,
    staleForMs: 100,
  };
  const long = client.fetch(
    "https://api.github.com/issues?labels=long",
    options,
  );
  const short = client.fetch(
    "https://api.github.com/issues?labels=short",
    options,
  );
  resolvers[0](
    new Response("limited", {
      status: 429,
      headers: { "retry-after": "600" },
    }),
  );
  await assert.rejects(() => long, GitHubUpstreamError);
  resolvers[1](
    new Response("limited", {
      status: 429,
      headers: { "retry-after": "60" },
    }),
  );
  await assert.rejects(() => short, GitHubUpstreamError);

  now += 61_000;
  await assert.rejects(
    () =>
      client.fetch(
        "https://api.github.com/issues?labels=another",
        options,
      ),
    GitHubUpstreamError,
  );
  assert.equal(calls, 2);
});
