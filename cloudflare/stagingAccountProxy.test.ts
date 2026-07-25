import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import {
  HmacStagingAccountProxyIdentity,
  type StagingAccountProxyNonceStore,
} from "../src/lib/stagingAccountProxyIdentity.ts";
import { stagingAccountAzureTarget } from "../src/lib/stagingAccountRoutes.ts";
import worker, {
  PAYPAL_WEBHOOK_STAGING_HOST,
  proxyStagingAccount,
  stagingAccountCorsPreflight,
  stagingAccountProxySettings,
} from "./worker.ts";

const origin = "https://staging.launcher.example";
const callback = `${origin}/oauth/callback`;
const secret = "staging-account-proxy-secret-at-least-thirty-two-bytes";
const config: AppConfig = {
  XMCL_STAGING_ACCOUNT_PROXY_ENABLED: "true",
  XMCL_STAGING_ACCOUNT_PROXY_URL:
    "https://xmcl-shared-sgp-control.azurewebsites.net/api",
  XMCL_STAGING_ACCOUNT_PROXY_KEY_ID: "staging-account-worker-v1",
  XMCL_STAGING_ACCOUNT_PROXY_SECRET: secret,
  XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS: origin,
};

class Nonces implements StagingAccountProxyNonceStore {
  readonly durable = true as const;
  readonly used = new Set<string>();

  async consume(input: { key: string }) {
    if (this.used.has(input.key)) return false;
    this.used.add(input.key);
    return true;
  }
}

