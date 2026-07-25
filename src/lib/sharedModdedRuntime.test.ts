import assert from "node:assert/strict";
import {
  CompilerGrantAuthority,
  CompilerPublicationUncertain,
  MemorySharedModdedRuntimeRepository,
  resolveRuntimeJava,
  type RuntimeDescriptor,
  SharedModdedRuntimeError,
  SharedModdedRuntimeService,
  validateRuntimeDescriptor,
} from "./sharedModdedRuntime.ts";
import { runtimeCatalog } from "./runtimeCatalog.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "./sharedHostingScheduler.ts";
import {
  createStoredZip,
  jsonBytes,
  validMrpackManifest,
} from "./modpackTestFixtures.ts";
import type { ModpackSourceResolver } from "./modpackSources/types.ts";

const sha = "a".repeat(64);
const now = "2026-07-25T00:00:00.000Z";
const reviewedMrpackManifest = structuredClone(validMrpackManifest);
reviewedMrpackManifest.dependencies.minecraft = "1.20.1";
reviewedMrpackManifest.dependencies["fabric-loader"] = "0.15.11";

const resolver: ModpackSourceResolver = {
  provider: "modrinth",
  async resolve(reference) {
    return {
      ...reference,
      sha256: sha,
      sizeBytes: 123,
      downloadUrl:
        "https://cdn.modrinth.com/data/project-a/versions/version-a/example.jar",
    };
  },
};

function fixture(
  options: {
    compilerFails?: boolean;
    uncertainPublication?: boolean;
    termsAccepted?: boolean;
    archive?: Uint8Array;
  } = {},
) {
  const commands: unknown[] = [];
  let sequence = 0;
  const scheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    {
      activeSubscription: async (accountId, subscriptionId) => ({
        subscriptionId,
        accountId,
        planId: "shared-small",
        status: "active",
        currentPeriodStartedAt: now,
        currentPeriodEndsAt: "2026-08-25T00:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        plan: {
          planId: "shared-small",
          displayName: "Small",
          memoryMiB: 4096,
          sharedCpu: 2,
          burstCpu: 4,
          persistentStorageGiB: 32,
          monthlyBaseMinor: 400,
          hourlyRateVersion: 1,
          hourlyAmountMinor: 1,
        },
      }),
    },
    { dispatch: async (command) => void commands.push(command) },
    undefined,
    {
      region: "sgp",
      now: () => new Date(now),
      createId: (prefix) => `${prefix}_${++sequence}`,
    },
  );
  const archive = options.archive ?? createStoredZip([{
    path: "modrinth.index.json",
    bytes: jsonBytes(reviewedMrpackManifest),
  }, {
    path: "config/server.properties",
    bytes: jsonBytes({ online: true }),
  }]);
  const repository = new MemorySharedModdedRuntimeRepository();
  let submissions = 0;
  const runtime = new SharedModdedRuntimeService({
    repository,
    scheduler,
    resolvers: [resolver],
    archives: {
      createUpload: async () => ({
        uploadUrl: "https://storage.example/upload",
        expiresAt: "2026-07-25T00:10:00.000Z",
        maxSizeBytes: archive.byteLength,
      }),
      readVerified: async () => archive,
    },
    compiler: {
      submit: async (input) => {
        submissions++;
        if (options.compilerFails) throw new Error("compiler offline");
        if (options.uncertainPublication) {
          throw new CompilerPublicationUncertain({
            deploymentId: input.deploymentId,
            compilerRequestId: input.compilerRequestId,
            manifestSha256: input.manifestSha256,
            content: {
              key: input.expectedContentKey,
              sha256: "b".repeat(64),
              compressedSize: 1_024,
              logicalSize: 2_048,
              paths: [
                ".xmcl/runtime.json",
                ".xmcl/launch.sh",
                "runtime/server.jar",
                "mods/example.jar",
              ],
            },
            descriptor: {
              schemaVersion: 1,
              minecraftVersion: "1.20.1",
              java: { component: "java-runtime-gamma", major: 17 },
              runtimeCatalog: { sha256: runtimeCatalog.sha256 },
              loader: { kind: "fabric", version: "0.15.11" },
              launch: {
                kind: "generated-server-launcher",
                path: ".xmcl/launch.sh",
                arguments: [],
              },
              contentSha256: "b".repeat(64),
            },
          });
        }
      },
    },
    terms: { accepted: async () => options.termsAccepted !== false },
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  return { scheduler, runtime, repository, commands, submissions: () => submissions };
}

async function publishedFixture() {
  const f = fixture();
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "subscription_1",
    idempotencyKey: "service",
  });
  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: service.serviceId,
    sourceFormat: "mrpack",
    expectedSha256: sha,
    expectedSizeBytes: 200,
    idempotencyKey: "import",
  });
  assert.equal(
    (await f.runtime.completeImport("account_1", imported.importId)).status,
    "valid",
  );
  const deployment = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deployment",
  });
  assert.equal(deployment.status, "compiling");
  const compilerGrants = await f.runtime.compilerGrants({
    deploymentId: deployment.deploymentId,
    compilerRequestId: deployment.compilerRequestId,
    authority: new CompilerGrantAuthority({
      presign: async (key, method) => ({
        key,
        method,
        url: `https://storage.example/bucket/${key}`,
        expiresAt: "2026-07-25T00:10:00.000Z",
        ...(method === "PUT" ? { headers: { "if-none-match": "*" } } : {}),
      }),
    }),
  });
  const descriptor: RuntimeDescriptor = {
    schemaVersion: 1,
    minecraftVersion: "1.20.1",
    java: { component: "java-runtime-gamma", major: 17 },
    runtimeCatalog: { sha256: runtimeCatalog.sha256 },
    loader: { kind: "fabric", version: "0.15.11" },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: "b".repeat(64),
  };
  await f.runtime.publishCompilerResult({
    deploymentId: deployment.deploymentId,
    compilerRequestId: deployment.compilerRequestId,
    manifestSha256: deployment.manifestSha256,
    content: {
      key: deployment.expectedContentKey,
      sha256: descriptor.contentSha256,
      compressedSize: 1_024,
      logicalSize: 2_048,
      paths: [
        ".xmcl/runtime.json",
        ".xmcl/launch.sh",
        "runtime/server.jar",
        "mods/example.jar",
      ],
    },
    descriptor,
  });
  return { ...f, service, deployment, compilerGrants };
}

