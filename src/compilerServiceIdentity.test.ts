import assert from "node:assert/strict";
import type { Db } from "./db.ts";
import {
  HmacCompilerServiceIdentity,
  MongoCompilerNonceStore,
} from "./compilerServiceIdentity.ts";

const now = 1_785_000_000_000;
const secret = "compiler-identity-secret-at-least-thirty-two-bytes";

class DurableNonceStore {
  readonly durable = true as const;
  private readonly entries = new Map<string, number>();

  async consume(input: { key: string; expiresAt: number; now: number }) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= input.now) this.entries.delete(key);
    }
    if (this.entries.has(input.key)) return false;
    this.entries.set(input.key, input.expiresAt);
    return true;
  }
}

function identity(store = new DurableNonceStore()) {
  return new HmacCompilerServiceIdentity({
    keyId: "compiler-v1",
    secret,
    nonceStore: store,
    now: () => now,
  });
}

Deno.test("compiler HMAC identity binds canonical method, target, and exact raw body", async () => {
  const signer = identity();
  const verifier = identity();
  const body = new TextEncoder().encode('{"schemaVersion":1,"x":"exact"}');
  const headers = await signer.signOutgoing({
    method: "POST",
    target: "/v1/compiler-jobs?queue=primary",
    body,
  });

  await verifier.verifyIncoming({
    method: "POST",
    target: "/v1/compiler-jobs?queue=primary",
    headers,
    body,
  });
  await assert.rejects(
    () => identity().verifyIncoming({
      method: "POST",
      target: "/v1/compiler-jobs?queue=secondary",
      headers,
      body,
    }),
    /request_identity_rejected/,
  );
  await assert.rejects(
    () => identity().verifyIncoming({
      method: "POST",
      target: "/v1/compiler-jobs?queue=primary",
      headers,
      body: new TextEncoder().encode('{"x":"exact","schemaVersion":1}'),
    }),
    /request_identity_rejected/,
  );
});

Deno.test("compiler HMAC identity accepts the compiler service-identity canonical vector", async () => {
  const verifier = new HmacCompilerServiceIdentity({
    keyId: "compiler-v1",
    secret: "01234567890123456789012345678901",
    nonceStore: new DurableNonceStore(),
    now: () => now,
  });
  await verifier.verifyIncoming({
    method: "POST",
    target: "/v1/compiler-jobs?x=1",
    headers: {
      authorization: "HMAC compiler-v1:KIn-qd9QE5g8HfXXfKueY0YGmAwqZNOGVBsiibyDGCY",
      "x-xmcl-timestamp": String(now),
      "x-xmcl-nonce": "abcdefghijklmnop",
    },
    body: new TextEncoder().encode('{"a":1}'),
  });
});

Deno.test("compiler HMAC identity rejects a valid replay with durable nonce state", async () => {
  const store = new DurableNonceStore();
  const signer = identity();
  const verifier = identity(store);
  const body = new TextEncoder().encode("{}");
  const headers = await signer.signOutgoing({
    method: "POST",
    target: "/v1/internal/shared-runtime-compiler/deployments/deployment_1/failed",
    body,
  });
  const request = {
    method: "POST",
    target: "/v1/internal/shared-runtime-compiler/deployments/deployment_1/failed",
    headers,
    body,
  };
  await verifier.verifyIncoming(request);
  await assert.rejects(() => verifier.verifyIncoming(request), /request_replayed/);
});

Deno.test("Mongo compiler nonce store atomically accepts one concurrent use", async () => {
  const values = new Map<string, { expiresAt: number }>();
  const db = {
    collection: () => ({
      async deleteOne(filter: { _id: string; expiresAt: { $lte: number } }) {
        const current = values.get(filter._id);
        if (current && current.expiresAt <= filter.expiresAt.$lte) {
          values.delete(filter._id);
        }
        return {};
      },
      async updateOne(
        filter: { _id: string },
        update: { $setOnInsert: { expiresAt: number } },
      ) {
        if (values.has(filter._id)) return { upsertedCount: 0 };
        values.set(filter._id, { expiresAt: update.$setOnInsert.expiresAt });
        return { upsertedCount: 1 };
      },
    }),
  } as unknown as Db;
  const store = new MongoCompilerNonceStore(db);
  const consumed = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.consume({ key: "compiler-v1:nonce_0123456789", expiresAt: now + 60_000, now })
    ),
  );
  assert.equal(consumed.filter(Boolean).length, 1);
});
