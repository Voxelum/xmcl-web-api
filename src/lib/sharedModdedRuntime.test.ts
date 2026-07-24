import assert from "node:assert/strict";
import {
  CompilerGrantAuthority,
  MemorySharedModdedRuntimeRepository,
  resolveRuntimeJava,
  type RuntimeDescriptor,
  SharedModdedRuntimeError,
  SharedModdedRuntimeService,
} from "./sharedModdedRuntime.ts";
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
  options: { compilerFails?: boolean; termsAccepted?: boolean } = {},
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
  const archive = createStoredZip([{
    path: "modrinth.index.json",
    bytes: jsonBytes(validMrpackManifest),
  }, {
    path: "config/server.properties",
    bytes: jsonBytes({ online: true }),
  }]);
  const repository = new MemorySharedModdedRuntimeRepository();
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
      submit: async () => {
        if (options.compilerFails) throw new Error("compiler offline");
      },
    },
    terms: { accepted: async () => options.termsAccepted !== false },
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  return { scheduler, runtime, repository, commands };
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
  const compilerGrants = await f.runtime.compilerGrants(
    deployment.deploymentId,
    new CompilerGrantAuthority({
      presign: async (key, method) => ({
        key,
        method,
        url: `https://storage.example/bucket/${key}`,
        expiresAt: "2026-07-25T00:10:00.000Z",
        ...(method === "PUT" ? { headers: { "if-none-match": "*" } } : {}),
      }),
    }),
  );
  const descriptor: RuntimeDescriptor = {
    schemaVersion: 1,
    minecraftVersion: "1.21.1",
    javaMajor: 21,
    loader: { kind: "fabric", version: "0.16.10" },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: "b".repeat(64),
  };
  await f.runtime.publishCompilerResult({
    deploymentId: deployment.deploymentId,
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

Deno.test("resolves Java 8, 17 and 21 only from supported loader compatibility", () => {
  assert.equal(
    resolveRuntimeJava({
      minecraftVersion: "1.12.2",
      loader: "forge",
      loaderVersion: "14.23.5.2860",
    }).javaMajor,
    8,
  );
  assert.equal(
    resolveRuntimeJava({
      minecraftVersion: "1.20.1",
      loader: "fabric",
      loaderVersion: "0.15.0",
    }).javaMajor,
    17,
  );
  assert.equal(
    resolveRuntimeJava({
      minecraftVersion: "1.21.1",
      loader: "neoforge",
      loaderVersion: "21.1.1",
    }).javaMajor,
    21,
  );
  assert.throws(
    () =>
      resolveRuntimeJava({
        minecraftVersion: "1.20",
        loader: "forge",
        loaderVersion: "47.0.0",
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "unsupported_compatibility",
  );
  assert.throws(
    () =>
      resolveRuntimeJava({
        minecraftVersion: "1.12.2",
        loader: "neoforge",
        loaderVersion: "21.1.1",
      }),
    (error) =>
      error instanceof SharedModdedRuntimeError &&
      error.code === "unsupported_compatibility",
  );
});

Deno.test("compiler grants bind the frozen service/deployment and one immutable output key", async () => {
  const { deployment, compilerGrants: grants } = await publishedFixture();
  assert.equal(grants.deploymentId, deployment.deploymentId);
  assert.deepEqual(grants.grants.map((grant) => [grant.method, grant.key]), [
    ["GET", deployment.frozenManifest.archive.key],
    ["PUT", deployment.expectedContentKey],
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
    minecraftVersion: "1.21.1",
    javaMajor: 21,
    loader: { kind: "fabric", version: "0.16.10" },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: "b".repeat(64),
  };
  await f.runtime.publishCompilerResult({
    deploymentId: deployment.deploymentId,
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