async function localBundleArchive() {
  const mod = {
    path: "instance/mods/example.jar",
    bytes: new Uint8Array([1, 2, 3]),
  };
  const artifacts = [{
    intent: "mod",
    path: mod.path,
    sha256: await sha256Bytes(mod.bytes),
    sizeBytes: mod.bytes.byteLength,
  }];
  const files = [mod, {
    path: "resolved/loader.json",
    bytes: jsonBytes({
      schemaVersion: 1,
      minecraftVersion: "1.20.1",
      loader: { kind: "fabric", version: "0.15.11" },
      javaRequirement: { component: "java-runtime-gamma", major: 17 },
      runtimeCatalog: { sha256: runtimeCatalog.sha256 },
    }),
  }, {
    path: "resolved/mods.json",
    bytes: jsonBytes(artifacts.map(({ intent: _, ...file }) => file)),
  }, {
    path: "resolved/artifacts.json",
    bytes: jsonBytes({ schemaVersion: 1, artifacts }),
  }, {
    path: "resolved/version.json",
    bytes: jsonBytes({
      schemaVersion: 1,
      minecraftVersion: "1.20.1",
      javaVersion: { component: "java-runtime-gamma", majorVersion: 17 },
    }),
  }];
  const fileManifest = await Promise.all(files.map(async (file) => ({
    path: file.path,
    sha256: await sha256Bytes(file.bytes),
    sizeBytes: file.bytes.byteLength,
  })));
  fileManifest.sort((left, right) => left.path.localeCompare(right.path));
  return createStoredZip([{
    path: "bundle.json",
    bytes: jsonBytes({
      schemaVersion: 1,
      instanceName: "Local pack",
      minecraftVersion: "1.20.1",
      loader: { kind: "fabric", version: "0.15.11" },
      javaRequirement: { component: "java-runtime-gamma", major: 17 },
      runtimeCatalog: { sha256: runtimeCatalog.sha256 },
      files: fileManifest,
    }),
  }, ...files]);
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("validates only exact reviewed runtime/toolchain tuples", () => {
  const majors = new Set<number>();
  for (const toolchain of runtimeCatalog.toolchains) {
    assert.deepEqual(
      resolveRuntimeJava({
        minecraftVersion: toolchain.minecraftVersion,
        loader: toolchain.loader.kind,
        loaderVersion: toolchain.loader.version,
        java: toolchain.java,
        runtimeCatalogSha256: runtimeCatalog.sha256,
      }).java,
      toolchain.java,
    );
    majors.add(toolchain.java.major);
  }
  assert.ok(majors.has(25));
  assert.throws(
    () =>
      resolveRuntimeJava({
        minecraftVersion: "26.2",
        loader: "fabric",
        loaderVersion: "0.19.4",
        java: { component: "java-runtime-epsilon", major: 25 },
        runtimeCatalogSha256: runtimeCatalog.sha256,
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "unsupported_compatibility",
  );
  assert.throws(
    () =>
      resolveRuntimeJava({
        minecraftVersion: "../26.2",
        loader: "fabric",
        loaderVersion: "0.19.3",
        java: { component: "java-runtime-epsilon", major: 25 },
        runtimeCatalogSha256: runtimeCatalog.sha256,
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "unsupported_compatibility",
  );
});

Deno.test("rejects Java component, major, and catalog-revision mismatches", () => {
  const descriptor: RuntimeDescriptor = {
    schemaVersion: 1,
    minecraftVersion: "1.20.1",
    java: { component: "java-runtime-gamma", major: 17 },
    runtimeCatalog: { sha256: runtimeCatalog.sha256 },
    loader: { kind: "fabric", version: "0.15.11" },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: "b".repeat(64),
  };
  for (const invalid of [
    { ...descriptor, java: { component: "java-runtime-gamma", major: 25 } },
    { ...descriptor, java: { component: "unreviewed-component", major: 21 } },
    {
      ...descriptor,
      runtimeCatalog: { sha256: "c".repeat(64) },
    },
  ]) {
    assert.throws(
      () => validateRuntimeDescriptor(invalid),
      (error) =>
        error instanceof SharedModdedRuntimeError &&
        error.code === "unsupported_compatibility",
    );
  }
});

Deno.test("compiler grants bind the frozen service/deployment and one immutable output key", async () => {
  const { deployment, compilerGrants: grants } = await publishedFixture();
  assert.equal(
    deployment.frozenManifest.compatibility.runtimeCatalog.sha256,
    runtimeCatalog.sha256,
  );
  assert.equal(grants.deploymentId, deployment.deploymentId);
  assert.deepEqual(grants.grants.map((grant) => [grant.method, grant.key]), [
    ["GET", deployment.frozenManifest.archive.key],
    ["PUT", deployment.expectedContentKey],
  ]);
});

Deno.test("freezes validated local server bundles with exact catalog Java and compiler-only input grants", async () => {
  const archive = await localBundleArchive();
  const f = fixture({ archive });
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "subscription_1",
    idempotencyKey: "service",
  });
  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: service.serviceId,
    sourceFormat: "xmcl_server_bundle",
    expectedSha256: sha,
    expectedSizeBytes: archive.byteLength,
    idempotencyKey: "local-bundle",
  });
  const complete = await f.runtime.completeImport("account_1", imported.importId);
  assert.equal(complete.status, "valid");
  const deployment = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deploy-local-bundle",
  });
  assert.equal(deployment.frozenManifest.sourceFormat, "xmcl_server_bundle");
  assert.deepEqual(deployment.frozenManifest.compatibility.java, {
    component: "java-runtime-gamma",
    major: 17,
  });
  assert.match(deployment.frozenManifest.archive.key, /\.xmcl-server-bundle$/);
  const grants = await f.runtime.compilerGrants({
    deploymentId: deployment.deploymentId,
    compilerRequestId: deployment.compilerRequestId,
    authority: new CompilerGrantAuthority({
      presign: async (key, method) => ({
        key,
        method,
        url: `https://storage.example/${key}`,
        expiresAt: "2026-07-25T00:10:00.000Z",
        ...(method === "PUT" ? { headers: { "if-none-match": "*" } } : {}),
      }),
    }),
  });
  assert.deepEqual(grants.grants.map((grant) => grant.key), [
    deployment.frozenManifest.archive.key,
    deployment.expectedContentKey,
  ]);
});

