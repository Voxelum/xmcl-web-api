import assert from "node:assert/strict";
import {
  HmacCompilerServiceIdentity,
  type CompilerNonceStore,
} from "./compilerServiceIdentity.ts";
import { HttpSharedModdedCompiler } from "./compilerHttpSubmission.ts";
import type {
  CompilerGrantSet,
  SharedModdedDeployment,
} from "./sharedModdedRuntime.ts";
import {
  CompilerPublicationUncertain,
  CompilerUploadReconciliationUncertain,
  SharedModdedRuntimeError,
} from "./sharedModdedRuntime.ts";

const now = new Date("2026-07-25T08:00:00.000Z");
const secret = "compiler-submission-secret-at-least-thirty-two-bytes";

const deployment = {
  deploymentId: "deployment_1",
  compilerRequestId: "compile_request_1",
  accountId: "account_1",
  serviceId: "service_1",
  importId: "import_1",
  manifestSha256: "a".repeat(64),
  expectedContentKey:
    `shared-hosting/account_1/service_1/compiler-content/${"a".repeat(64)}.tar.zst`,
  frozenManifest: {
    schemaVersion: 1,
    serviceId: "service_1",
    importId: "import_1",
    sourceFormat: "xmcl_server_bundle",
    archive: {
      key: "shared-hosting/account_1/service_1/compiler-inputs/import_1.xmcl-server-bundle",
      sha256: "b".repeat(64),
      sizeBytes: 1024,
    },
    compatibility: {
      minecraftVersion: "1.20.1",
      loader: "fabric",
      loaderVersion: "0.15.11",
      runtimeCatalog: { sha256: "c".repeat(64) },
    },
    configFiles: [],
    dataFiles: [],
    mods: [],
    bundle: { schemaVersion: 1, files: [] },
  },
  status: "compiling",
  idempotencyKey: "deployment",
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
} as SharedModdedDeployment;

const grants: CompilerGrantSet = {
  compilerRequestId: deployment.compilerRequestId,
  accountId: deployment.accountId,
  serviceId: deployment.serviceId,
  deploymentId: deployment.deploymentId,
  manifestSha256: deployment.manifestSha256,
  grants: [{
    key: deployment.frozenManifest.archive.key,
    method: "GET",
    url: "https://storage.example/input",
    expiresAt: "2026-07-25T08:05:00.000Z",
  }, {
    key: deployment.expectedContentKey,
    method: "PUT",
    url: "https://storage.example/output",
    expiresAt: "2026-07-25T08:05:00.000Z",
    headers: {
      "if-none-match": "*",
      "x-ms-blob-type": "BlockBlob",
    },
  }],
};

class Nonces implements CompilerNonceStore {
  readonly durable = true as const;
  async consume() {
    return true;
  }
}