function request(
  path: string,
  options: RequestInit = {},
) {
  return new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}${path}`, {
    ...options,
    headers: {
      origin,
      ...(options.method === "POST"
        ? { "content-type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
  });
}

Deno.test("M1 Worker proxy fails closed before the Cloudflare app can touch its database", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response();
  };
  const path = "/v1/account";
  assert.equal(
    (await proxyStagingAccount(request(path), {}, fetchImpl))?.status,
    404,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await worker.fetch(request(path), {}, {} as never)).status,
    404,
  );

  for (
    const invalid of [
      { XMCL_STAGING_ACCOUNT_PROXY_ENABLED: undefined },
      { XMCL_STAGING_ACCOUNT_PROXY_ENABLED: "TRUE" },
      { XMCL_STAGING_ACCOUNT_PROXY_SECRET: undefined },
      {
        XMCL_STAGING_ACCOUNT_PROXY_URL:
          "https://control.example/api?destination=attacker",
      },
      { XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS: `${origin}/` },
    ]
  ) {
    assert.equal(
      stagingAccountProxySettings({ ...config, ...invalid }),
      undefined,
    );
  }
});

Deno.test("M1 Worker preserves authorize query and raw exchange bytes while forwarding only approved headers", async () => {
  const body = new TextEncoder().encode(
    '{"transactionId":"oat_1","code":"€","state":"staging-state","codeVerifier":"verifier"}',
  );
  let outgoing: Request | undefined;
  let options: RequestInit | undefined;
  const response = await proxyStagingAccount(
    request("/v1/auth/google/exchange", {
      method: "POST",
      headers: {
        authorization: "******",
        "x-not-forwarded": "no",
        "x-xmcl-original-target": "/api/attacker",
      },
      body: body as unknown as BodyInit,
    }),
    config,
    async (input, init) => {
      options = init;
      outgoing = new Request(input, init);
      return new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": origin,
          "x-not-returned": "no",
        },
      });
    },
  );
  assert(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("x-not-returned"), null);
  assert(outgoing);
  assert.equal(
    outgoing.url,
    "https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/auth/google/exchange",
  );
  assert.deepEqual(new Uint8Array(await outgoing.arrayBuffer()), body);
  assert.equal(outgoing.headers.get("authorization"), "******");
  assert.equal(outgoing.headers.get("content-type"), "application/json");
  assert.equal(outgoing.headers.get("origin"), origin);
  assert.equal(outgoing.headers.get("x-not-forwarded"), null);
  assert.equal(outgoing.headers.get("x-xmcl-original-target"), null);
  assert.equal(options?.redirect, "manual");
  assert.equal(options?.credentials, "omit");
  assert(options?.signal instanceof AbortSignal);

  const verifier = new HmacStagingAccountProxyIdentity({
    keyId: config.XMCL_STAGING_ACCOUNT_PROXY_KEY_ID!,
    secret,
    nonceStore: new Nonces(),
  });
  await verifier.verifyIncoming({
    method: outgoing.method,
    target: "/api/v1/auth/google/exchange",
    headers: outgoing.headers,
    body,
  });

  let authorizeOutgoing: Request | undefined;
  const query = `?state=staging-state&codeChallenge=${
    "a".repeat(43)
  }&redirectUri=${encodeURIComponent(callback)}`;
  const authorize = await proxyStagingAccount(
    request(`/v1/auth/google/authorize${query}`),
    config,
    async (input, init) => {
      authorizeOutgoing = new Request(input, init);
      return new Response("{}");
    },
  );
  assert.equal(authorize?.status, 200);
  assert(authorizeOutgoing);
  assert.equal(
    authorizeOutgoing.url,
    `https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/auth/google/authorize${query}`,
  );
});

Deno.test("M1 Worker permits only documented provider, account, and session routes", async () => {
  const allowed: Array<[string, string]> = [
    [
      "GET",
      `/v1/auth/microsoft/authorize?redirectUri=${
        encodeURIComponent(callback)
      }&state=s&codeChallenge=${"a".repeat(43)}`,
    ],
    ["POST", "/v1/auth/discord/exchange"],
    ["GET", "/v1/account"],
    ["GET", "/v1/account/identities"],
    ["POST", "/v1/account/identities/google/authorize"],
    ["POST", "/v1/account/identities/google/complete"],
    ["DELETE", "/v1/account/identities/google"],
    ["POST", "/v1/sessions/refresh"],
    ["POST", "/v1/sessions/revoke"],
  ];
  const targets: string[] = [];
  for (const [method, path] of allowed) {
    const response = await proxyStagingAccount(
      request(path, {
        method,
        headers: { authorization: "******" },
        body: method === "POST" ? "{}" : undefined,
      }),
      config,
      async (input) => {
        targets.push(String(input));
        return new Response("{}");
      },
    );
    assert.equal(response?.status, 200, `${method} ${path}`);
  }
  assert.equal(targets.length, allowed.length);

  let calls = 0;
  const noProxy: typeof fetch = async () => {
    calls++;
    return new Response();
  };
  for (
    const [method, path] of [
      ["POST", "/v1/auth/google/authorize"],
      ["GET", "/v1/auth/google/exchange"],
      ["POST", "/v1/auth/google/launcher-exchange"],
      ["GET", "/v1/account/merge/prepare"],
      ["POST", "/v1/account/identities/not-a-provider/complete"],
      ["GET", "/v1/sessions/refresh?next=attacker"],
      ["GET", "/v1/internal/usage/authorize"],
      ["GET", "/v1/compiler-jobs"],
    ]
  ) {
    const result = await proxyStagingAccount(
      request(path, { method }),
      config,
      noProxy,
    );
    if (
      path.startsWith("/v1/auth/google/launcher") ||
      path.startsWith("/v1/account/merge") ||
      path.includes("not-a-provider") || path.startsWith("/v1/internal") ||
      path.startsWith("/v1/compiler")
    ) {
      assert.equal(result, undefined, `${method} ${path}`);
    } else {
      assert.equal(result?.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(calls, 0);
});

Deno.test("M1 Worker CORS and backend failures are restricted and sanitized", async () => {
  const accepted = stagingAccountCorsPreflight(
    request("/v1/account", {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    }),
    config,
  );
  assert.equal(accepted?.status, 204);
  assert.equal(accepted?.headers.get("access-control-allow-origin"), origin);
  const rejected = stagingAccountCorsPreflight(
    new Request(`https://${PAYPAL_WEBHOOK_STAGING_HOST}/v1/account`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    }),
    config,
  );
  assert.equal(rejected?.status, 404);

  const redirected = await proxyStagingAccount(
    request("/v1/account"),
    config,
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example" },
      }),
  );
  assert.equal(redirected?.status, 502);
  assert.deepEqual(await redirected?.json(), {
    error: "staging_account_proxy_unavailable",
  });
});

Deno.test("M1 route target helper rejects duplicate or unapproved OAuth query values", () => {
  assert.equal(
    stagingAccountAzureTarget(
      "GET",
      "/v1/auth/google/authorize",
      `?redirectUri=${encodeURIComponent(callback)}&state=s&codeChallenge=${
        "a".repeat(43)
      }&state=duplicate`,
    ),
    undefined,
  );
  assert.equal(
    stagingAccountAzureTarget(
      "GET",
      "/v1/auth/google/authorize",
      `?redirectUri=${encodeURIComponent(callback)}&state=s&codeChallenge=bad`,
    ),
    undefined,
  );
});
