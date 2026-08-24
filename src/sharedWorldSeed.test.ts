import assert from "node:assert/strict";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "./sharedHostingScheduler.ts";
import {
  MemorySharedWorldSeedRepository,
  SharedWorldSeedService,
  WorldSeedCompilerGrantAuthority,
} from "./sharedWorldSeed.ts";
import { createStoredZip, jsonBytes } from "./modpackTestFixtures.ts";

const now = "2026-07-25T00:00:00.000Z";
const bytes = new TextEncoder().encode("local world");
const digest = await sha(bytes);
const archive = createStoredZip([
  {
    path: "world.json",
    bytes: jsonBytes({
      schemaVersion: 1,
      worldName: "Local World",
      source: "local_instance",
      files: [{
        path: "world/level.dat",
        sha256: digest,
        sizeBytes: bytes.byteLength,
      }],
    }),
  },
  { path: "world/level.dat", bytes },
]);
const archiveSha = await sha(archive);

function fixture() {
  let id = 0;
  const commands: unknown[] = [];
  const scheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    {
      activeSubscription: async (accountId, subscriptionId) => ({
        subscriptionId,
        accountId,
        planId: "shared-small",
        status: "active",
        currentPeriodStartedAt: now,
        currentPeriodEndsAt: now,
        createdAt: now,
        updatedAt: now,
        plan: {
          planId: "shared-small",
          displayName: "small",
          memoryMiB: 4096,
          sharedCpu: 2,
          persistentStorageGiB: 32,
          monthlyBaseMinor: 1,
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
      createId: (prefix) => `${prefix}_${++id}`,
    },
  );
  const seeds = new SharedWorldSeedService({
    scheduler,
    repository: new MemorySharedWorldSeedRepository(),
    archives: {
      createUpload: async (input) => ({
        uploadUrl: `https://storage.example/${input.key}`,
        expiresAt: now,
        maxSizeBytes: input.expectedSizeBytes,
      }),
      readVerified: async () => archive,
    },
    now: () => now,
    createId: (prefix) => `${prefix}_${++id}`,
  });
  return { scheduler, seeds, commands };
}

async function newService(f: ReturnType<typeof fixture>) {
  return await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "sub_1",
    idempotencyKey: "service",
  });
}

async function completeSeed(
  f: ReturnType<typeof fixture>,
  serviceId: string,
  key: string,
) {
  const seed = await f.seeds.create({
    accountId: "account_1",
    serviceId,
    expectedSha256: archiveSha,
    expectedSizeBytes: archive.byteLength,
    idempotencyKey: key,
  });
  await f.seeds.uploadUrl("account_1", seed.seedId);
  return await f.seeds.complete("account_1", seed.seedId, `${key}-complete`);
}

Deno.test("world seeds reject cross-account access and a running service", async () => {
  const f = fixture();
  const service = await newService(f);
  await assert.rejects(
    () =>
      f.seeds.create({
        accountId: "account_other",
        serviceId: service.serviceId,
        expectedSha256: archiveSha,
        expectedSizeBytes: archive.byteLength,
        idempotencyKey: "other",
      }),
    /shared_service_not_found/,
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
    service.serviceId,
    "start",
  );
  await f.scheduler.reportStarted({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: starting.assignmentId!,
  });
  await assert.rejects(
    () =>
      f.seeds.create({
        accountId: "account_1",
        serviceId: service.serviceId,
        expectedSha256: archiveSha,
        expectedSizeBytes: archive.byteLength,
        idempotencyKey: "running",
      }),
    /state_conflict/,
  );
});

Deno.test("only a validated seed becomes the initial world and failed validation preserves state", async () => {
  const f = fixture();
  const service = await newService(f);
  const bad = await f.seeds.create({
    accountId: "account_1",
    serviceId: service.serviceId,
    expectedSha256: "f".repeat(64),
    expectedSizeBytes: archive.byteLength,
    idempotencyKey: "bad",
  });
  await f.seeds.uploadUrl("account_1", bad.seedId);
  const invalid = await f.seeds.complete(
    "account_1",
    bad.seedId,
    "bad-complete",
  );
  assert.equal(invalid.status, "invalid");
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId)).initialWorld,
    undefined,
  );
  const selected = await completeSeed(f, service.serviceId, "good");
  assert.equal(selected.status, "selected");
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId)).initialWorld
      ?.seedId,
    selected.seedId,
  );
});

Deno.test("a seed is selected only before first start and cannot overwrite a synced runtime world", async () => {
  const f = fixture();
  const service = await newService(f);
  const selected = await completeSeed(f, service.serviceId, "first");
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
    service.serviceId,
    "start",
  );
  assert.equal(
    (f.commands[0] as { initialWorld?: { seedId: string } }).initialWorld
      ?.seedId,
    selected.seedId,
  );
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId))
      .initialWorldSent,
    undefined,
  );
  await f.scheduler.reportStarted({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: starting.assignmentId!,
  });
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId))
      .initialWorldSent,
    true,
  );
  await f.scheduler.stop("account_1", service.serviceId, "stop");
  await f.scheduler.reportStopped({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: starting.assignmentId!,
  });
  await f.scheduler.reportStoppedAndSynced({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: starting.assignmentId!,
    workspace: { revision: 1, sizeBytes: 9 },
  });
  await assert.rejects(
    () =>
      f.seeds.create({
        accountId: "account_1",
        serviceId: service.serviceId,
        expectedSha256: archiveSha,
        expectedSizeBytes: archive.byteLength,
        idempotencyKey: "second",
      }),
    /state_conflict/,
  );
  assert.equal(
    (await f.scheduler.getService("account_1", service.serviceId)).initialWorld
      ?.seedId,
    selected.seedId,
  );
});

Deno.test("compiler seed grants are one exact selected-seed GET", async () => {
  const f = fixture();
  const service = await newService(f);
  const selected = await completeSeed(f, service.serviceId, "grant");
  const grants = await f.seeds.compilerGrants(
    selected.seedId,
    new WorldSeedCompilerGrantAuthority({
      presign: async (key, method) => ({
        key,
        method,
        url: `https://storage.example/${key}`,
        expiresAt: "2026-07-25T00:10:00.000Z",
      }),
    }),
  );
  assert.deepEqual(grants.grants.map((grant) => [grant.method, grant.key]), [[
    "GET",
    `shared-hosting/account_1/${service.serviceId}/world-seeds/${selected.seedId}.xmcl-world-seed`,
  ]]);
});

async function sha(value: Uint8Array) {
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return [...new Uint8Array(result)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
