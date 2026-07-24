import assert from "node:assert/strict";
import {
  hasSharedNodeSettings,
  sharedNodeProfileFromConfig,
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
  XMCL_VULTR_OBJECT_STORAGE_ENDPOINT: "https://sgp1.vultrobjects.com",
  XMCL_VULTR_OBJECT_STORAGE_REGION: "sgp",
  XMCL_VULTR_OBJECT_STORAGE_BUCKET: "shared",
  XMCL_SHARED_NODE_CONTAINER_IMAGE: "ghcr.io/voxelum/xmcl:stable",
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
    totalMemoryMiB: 16384,
    totalSharedCpu: 6,
    totalWorkspaceGiB: 128,
  });
  assert.equal(hasSharedNodeSettings(config), true);
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
});
