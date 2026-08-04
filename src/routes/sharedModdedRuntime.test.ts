import assert from "node:assert/strict";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { AccountError } from "../lib/account.ts";
import {
  createSharedModdedCompilerRoutes,
  createSharedModdedRuntimeRoutes,
} from "./sharedModdedRuntime.ts";

const resolver = async () =>
  ({
    sessions: {
      verify(token: string) {
        if (token === "write") {
          return Promise.resolve({
            sessionId: "session_1",
            familyId: "family_1",
            accountId: "account_1",
            scopes: ["account:read", "modpack:write"],
            issuedAt: "2026-07-25T00:00:00.000Z",
            expiresAt: "2026-07-26T00:00:00.000Z",
          });
        }
        if (token === "read") {
          return Promise.resolve({
            sessionId: "session_1",
            familyId: "family_1",
            accountId: "account_1",
            scopes: ["account:read"],
            issuedAt: "2026-07-25T00:00:00.000Z",
            expiresAt: "2026-07-26T00:00:00.000Z",
          });
        }
        throw new AccountError(401, "authentication_required");
      },
    },
  }) as unknown as AccountRuntime;

function request(path: string, token?: string) {
  return new Request(`http://shared-runtime.test${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": "test-key",
    },
  });
}

Deno.test(
  "shared modded account routes authenticate non-service endpoints and callbacks fail closed",
  async () => {
    const accountRoutes = createSharedModdedRuntimeRoutes(undefined, resolver);
    const path = "/v1/shared-hosting/modpack-imports/import_1/upload-url";

    const anonymous = await accountRoutes.request(request(path));
    assert.equal(anonymous.status, 401);

    const readOnly = await accountRoutes.request(request(path, "read"));
    assert.equal(readOnly.status, 403);
    assert.equal((await readOnly.json()).error, "insufficient_scope");

    const unavailable = await accountRoutes.request(request(path, "write"));
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, "compiler_unavailable");

    const callbacks = createSharedModdedCompilerRoutes();
    const callback = await callbacks.request(
      new Request(
        "http://shared-runtime.test/v1/internal/shared-runtime-compiler/deployments/deployment_1/grants",
        { method: "POST" },
      ),
    );
    assert.equal(callback.status, 401);
    assert.equal((await callback.json()).error, "unauthorized");
  },
);
