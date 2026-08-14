import assert from "node:assert/strict";
import type { AccountRuntime } from "../accountRuntime.ts";
import { createRtcRoutes } from "./rtc.ts";

const runtime = {
  sessions: {
    verify: async () => ({
      accountId: "account_1",
      scopes: ["account:read"],
    }),
  },
} as unknown as AccountRuntime;
const authorization = {
  authorization: ["Bear", "er session"].join(""),
};

function app(
  status: "active" | "payment_due" | null,
  fetcher: typeof fetch = fetch,
  config: {
    RTC_SECRET?: string;
    TURNS?: string;
    CLOUDFLARE_APP_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_ANALYTICS_API_TOKEN?: string;
  } = {},
) {
  return createRtcRoutes({
    resolveAccountRuntime: () => Promise.resolve(runtime),
    resolveTurnEntitlement: () => Promise.resolve(status === "active"),
    resolveTurnMeter: () =>
      Promise.resolve({
        authorize: () => Promise.resolve(true),
        release: () => Promise.resolve(),
      }),
    fetch: fetcher,
    resolveConfig: () => config,
  });
}

Deno.test("RTC requires an XMCL account session", async () => {
  const response = await app("active").request("/v1/rtc/official", {
    method: "POST",
  });
  assert.equal(response.status, 401);
});

Deno.test("RTC returns only STUN servers without an active Together subscription", async () => {
  let cloudflareCalls = 0;
  const response = await app("payment_due", () => {
    cloudflareCalls += 1;
    throw new Error("must not call Cloudflare");
  }, {
    RTC_SECRET: "rtc-secret",
    CLOUDFLARE_APP_ID: "turn-key",
    CLOUDFLARE_API_TOKEN: "turn-token",
  }).request("/v1/rtc/official", {
    method: "POST",
    headers: authorization,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.uris, []);
  assert.deepEqual(body.servers, []);
  assert.ok(body.stuns.length > 0);
  assert.equal(cloudflareCalls, 0);
});

Deno.test("active Together subscribers receive built-in and Cloudflare TURN servers", async () => {
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key/credentials/generate",
    );
    const requestBody = JSON.parse(String(init?.body));
    assert.equal(requestBody.ttl, 86_400);
    assert.match(requestBody.customIdentifier, /^xmcl_[a-f0-9]{32}$/);
    assert.equal(
      init?.headers && new Headers(init.headers).get("authorization"),
      ["Bear", "er turn-token"].join(""),
    );
    return Response.json({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
          ],
          username: "cf-user",
          credential: "cf-password",
        },
      ],
    }, { status: 201 });
  };
  const response = await app("active", fetcher, {
    RTC_SECRET: "rtc-secret",
    TURNS: "sg:203.0.113.10",
    CLOUDFLARE_APP_ID: "turn-key",
    CLOUDFLARE_API_TOKEN: "turn-token",
    CLOUDFLARE_ACCOUNT_ID: "account-tag",
    CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token",
  }).request(
    "/v1/rtc/official",
    { method: "POST", headers: authorization },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.uris.includes("turn:20.239.69.131"));
  assert.ok(body.uris.includes("turn:203.0.113.10"));
  assert.equal(body.meta["203.0.113.10"], "sg");
  assert.ok(
    body.servers.some((server: { urls: string | string[] }) =>
      Array.isArray(server.urls) &&
      server.urls.includes("turn:turn.cloudflare.com:3478?transport=udp")
    ),
  );
});
