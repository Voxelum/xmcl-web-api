import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import type { AppEnv } from "../types.ts";
import { resolveDpopVerificationUrl, xmclAuth } from "./xmclAuth.ts";

Deno.test("Azure DPoP verification restores the public api-prefixed URL", () => {
  assert.equal(
    resolveDpopVerificationUrl(
      "https://control.azurewebsites.net/v1/shared-hosting/services",
      "/api/v1/shared-hosting/services",
      "control.azurewebsites.net",
    ),
    "https://control.azurewebsites.net/api/v1/shared-hosting/services",
  );
});

Deno.test("DPoP verification ignores untrusted or inconsistent proxy targets", () => {
  const requestUrl =
    "https://api.example.test/v1/shared-hosting/services?cursor=one";
  assert.equal(
    resolveDpopVerificationUrl(
      requestUrl,
      "/api/v1/shared-hosting/services?cursor=two",
      "api.example.test",
    ),
    requestUrl,
  );
  assert.equal(
    resolveDpopVerificationUrl(
      requestUrl,
      "/api/v1/shared-hosting/services?cursor=one",
      "other.example.test",
    ),
    requestUrl,
  );
});

Deno.test("overlapping auth middleware reuses the verified principal", async () => {
  let verificationCount = 0;
  const runtime = {
    sessions: {
      verify: async () => {
        verificationCount += 1;
        return { accountId: "account_1", scopes: ["account:read"] };
      },
    },
  } as unknown as AccountRuntime;
  const resolve = () => Promise.resolve(runtime);
  const app = new Hono<AppEnv>();
  app.use("/v1/shared-hosting/*", xmclAuth(["account:read"], resolve));
  app.use(
    "/v1/shared-hosting/services/*",
    xmclAuth(["account:read"], resolve),
  );
  app.get("/v1/shared-hosting/services", (c) =>
    c.json({ accountId: c.get("xmclPrincipal")!.accountId }));

  const response = await app.request("/v1/shared-hosting/services", {
    headers: { authorization: "Bearer session" },
  });

  assert.equal(response.status, 200);
  assert.equal(verificationCount, 1);
});