Deno.test("HTTP compiler submission sends a closed versioned envelope with exact grants and HMAC", async () => {
  let captured:
    | { input: URL | RequestInfo; init: RequestInit | undefined }
    | undefined;
  const identity = new HmacCompilerServiceIdentity({
    keyId: "compiler-v1",
    secret,
    nonceStore: new Nonces(),
    now: () => now.getTime(),
  });
  const compiler = new HttpSharedModdedCompiler({
    endpoint: "https://compiler.example/v1/compiler-jobs",
    repository: { getDeployment: async () => deployment },
    grants: { issue: async () => grants },
    identity,
    timeoutMs: 10_000,
    now: () => now,
    fetchImpl: async (input, init) => {
      captured = { input, init };
      return new Response(
        JSON.stringify({ status: "published", deploymentId: deployment.deploymentId }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  await compiler.submit({
    deploymentId: deployment.deploymentId,
    compilerRequestId: deployment.compilerRequestId,
    accountId: deployment.accountId,
    serviceId: deployment.serviceId,
    manifestSha256: deployment.manifestSha256,
    expectedContentKey: deployment.expectedContentKey,
    frozenManifest: deployment.frozenManifest,
  });

  assert.ok(captured);
  assert.equal(String(captured.input), "https://compiler.example/v1/compiler-jobs");
  assert.equal(captured.init?.redirect, "error");
  assert.equal(captured.init?.credentials, "omit");
  const body = captured.init?.body as Uint8Array;
  const raw = body instanceof Uint8Array
    ? body
    : new Uint8Array(await new Response(body).arrayBuffer());
  const verifier = new HmacCompilerServiceIdentity({
    keyId: "compiler-v1",
    secret,
    nonceStore: new Nonces(),
    now: () => now.getTime(),
  });
  await verifier.verifyIncoming({
    method: "POST",
    target: "/v1/compiler-jobs",
    headers: captured.init?.headers as Record<string, string>,
    body: raw,
  });
  const envelope = JSON.parse(new TextDecoder().decode(raw));
  assert.deepEqual(Object.keys(envelope).sort(), [
    "expiresAt",
    "grants",
    "issuedAt",
    "job",
    "requestId",
    "schemaVersion",
  ]);
  assert.equal(envelope.requestId, deployment.compilerRequestId);
  assert.equal(envelope.job.compilerRequestId, deployment.compilerRequestId);
  assert.deepEqual(envelope.grants, grants);
  assert.equal(Date.parse(envelope.expiresAt) - Date.parse(envelope.issuedAt), 300_000);
});

Deno.test("HTTP compiler submission surfaces only an exact uncertain publication for reconciliation", async () => {
  let submissions = 0;
  const compiler = new HttpSharedModdedCompiler({
    endpoint: "https://compiler.example/v1/compiler-jobs",
    repository: { getDeployment: async () => deployment },
    grants: { issue: async () => grants },
    identity: new HmacCompilerServiceIdentity({
      keyId: "compiler-v1",
      secret,
      nonceStore: new Nonces(),
      now: () => now.getTime(),
    }),
    timeoutMs: 10_000,
    now: () => now,
    fetchImpl: async () => {
      submissions++;
      return new Response(JSON.stringify({
        status: "published_callback_uncertain",
        deploymentId: deployment.deploymentId,
        manifestSha256: deployment.manifestSha256,
        content: {
          key: deployment.expectedContentKey,
          sha256: "d".repeat(64),
          compressedSize: 1,
          logicalSize: 1,
          paths: [".xmcl/runtime.json", ".xmcl/launch.sh"],
        },
        descriptor: {
          schemaVersion: 1,
          minecraftVersion: "1.20.1",
          java: { component: "java-runtime-gamma", major: 17 },
          runtimeCatalog: { sha256: "c".repeat(64) },
          loader: { kind: "fabric", version: "0.15.11" },
          launch: {
            kind: "generated-server-launcher",
            path: ".xmcl/launch.sh",
            arguments: [],
          },
          contentSha256: "d".repeat(64),
        },
      }));
    },
  });
  await assert.rejects(
    () =>
      compiler.submit({
        deploymentId: deployment.deploymentId,
        compilerRequestId: deployment.compilerRequestId,
        accountId: deployment.accountId,
        serviceId: deployment.serviceId,
        manifestSha256: deployment.manifestSha256,
        expectedContentKey: deployment.expectedContentKey,
        frozenManifest: deployment.frozenManifest,
      }),
    (error) =>
      error instanceof CompilerPublicationUncertain &&
      error.publication.deploymentId === deployment.deploymentId &&
      error.publication.manifestSha256 === deployment.manifestSha256,
  );
  assert.equal(submissions, 1);
});

Deno.test("HTTP compiler submission rejects arbitrary successful responses", async () => {
  const compiler = new HttpSharedModdedCompiler({
    endpoint: "https://compiler.example/v1/compiler-jobs",
    repository: { getDeployment: async () => deployment },
    grants: { issue: async () => grants },
    identity: new HmacCompilerServiceIdentity({
      keyId: "compiler-v1",
      secret,
      nonceStore: new Nonces(),
      now: () => now.getTime(),
    }),
    timeoutMs: 10_000,
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok" })),
  });

  await assert.rejects(
    () =>
      compiler.submit({
        deploymentId: deployment.deploymentId,
        compilerRequestId: deployment.compilerRequestId,
        accountId: deployment.accountId,
        serviceId: deployment.serviceId,
        manifestSha256: deployment.manifestSha256,
        expectedContentKey: deployment.expectedContentKey,
        frozenManifest: deployment.frozenManifest,
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "compiler_unavailable",
  );
});

Deno.test("HTTP compiler submission preserves upload uncertainty for durable retry", async () => {
  const compiler = new HttpSharedModdedCompiler({
    endpoint: "https://compiler.example/v1/compiler-jobs",
    repository: { getDeployment: async () => deployment },
    grants: { issue: async () => grants },
    identity: new HmacCompilerServiceIdentity({
      keyId: "compiler-v1", secret, nonceStore: new Nonces(), now: () => now.getTime(),
    }),
    timeoutMs: 10_000,
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({
      status: "upload_reconciliation_uncertain",
      deploymentId: deployment.deploymentId,
      manifestSha256: deployment.manifestSha256,
      content: {
        key: deployment.expectedContentKey, sha256: "d".repeat(64),
        compressedSize: 1, logicalSize: 1,
        paths: [".xmcl/runtime.json", ".xmcl/launch.sh"],
      },
      descriptor: {
        schemaVersion: 1, minecraftVersion: "1.20.1",
        java: { component: "java-runtime-gamma", major: 17 },
        runtimeCatalog: { sha256: "c".repeat(64) },
        loader: { kind: "fabric", version: "0.15.11" },
        launch: {
          kind: "generated-server-launcher", path: ".xmcl/launch.sh", arguments: [],
        },
        contentSha256: "d".repeat(64),
      },
    })),
  });
  await assert.rejects(
    () => compiler.submit({
      deploymentId: deployment.deploymentId,
      compilerRequestId: deployment.compilerRequestId,
      accountId: deployment.accountId,
      serviceId: deployment.serviceId,
      manifestSha256: deployment.manifestSha256,
      expectedContentKey: deployment.expectedContentKey,
      frozenManifest: deployment.frozenManifest,
    }),
    (error) => error instanceof CompilerUploadReconciliationUncertain &&
      error.publication.deploymentId === deployment.deploymentId,
  );
});
