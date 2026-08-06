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
  region: "sgp",
  plan: "vc2-2c-4gb",
  label: "server_fixture",
  status: "active",
  power_status: "running",
  server_status: "ok",
  main_ip: "203.0.113.9",
  firewall_group_id: "firewall-group-1",
};

Deno.test("Vultr v2 adapter validates configured region allowlists and reconciles an unknown create by XMCL label", async () => {
  const requests: Request[] = [];
  let postAttempts = 0;
  const adapter = new VultrV2Adapter({
    token: "vultr-secret-token",
    regionId: "sgp",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/regions")) {
        return Promise.resolve(response({ regions: [{ id: "sgp" }] }));
      }
      if (url.pathname.endsWith("/plans")) {
        return Promise.resolve(response({
          plans: [{
            id: "vc2-2c-4gb",
            locations: ["sgp"],
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
    firewallGroupId: "firewall-group-1",
  });
  assert.equal(instance.id, "provider-instance-secret");
  assert.equal(instance.firewallGroupId, "firewall-group-1");
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
  assert.equal(body.firewall_group_id, "firewall-group-1");
  assert.equal(body.enable_ipv6, false);
});

Deno.test("Vultr errors are sanitized and definitive create failures are not retried or reconciled", async () => {
  let createCalls = 0;
  let listCalls = 0;
  const adapter = new VultrV2Adapter({
    token: "never-expose-this-token",
    regionId: "sgp",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/regions")) {
        return Promise.resolve(response({ regions: [{ id: "sgp" }] }));
      }
      if (url.pathname.endsWith("/plans")) {
        return Promise.resolve(response({
          plans: [{
            id: "vc2-2c-4gb",
            locations: ["sgp"],
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
    regionId: "sgp",
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

Deno.test("Vultr Block Storage uses the documented lifecycle endpoints and payload fields", async () => {
  const requests: Request[] = [];
  const blockStorage = {
    id: "volume_1",
    region: "sgp",
    size_gb: 192,
    label: "xmcl-shared-volume-request_1",
    block_type: "high_perf",
    status: "active",
    attached_to_instance: null,
  };
  const adapter = new VultrV2Adapter({
    token: "vultr-secret-token",
    regionId: "sgp",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/block-storage")) {
        return Promise.resolve(response({ block_storage: blockStorage }));
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/block-storage/volume_1")
      ) {
        return Promise.resolve(response({ block_storage: blockStorage }));
      }
      if (
        request.method === "GET" && url.pathname.endsWith("/block-storage") &&
        url.searchParams.get("label") === blockStorage.label
      ) {
        return Promise.resolve(response({ block_storages: [blockStorage] }));
      }
      if (
        request.method === "POST" &&
        (url.pathname.endsWith("/attach") || url.pathname.endsWith("/detach"))
      ) {
        return Promise.resolve(response(undefined, 204));
      }
      if (request.method === "DELETE") {
        return Promise.resolve(response(undefined, 204));
      }
      return Promise.reject(new Error(`unexpected ${request.method} ${url}`));
    },
  });

  const created = await adapter.createVolume({
    region: "sgp",
    sizeGiB: 192,
    label: blockStorage.label,
    blockType: "high_perf",
  });
  assert.equal(created.id, "volume_1");
  assert.equal((await adapter.getVolume("volume_1"))?.sizeGiB, 192);
  assert.equal((await adapter.reconcileVolume(blockStorage.label))?.label, blockStorage.label);
  await adapter.attachVolume("volume_1", "instance_1");
  await adapter.detachVolume("volume_1");
  await adapter.deleteVolume("volume_1");

  const createRequest = requests.find((request) =>
    request.method === "POST" &&
    new URL(request.url).pathname.endsWith("/block-storage")
  );
  assert.deepEqual(await createRequest?.clone().json(), {
    region: "sgp",
    size_gb: 192,
    label: blockStorage.label,
    block_type: "high_perf",
  });
  await assert.rejects(
    () => adapter.createVolume({
      region: "ewr",
      sizeGiB: 192,
      label: blockStorage.label,
      blockType: "high_perf",
    }),
    (error) =>
      error instanceof VultrError &&
      error.code === "provider_rejected" &&
      error.outcome === "definitive",
  );
  const attachRequest = requests.find((request) =>
    new URL(request.url).pathname.endsWith("/attach")
  );
  assert.deepEqual(await attachRequest?.clone().json(), {
    instance_id: "instance_1",
    live: true,
  });
  const detachRequest = requests.find((request) =>
    new URL(request.url).pathname.endsWith("/detach")
  );
  assert.deepEqual(await detachRequest?.clone().json(), { live: false });
});

Deno.test("Vultr Block Storage malformed responses fail closed", async () => {
  const adapter = new VultrV2Adapter({
    token: "token",
    regionId: "sgp",
    allowedPlans: ["vc2-2c-4gb"],
    imageId: "1743",
    fetch: () => Promise.resolve(response({
      block_storage: {
        id: "volume_1",
        region: "sgp",
        size_gb: 192,
        label: "xmcl-shared-volume-request_1",
        block_type: "high_perf",
        status: "active",
      },
    })),
  });

  await assert.rejects(
    () => adapter.getVolume("volume_1"),
    (error) =>
      error instanceof VultrError &&
      error.code === "invalid_provider_response" &&
      error.outcome === "unknown",
  );
  await assert.rejects(
    () => adapter.reconcileVolume("xmcl-shared-volume-request_1"),
    (error) =>
      error instanceof VultrError &&
      error.code === "invalid_provider_response" &&
      error.outcome === "unknown",
  );
});
