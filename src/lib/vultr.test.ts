import assert from "node:assert/strict";
import { VultrError, VultrV2Adapter } from "./vultr.ts";

function response(body: unknown, status = 200) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const providerInstance = {
  id: "provider-instance-secret",
  region: "tpe",
  plan: "vc2-2c-4gb",
  label: "server_fixture",
  status: "active",
  power_status: "running",
  server_status: "ok",
  main_ip: "203.0.113.9",
};

Deno.test("Vultr v2 adapter validates Taipei allowlists and reconciles an unknown create by XMCL label", async () => {
  const requests: Request[] = [];
  let postAttempts = 0;
  const adapter = new VultrV2Adapter({
    token: "vultr-secret-token",
    taipeiRegionId: "tpe",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/regions")) {
        return Promise.resolve(response({ regions: [{ id: "tpe" }] }));
      }
      if (url.pathname.endsWith("/plans")) {
        return Promise.resolve(response({
          plans: [{
            id: "vc2-2c-4gb",
            locations: ["tpe"],
            type: "vc2",
          }],
        }));
      }
      if (request.method === "POST" && url.pathname.endsWith("/instances")) {
        postAttempts += 1;
        return Promise.reject(new TypeError("connection reset after request"));
      }
      if (
        request.method === "GET" && url.pathname.endsWith("/instances") &&
        url.searchParams.get("label") === "server_fixture"
      ) {
        return Promise.resolve(response({ instances: [providerInstance] }));
      }
      return Promise.reject(
        new Error(`unexpected ${request.method} ${url}`),
      );
    },
  });

  const instance = await adapter.createInstance({
    serverId: "server_fixture",
    plan: "vc2-2c-4gb",
    userData: "#cloud-config",
  });
  assert.equal(instance.id, "provider-instance-secret");
  assert.equal(postAttempts, 1);
  assert.ok(
    requests.every((request) =>
      request.headers.get("authorization") === "Bearer vultr-secret-token"
    ),
  );
  const createRequest = requests.find((request) => request.method === "POST");
  assert.ok(createRequest);
  const body = await createRequest.clone().json();
  assert.equal(body.label, "server_fixture");
  assert.deepEqual(body.tags, ["xmcl-server:server_fixture"]);
});

Deno.test("Vultr errors are sanitized and definitive create failures are not retried or reconciled", async () => {
  let createCalls = 0;
  let listCalls = 0;
  const adapter = new VultrV2Adapter({
    token: "never-expose-this-token",
    taipeiRegionId: "tpe",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/regions")) {
        return Promise.resolve(response({ regions: [{ id: "tpe" }] }));
      }
      if (url.pathname.endsWith("/plans")) {
        return Promise.resolve(response({
          plans: [{
            id: "vc2-2c-4gb",
            locations: ["tpe"],
            type: "vc2",
          }],
        }));
      }
      if (request.method === "POST") {
        createCalls += 1;
        return Promise.resolve(
          response({ error: "provider account details" }, 400),
        );
      }
      listCalls += 1;
      return Promise.resolve(response({ instances: [] }));
    },
  });

  await assert.rejects(
    () =>
      adapter.createInstance({
        serverId: "server_fixture",
        plan: "vc2-2c-4gb",
        userData: "#cloud-config",
      }),
    (error) => {
      assert.ok(error instanceof VultrError);
      assert.equal(error.code, "provider_rejected");
      assert.equal(error.outcome, "definitive");
      assert.equal(error.message.includes("never-expose"), false);
      assert.equal(error.message.includes("provider account"), false);
      return true;
    },
  );
  assert.equal(createCalls, 1);
  assert.equal(listCalls, 0);
});

Deno.test("Vultr plan allowlist rejects before any provider request", async () => {
  let calls = 0;
  const adapter = new VultrV2Adapter({
    token: "token",
    taipeiRegionId: "tpe",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: () => {
      calls += 1;
      return Promise.resolve(response({}));
    },
  });
  await assert.rejects(
    () => adapter.validateCapacity("gpu-unapproved"),
    (error) =>
      error instanceof VultrError &&
      error.code === "capacity_unavailable",
  );
  assert.equal(calls, 0);
});
