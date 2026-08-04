import assert from "node:assert/strict";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { createApp } from "../app.ts";

const principal = {
  sessionId: "session_123",
  familyId: "family_123",
  accountId: "account_123",
  scopes: [],
  issuedAt: "2026-07-22T00:00:00Z",
  expiresAt: "2026-07-23T00:00:00Z",
};

function createFixture() {
  let verifiedToken: string | undefined;
  const runtime = {
    sessions: {
      verify: async (token: string) => {
        verifiedToken = token;
        return principal;
      },
    },
  } as unknown as AccountRuntime;
  return {
    app: createApp((app) => {
      app.use("*", async (c, next) => {
        c.set("accountRuntime", runtime);
        await next();
      });
    }),
    verifiedToken: () => verifiedToken,
  };
}

Deno.test("backup storage policy requires an XMCL session and returns only the fixed policy", async () => {
  const fixture = createFixture();

  const unauthorized = await fixture.app.request("/v1/backup-storage-policy");
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, "authentication_required");

  const response = await fixture.app.request("/v1/backup-storage-policy", {
    headers: { authorization: "Bearer session-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    freeBytes: 1_073_741_824,
    policyVersion: 1,
  });
  assert.equal(fixture.verifiedToken(), "session-token");
});
