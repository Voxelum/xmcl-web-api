import assert from "node:assert/strict";
import type { Db } from "./db.ts";
import {
  createSharedHostingRuntime,
  hasSharedNodeSettings,
  sharedNodeCapacityModeFromConfig,
  sharedNodeProfileFromConfig,
  sharedNodeRegionsFromConfig,
} from "./sharedHostingRuntime.ts";

const config = {
  BILLING_RATES_JSON: "[]",
  VULTR_API_TOKEN: "provider-token",
  VULTR_SHARED_NODE_REGION_ID: "sgp",
  VULTR_SHARED_NODE_PLAN: "vc2-6c-16gb",
  VULTR_SHARED_NODE_IMAGE_ID: "1743",
  VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: "16384",
  VULTR_SHARED_NODE_TOTAL_SHARED_CPU: "6",
  VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB: "128",
  XMCL_SHARED_AGENT_RELEASE_URL: "https://release.example/agent",
  XMCL_SHARED_AGENT_RELEASE_SHA256: "a".repeat(64),
  XMCL_SHARED_QUOTA_HELPER_RELEASE_URL: "https://release.example/quota-helper",
  XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256: "b".repeat(64),
  XMCL_CONTROL_PLANE_URL: "https://api.example",
  XMCL_AZURE_BLOB_ENDPOINT: "https://xmclcampstaging.blob.core.windows.net",
  XMCL_AZURE_BLOB_CONTAINER: "shared",
  XMCL_SHARED_NODE_CONTAINER_IMAGE:
    "ghcr.io/voxelum/xmcl-shared-minecraft-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  VULTR_SHARED_NODE_BLOCK_STORAGE_GIB: "192",
  VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE: "high_perf",
  VULTR_SHARED_NODE_FIREWALL_GROUP_ID: "firewall-group-1",
  XMCL_SHARED_NODE_INGRESS_PORT_MIN: "25565",
  XMCL_SHARED_NODE_INGRESS_PORT_MAX: "25665",
};

Deno.test("shared-node production profile uses configured machine capacities", () => {
  assert.deepEqual(sharedNodeProfileFromConfig(config), {
    profileId: "shared-vc2-6c-16gb-16384m-6c-128g",
    providerPlan: "vc2-6c-16gb",
    workloadClasses: ["standard", "large"],
    totalMemoryMiB: 16384,
    totalSharedCpu: 6,
    totalWorkspaceGiB: 128,
  });

  assert.equal(hasSharedNodeSettings(config), true);
});

Deno.test("shared-node runtime accepts an explicit unique regional pool set", () => {
  assert.deepEqual(
    sharedNodeRegionsFromConfig({
      ...config,
      VULTR_SHARED_NODE_REGION_IDS: "sgp,nrt,ams",
    }),
    ["sgp", "nrt", "ams"],
  );
  assert.equal(
    hasSharedNodeSettings({
      ...config,
      VULTR_SHARED_NODE_REGION_IDS: "sgp,nrt,ams",
    }),
    true,
  );
  for (const invalid of ["sgp,sgp", "sgp,hkg", ""]) {
    assert.equal(
      sharedNodeRegionsFromConfig({
        ...config,
        VULTR_SHARED_NODE_REGION_IDS: invalid,
      }),
      undefined,
    );
  }
});

Deno.test("shared-node runtime supports a preprovisioned LightNode Moscow and Taipei pool", () => {
  const lightNode = {
    BILLING_RATES_JSON: "[]",
    XMCL_SHARED_NODE_CAPACITY_MODE: "preprovisioned" as const,
    XMCL_SHARED_NODE_REGION_IDS: "mow,tpe",
    XMCL_AZURE_BLOB_ENDPOINT: "https://xmclcampstaging.blob.core.windows.net",
    XMCL_AZURE_BLOB_CONTAINER: "shared",
    XMCL_SHARED_NODE_INGRESS_PORT_MIN: "25565",
    XMCL_SHARED_NODE_INGRESS_PORT_MAX: "25665",
  };

  assert.equal(sharedNodeCapacityModeFromConfig(lightNode), "preprovisioned");
  assert.deepEqual(sharedNodeRegionsFromConfig(lightNode), ["mow", "tpe"]);
  assert.equal(hasSharedNodeSettings(lightNode), true);
  const runtime = createSharedHostingRuntime({
    collection: () => ({}),
  } as unknown as Db, lightNode);
  assert.equal(runtime.scheduler.isPoolRegion("mow"), true);
  assert.equal(runtime.scheduler.isPoolRegion("tpe"), true);
  assert.equal(runtime.scheduler.isPoolRegion("sgp"), false);
  assert.equal(
    hasSharedNodeSettings({
      ...lightNode,
      XMCL_SHARED_NODE_CAPACITY_MODE: "automatic" as never,
    }),
    false,
  );
});

Deno.test("shared-node production settings reject missing and invalid capacities", () => {
  for (
    const invalidCapacity of [
      { VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: undefined },
      { VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: "16.5" },
      { VULTR_SHARED_NODE_TOTAL_SHARED_CPU: "0" },
      { VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB: "128 GiB" },
    ]
  ) {
    assert.equal(
      hasSharedNodeSettings({ ...config, ...invalidCapacity }),
      false,
    );
    assert.equal(
      sharedNodeProfileFromConfig({ ...config, ...invalidCapacity }),
      undefined,
    );
  }
  assert.equal(
    hasSharedNodeSettings({
      ...config,
      XMCL_SHARED_NODE_CONTAINER_IMAGE: "itzg/minecraft-server:latest",
    }),
    false,
  );
});
