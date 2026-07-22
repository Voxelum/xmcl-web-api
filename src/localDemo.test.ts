import assert from "node:assert/strict";
import {
  createLocalDemoApp,
  DEMO_SERVER_ID,
  LOCAL_DEMO_CREDENTIALS,
  LOCAL_DEMO_PROFILE,
} from "./localDemo.ts";

function headers() {
  return {
    authorization: `Bearer ${LOCAL_DEMO_CREDENTIALS.userAccessToken}`,
    "content-type": "application/json",
  };
}

Deno.test("local demo exposes only its explicit profile and deterministic credentials", async () => {
  const { app } = await createLocalDemoApp();

  const profile = await app.request("/__local-demo");
  assert.equal(profile.status, 200);
  const body = await profile.json();
  assert.equal(body.profile, LOCAL_DEMO_PROFILE);
  assert.equal(
    body.credentials.workerBootstrapCredential,
    LOCAL_DEMO_CREDENTIALS.workerBootstrapCredential,
  );

  const account = await app.request("/v1/account", { headers: headers() });
  assert.equal(account.status, 200);
  assert.equal((await account.json()).accountId, "demo-user");
});

Deno.test("local demo has in-memory idempotency for server and payment APIs", async () => {
  const { app } = await createLocalDemoApp();

  const create = {
    method: "POST",
    headers: { ...headers(), "idempotency-key": "local-demo-server" },
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  };
  const first = await app.request("/v1/servers", create);
  const second = await app.request("/v1/servers", create);
  assert.equal(first.status, 202);
  assert.deepEqual(await second.json(), await first.json());

  const conflict = await app.request("/v1/servers", {
    ...create,
    body: JSON.stringify({ plan: "vc2-4c-8gb" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");

  const order = {
    method: "POST",
    headers: { ...headers(), "idempotency-key": "local-demo-order" },
    body: JSON.stringify({ amountMinor: 100 }),
  };
  assert.equal(
    (await app.request("/v1/billing/paypal/orders", order)).status,
    201,
  );
  assert.equal(
    (await app.request("/v1/billing/paypal/orders", order)).status,
    201,
  );

  const server = await app.request(`/v1/servers/${DEMO_SERVER_ID}`, {
    headers: headers(),
  });
  assert.equal(server.status, 200);
});
