import assert from "node:assert/strict";
import {
  type CreateLightNodeInstance,
  LightNodeError,
  LightNodeOpenApiClient,
} from "./lightnode.ts";

function response(body: unknown, status = 200) {
  return Promise.resolve(Response.json(body, { status }));
}

const createInput: CreateLightNodeInstance = {
  packageCode: "moscow-c4m8-s50-d100",
  regionCode: "ru-moscow-1",
  zoneCode: "ru-moscow-1-a",
  instanceName: "xmcl-mow-capacity-1",
  imageResourceUUID: "img-mow-agent",
  firewallUUID: "fw-mow-xmcl",
  sshKeyUUID: "key-xmcl-operator",
};

function packageBody(input = createInput) {
  return {
    packages: [{
      packageCode: input.packageCode,
      regionCode: input.regionCode,
      zoneCode: input.zoneCode,
      cpu: 4,
      memory: 8,
      systemDiskSize: 50,
      dataDiskSize: 100,
      bandwidth: 100,
      freeFlow: 2000,
      publicIpChargeMode: "PayByTraffic",
    }],
  };
}

function imageBody(input = createInput) {
  return {
    rowCount: 1,
    images: [{
      imageResourceUUID: input.imageResourceUUID,
      imageName: "xmcl-shared-node",
      imageType: "Self",
      osVersion: "linux",
      osVersionDetail: "Debian 12",
    }],
  };
}

function firewallBody(input = createInput) {
  return {
    rowCount: 1,
    firewalls: [{
      firewallUUID: input.firewallUUID,
      firewallName: "xmcl-shared-node",
      firewallStatus: "AVAILABLE",
      regionCode: input.regionCode,
    }],
  };
}

function instanceBody(input = createInput) {
  return {
    ecsResourceUUID: "ecs-mow-node-1",
    instanceName: input.instanceName,
    regionCode: input.regionCode,
    zoneCode: input.zoneCode,
    cpu: 4,
    memory: 8,
    systemDiskSize: 50,
    dataDiskSize: 100,
    ecsStatus: "STARTED",
    ecsPendingStatus: "NONE",
    publicIpAddress: "203.0.113.10",
    imageResourceUUID: input.imageResourceUUID,
  };
}

Deno.test("LightNode client validates official Moscow and Taiwan region codes", async () => {
  const headers: string[] = [];
  const client = new LightNodeOpenApiClient({
    token: "secret-token",
    fetch: (_input, init) => {
      headers.push(new Headers(init?.headers).get("x-open-token") ?? "");
      return response({
        regions: [
          {
            regionCode: "ru-moscow-1",
            regionName: "Moscow",
            zones: [{
              zoneCode: "ru-moscow-1-a",
              zoneName: "Zone A",
            }],
          },
          {
            regionCode: "cn-taiwan-2",
            regionName: "Taiwan",
            zones: [{
              zoneCode: "cn-taiwan-2-a",
              zoneName: "Zone A",
            }],
          },
        ],
      });
    },
  });

  assert.deepEqual(await client.validateMvpRegion("mow"), {
    regionCode: "ru-moscow-1",
    zoneCode: "ru-moscow-1-a",
  });
  assert.deepEqual(await client.validateMvpRegion("tpe"), {
    regionCode: "cn-taiwan-2",
    zoneCode: "cn-taiwan-2-a",
  });
  assert.deepEqual(headers, ["secret-token", "secret-token"]);
});

Deno.test("LightNode client rejects an unavailable documented MVP region", async () => {
  const client = new LightNodeOpenApiClient({
    token: "secret-token",
    fetch: () => response({ regions: [] }),
  });

  await assert.rejects(
    () => client.validateMvpRegion("tpe"),
    (error) =>
      error instanceof LightNodeError &&
      error.code === "capacity_unavailable" &&
      error.outcome === "definitive",
  );
});

Deno.test("LightNode client validates provider resources and completes async creation", async () => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const client = new LightNodeOpenApiClient({
    token: "secret-token",
    pollIntervalMs: 1,
    sleep: async () => {},
    fetch: (input, init) => {
      const url = new URL(input.toString());
      requests.push({ url, init });
      if (url.pathname === "/package/list") return response(packageBody());
      if (url.pathname === "/image/list") return response(imageBody());
      if (url.pathname === "/firewall/list") return response(firewallBody());
      if (url.pathname === "/instance/list") {
        return response({ instances: [], rowCount: 0, success: true });
      }
      if (url.pathname === "/instance/create") {
        return response({
          asyncTaskInfo: {
            asyncTaskUUID: "task-create-1",
            ecsResourceUUID: "ecs-mow-node-1",
          },
        }, 202);
      }
      if (url.pathname === "/asynctask/getResult") {
        return response({
          asyncTaskInfo: {
            taskStatus: "FINISHED",
            processResult: "SUCCESS",
          },
        }, 202);
      }
      if (url.pathname === "/instance/detail") {
        return response({ instance: instanceBody() });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const created = await client.createInstance(createInput);

  assert.equal(created.id, "ecs-mow-node-1");
  assert.equal(created.dataDiskGiB, 100);
  const create = requests.find((request) =>
    request.url.pathname === "/instance/create"
  );
  assert(create?.init?.body);
  const body = JSON.parse(String(create.init.body));
  assert.equal(body.packageConfig.regionCode, "ru-moscow-1");
  assert.equal(body.packageConfig.sshKeyUUID, "key-xmcl-operator");
  assert.equal("userData" in body.packageConfig, false);
  assert.equal(
    new Headers(create.init.headers).get("x-open-token"),
    "secret-token",
  );
});

Deno.test("LightNode client reconciles by deterministic name after an unknown create", async () => {
  let createAttempts = 0;
  let listAttempts = 0;
  const client = new LightNodeOpenApiClient({
    token: "secret-token",
    fetch: (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/package/list") return response(packageBody());
      if (url.pathname === "/image/list") return response(imageBody());
      if (url.pathname === "/firewall/list") return response(firewallBody());
      if (url.pathname === "/instance/list") {
        listAttempts += 1;
        return response({
          instances: listAttempts === 1 ? [] : [instanceBody()],
          rowCount: listAttempts === 1 ? 0 : 1,
          success: true,
        });
      }
      if (url.pathname === "/instance/create") {
        createAttempts += 1;
        return Promise.reject(new TypeError("connection reset"));
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const reconciled = await client.createInstance(createInput);

  assert.equal(reconciled.id, "ecs-mow-node-1");
  assert.equal(createAttempts, 1);
  assert.equal(listAttempts, 2);
});

Deno.test("LightNode client treats delete of a missing instance as idempotent", async () => {
  let releases = 0;
  const client = new LightNodeOpenApiClient({
    token: "secret-token",
    fetch: (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/instance/detail") {
        return response({ error: "not found" }, 404);
      }
      if (url.pathname === "/instance/release") releases += 1;
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await client.deleteInstance("ecs-missing");

  assert.equal(releases, 0);
});
