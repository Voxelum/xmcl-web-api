import assert from "node:assert/strict";
import { createAzureHttpApp } from "./httpApp.ts";
import {
  compilerControlPlaneSettings,
  createAzureCompilerControlPlane,
} from "./compilerControlPlane.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";

const config = {
  MONGO_CONNECION_STRING: "mongodb://user:password@mongo.example/control",
  BILLING_RATES_JSON: "[]",
  CURSEFORGE_KEY: "server-only-curseforge-key",
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
  XMCL_CONTROL_PLANE_URL: "https://control.example",
  XMCL_VULTR_OBJECT_STORAGE_ENDPOINT: "https://sgp1.vultrobjects.com",
  XMCL_VULTR_OBJECT_STORAGE_REGION: "sgp",
  XMCL_VULTR_OBJECT_STORAGE_BUCKET: "shared",
  XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY: "access-key",
  XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY: "secret-key",
  XMCL_SHARED_NODE_CONTAINER_IMAGE:
    "ghcr.io/voxelum/xmcl-shared-minecraft-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  VULTR_SHARED_NODE_BLOCK_STORAGE_GIB: "192",
  VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE: "high_perf",
  VULTR_SHARED_NODE_FIREWALL_GROUP_ID: "firewall-group-1",
  XMCL_SHARED_NODE_INGRESS_PORT_MIN: "25565",
  XMCL_SHARED_NODE_INGRESS_PORT_MAX: "25665",
  XMCL_SHARED_COMPILER_ENDPOINT: "https://compiler.example/v1/compiler-jobs",
  XMCL_SHARED_COMPILER_KEY_ID: "compiler-v1",
  XMCL_SHARED_COMPILER_HMAC_SECRET:
    "compiler-identity-secret-at-least-thirty-two-bytes",
  XMCL_SHARED_COMPILER_TIMEOUT_MS: "120000",
  XMCL_SHARED_COMPILER_REVIEWED_IMAGE:
    "ghcr.io/voxelum/xmcl-shared-minecraft-compiler@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  XMCL_SHARED_RUNTIME_TERMS_VERSION: "minecraft-eula-v1",
};

Deno.test("Azure compiler composition fails closed for incomplete or unsafe settings", () => {
  assert.equal(
    compilerControlPlaneSettings({
      ...config,
      XMCL_SHARED_COMPILER_HMAC_SECRET: undefined,
    }),
    undefined,
  );
  assert.equal(
    compilerControlPlaneSettings({
      ...config,
      XMCL_SHARED_COMPILER_ENDPOINT: "http://compiler.example/v1/compiler-jobs",
    }),
    undefined,
  );
  const signer = createS3SigV4Presigner({
    endpoint: config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: config.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: config.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: config.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: config.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
  assert.equal(
    createAzureCompilerControlPlane(
      { ...config, XMCL_SHARED_RUNTIME_TERMS_VERSION: undefined },
      signer,
    ),
    undefined,
  );
});

Deno.test("Azure mounts only authenticated compiler callbacks, never public shared modpack routes", () => {
  const complete = createAzureHttpApp(config);
  const completePaths = complete.routes.map((route) => route.path);
  assert.equal(
    completePaths.includes(
      "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/grants",
    ),
    true,
  );
  assert.equal(
    completePaths.includes(
      "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/published",
    ),
    true,
  );
  assert.equal(
    completePaths.includes(
      "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/upload-prepared",
    ),
    true,
  );
  assert.equal(
    completePaths.includes(
      "/v1/internal/shared-runtime-compiler/deployments/:deploymentId/failed",
    ),
    true,
  );
  assert.equal(
    completePaths.some((path) =>
      path.startsWith("/v1/shared-hosting/services") ||
      path.startsWith("/v1/shared-hosting/modpack")
    ),
    false,
  );
  const incomplete = createAzureHttpApp({
    ...config,
    XMCL_SHARED_COMPILER_REVIEWED_IMAGE: undefined,
  });
  assert.equal(
    incomplete.routes.some((path) =>
      path.path.startsWith("/v1/internal/shared-runtime-compiler")
    ),
    false,
  );
});