Deno.test("selecting compiled content preserves world revision and stops before changing a running service", async () => {
  const f = await publishedFixture();
  const selected = await f.runtime.apply(
    "account_1",
    f.deployment.deploymentId,
    "apply",
  );
  assert.equal(selected.status, "selected");
  const ready = await f.scheduler.getService("account_1", f.service.serviceId);
  assert.equal(ready.workspace.revision, 0);
  assert.equal(ready.runtimeContent?.sha256, "b".repeat(64));
  const published = await f.runtime.getDeployment(
    "account_1",
    f.deployment.deploymentId,
  );
  assert.equal(
    await f.runtime.authorizeNodeRestore({
      accountId: "account_1",
      serviceId: f.service.serviceId,
      deploymentId: f.deployment.deploymentId,
      manifestSha256: f.deployment.manifestSha256,
      content: published.content!,
    }),
    true,
  );
  assert.equal(
    await f.runtime.authorizeNodeRestore({
      accountId: "account_other",
      serviceId: f.service.serviceId,
      deploymentId: f.deployment.deploymentId,
      manifestSha256: f.deployment.manifestSha256,
      content: published.content!,
    }),
    false,
  );

  await f.scheduler.registerNode({
    nodeId: "node_1",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const starting = await f.scheduler.start(
    "account_1",
    f.service.serviceId,
    "start",
  );
  await f.scheduler.reportStarted({
    nodeId: "node_1",
    serviceId: f.service.serviceId,
    assignmentId: starting.assignmentId!,
  });
  const pending = await f.runtime.rollback({
    accountId: "account_1",
    serviceId: f.service.serviceId,
    deploymentId: f.deployment.deploymentId,
    idempotencyKey: "rollback",
  });
  assert.equal(pending.status, "awaiting_stop_sync");
  assert.equal(
    (await f.scheduler.getService("account_1", f.service.serviceId)).status,
    "stopping",
  );
  await f.scheduler.reportStoppedAndSynced({
    nodeId: "node_1",
    serviceId: f.service.serviceId,
    assignmentId: starting.assignmentId!,
    workspace: { revision: 1, sizeBytes: 10 },
  });
  const advanced = await f.runtime.advance(
    "account_1",
    f.deployment.deploymentId,
  );
  assert.equal(advanced.status, "selected");
  assert.equal(
    (await f.scheduler.getService("account_1", f.service.serviceId)).workspace
      .revision,
    1,
  );
});

Deno.test("compiler failure cannot select or overwrite current content", async () => {
  const f = fixture({ compilerFails: true });
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "subscription_1",
    idempotencyKey: "service",
  });

  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: service.serviceId,
    sourceFormat: "mrpack",
    expectedSha256: sha,
    expectedSizeBytes: 200,
    idempotencyKey: "import",
  });
  await f.runtime.completeImport("account_1", imported.importId);
  const failed = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deployment",
  });
  assert.equal(failed.status, "compile_failed");
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId))
      .runtimeContent,
    undefined,
  );
});

