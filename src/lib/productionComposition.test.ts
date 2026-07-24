import assert from "node:assert/strict";
import {
  createProductionApp,
  productionAppOptions,
} from "./productionComposition.ts";
import type { SharedNodeWorkspaceSigner } from "./sharedNodeTransport.ts";

Deno.test("production composition leaves commercial routes unmounted by default", () => {
  const app = createProductionApp();
  const paths = app.routes.map((route) => route.path);
  assert.equal(paths.some((path) => path === "/v1/billing/balance"), true);
  assert.equal(
    paths.some((path) => path === "/v1/billing/paypal/orders"),
    false,
  );
  assert.equal(
    paths.some((path) => path.startsWith("/v1/shared-hosting")),
    false,
  );
  assert.equal(paths.some((path) => path.startsWith("/v1/ai")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/modpack")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/sessions")), true);
});

Deno.test("production composition always disables routes without durable adapters", () => {
  assert.deepEqual(productionAppOptions(), {
    commercialRoutes: false,
    billingRoutes: true,
    paymentRoutes: false,
    sharedNodeTransportRoutes: false,
  });
});

Deno.test("production composition mounts only the authenticated node transport for complete settings", () => {
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
    XMCL_SHARED_QUOTA_HELPER_RELEASE_URL:
      "https://release.example/quota-helper",
    XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256: "b".repeat(64),
    XMCL_CONTROL_PLANE_URL: "https://api.example",
    XMCL_VULTR_OBJECT_STORAGE_ENDPOINT: "https://sgp1.vultrobjects.com",
    XMCL_VULTR_OBJECT_STORAGE_REGION: "sgp",
    XMCL_VULTR_OBJECT_STORAGE_BUCKET: "shared",
    XMCL_SHARED_NODE_CONTAINER_IMAGE: "ghcr.io/voxelum/xmcl-shared-minecraft-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    VULTR_SHARED_NODE_BLOCK_STORAGE_GIB: "192",
    VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE: "high_perf",
    VULTR_SHARED_NODE_FIREWALL_GROUP_ID: "firewall-group-1",
    XMCL_SHARED_NODE_INGRESS_PORT_MIN: "25565",
    XMCL_SHARED_NODE_INGRESS_PORT_MAX: "25665",
  };
  assert.equal(
    productionAppOptions(config).sharedNodeTransportRoutes,
    false,
  );
  const signer = {
    presign: async (key, method, expiresInSeconds) => ({
      key,
      method,
      url: `https://sgp1.vultrobjects.com/shared/${key}?grant=only`,
      expiresAt: new Date(
        Date.now() + expiresInSeconds * 1_000,
      ).toISOString(),
    }),
  } satisfies SharedNodeWorkspaceSigner;
  assert.equal(
    productionAppOptions(
      { ...config, VULTR_SHARED_NODE_BLOCK_STORAGE_GIB: "0" },
      { SHARED_NODE_WORKSPACE_SIGNER: signer },
    ).sharedNodeTransportRoutes,
    false,
  );
  assert.equal(
    productionAppOptions(
      { ...config, VULTR_SHARED_NODE_BLOCK_STORAGE_GIB: "127" },
      { SHARED_NODE_WORKSPACE_SIGNER: signer },
    ).sharedNodeTransportRoutes,
    false,
  );
  assert.equal(
    productionAppOptions(
      { ...config, VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE: "standard" },
      { SHARED_NODE_WORKSPACE_SIGNER: signer },
    ).sharedNodeTransportRoutes,
    false,
  );
  for (
    const invalidSetting of [
      { VULTR_SHARED_NODE_REGION_ID: undefined },
      { VULTR_SHARED_NODE_REGION_ID: "SGP" },
      { VULTR_SHARED_NODE_REGION_ID: "sgp!" },
      { VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: undefined },
      { VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: "0" },
      { VULTR_SHARED_NODE_TOTAL_MEMORY_MIB: "16384.5" },
      { VULTR_SHARED_NODE_TOTAL_SHARED_CPU: undefined },
      { VULTR_SHARED_NODE_TOTAL_SHARED_CPU: "-6" },
      { VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB: undefined },
      { VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB: "0" },
      { VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB: "128GiB" },
      { VULTR_SHARED_NODE_FIREWALL_GROUP_ID: undefined },
      { VULTR_SHARED_NODE_FIREWALL_GROUP_ID: "not a provider id" },
      { XMCL_SHARED_NODE_INGRESS_PORT_MIN: undefined },
      { XMCL_SHARED_NODE_INGRESS_PORT_MAX: "65536" },
      {
        XMCL_SHARED_NODE_INGRESS_PORT_MIN: "25665",
        XMCL_SHARED_NODE_INGRESS_PORT_MAX: "25565",
      },
    ]
  ) {
    assert.equal(
      productionAppOptions(
        { ...config, ...invalidSetting },
        { SHARED_NODE_WORKSPACE_SIGNER: signer },
      ).sharedNodeTransportRoutes,
      false,
    );
  }
  const app = createProductionApp(undefined, config, {
    SHARED_NODE_WORKSPACE_SIGNER: signer,
  });
  const paths = app.routes.map((route) => route.path);
  assert.equal(
    paths.includes("/v1/internal/shared-nodes/register"),
    true,
  );
  assert.equal(
    paths.some((path) => path.startsWith("/v1/shared-hosting")),
    false,
  );
});