Deno.test("uncertain published callbacks reconcile their stable payload without resubmitting", async () => {
  const f = fixture({ uncertainPublication: true });
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "subscription_1",
    idempotencyKey: "service",
  });
  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: service.serviceId,
    sourceFormat: "mrpack",
    expectedSha256: sha,
    expectedSizeBytes: 200,
    idempotencyKey: "import",
  });
  await f.runtime.completeImport("account_1", imported.importId);
  const published = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deployment",
  });
  assert.equal(published.status, "published");
  assert.equal(published.pendingCompilerPublication, undefined);
  assert.equal(f.submissions(), 1);
  const retried = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deployment",
  });
  assert.equal(retried.status, "published");
  assert.equal(f.submissions(), 1);
});

Deno.test("compiler callbacks are request-bound and idempotent only for the same result", async () => {
  const f = await publishedFixture();
  const published = await f.runtime.getDeployment(
    "account_1",
    f.deployment.deploymentId,
  );
  const repeated = await f.runtime.publishCompilerResult({
    deploymentId: published.deploymentId,
    compilerRequestId: published.compilerRequestId,
    manifestSha256: published.manifestSha256,
    content: published.content!,
    descriptor: published.descriptor!,
  });
  assert.equal(repeated.status, "published");
  await assert.rejects(
    () =>
      f.runtime.publishCompilerResult({
        deploymentId: published.deploymentId,
        compilerRequestId: "other_request",
        manifestSha256: published.manifestSha256,
        content: published.content!,
        descriptor: published.descriptor!,
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "state_conflict",
  );
});

Deno.test("durable compiler failure callbacks preserve selected content and world state", async () => {
  const f = await publishedFixture();
  await f.runtime.apply("account_1", f.deployment.deploymentId, "select-current");
  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: f.service.serviceId,
    sourceFormat: "mrpack",
    expectedSha256: sha,
    expectedSizeBytes: 200,
    idempotencyKey: "second-import",
  });
  await f.runtime.completeImport("account_1", imported.importId);
  const pending = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: f.service.serviceId,
    importId: imported.importId,
    idempotencyKey: "second-deployment",
  });
  const failed = await f.runtime.reportCompilerFailure({
    deploymentId: pending.deploymentId,
    compilerRequestId: pending.compilerRequestId,
    manifestSha256: pending.manifestSha256,
    code: "compiler_failed",
  });
  assert.equal(failed.status, "compile_failed");
  const service = await f.scheduler.getService("account_1", f.service.serviceId);
  assert.equal(service.runtimeContent?.deploymentId, f.deployment.deploymentId);
  assert.equal(service.workspace.revision, 0);
});

Deno.test("a missing server-side terms acceptance cannot select content", async () => {
  const f = fixture({ termsAccepted: false });
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "subscription_1",
    idempotencyKey: "service",
  });
  const imported = await f.runtime.createImport({
    accountId: "account_1",
    serviceId: service.serviceId,
    sourceFormat: "mrpack",
    expectedSha256: sha,
    expectedSizeBytes: 200,
    idempotencyKey: "import",
  });
  await f.runtime.completeImport("account_1", imported.importId);
  const deployment = await f.runtime.createDeployment({
    accountId: "account_1",
    serviceId: service.serviceId,
    importId: imported.importId,
    idempotencyKey: "deployment",
  });
  const descriptor: RuntimeDescriptor = {
    schemaVersion: 1,
    minecraftVersion: "1.20.1",
    java: { component: "java-runtime-gamma", major: 17 },
    runtimeCatalog: { sha256: runtimeCatalog.sha256 },
    loader: { kind: "fabric", version: "0.15.11" },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: "b".repeat(64),
  };
  await f.runtime.publishCompilerResult({
    deploymentId: deployment.deploymentId,
    compilerRequestId: deployment.compilerRequestId,
    manifestSha256: deployment.manifestSha256,
    content: {
      key: deployment.expectedContentKey,
      sha256: descriptor.contentSha256,
      compressedSize: 10,
      logicalSize: 10,
      paths: [".xmcl/runtime.json", ".xmcl/launch.sh"],
    },
    descriptor,
  });
  await assert.rejects(
    () => f.runtime.apply("account_1", deployment.deploymentId, "apply"),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "terms_not_accepted",
  );
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId))
      .runtimeContent,
    undefined,
  );
});
