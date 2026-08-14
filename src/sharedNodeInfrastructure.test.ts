import assert from "node:assert/strict";
import {
  InfrastructureError,
  MemorySharedNodeAllocationRepository,
  MixedSharedNodeProvisioner,
  type SharedNodeCapacityDemand,
  type SharedNodeCapacitySource,
  type SharedNodeProvisioner,
} from "./sharedNodeInfrastructure.ts";

const demand: SharedNodeCapacityDemand = {
  requestId: "shared-capacity:service_1",
  region: "sgp",
  workloadClass: "standard",
  minimumMemoryMiB: 4096,
  minimumSharedCpu: 2,
  minimumWorkspaceGiB: 32,
};

class FixtureProvisioner implements SharedNodeProvisioner {
  readonly requests: SharedNodeCapacityDemand[] = [];
  failures: unknown[] = [];

  async requestCapacity(input: SharedNodeCapacityDemand) {
    this.requests.push(structuredClone(input));
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}

function source(
  providerId: string,
  offerId: string,
  provisioner: SharedNodeProvisioner,
  options: {
    priority?: number;
    cost?: number;
    workloadClasses?: readonly ("standard" | "large")[];
  } = {},
): SharedNodeCapacitySource {
  return {
    offer: {
      providerId,
      offerId,
      region: "sgp",
      workloadClasses: options.workloadClasses ?? ["standard", "large"],
      totalMemoryMiB: 16 * 1024,
      totalSharedCpu: 8,
      totalWorkspaceGiB: 128,
      priority: options.priority ?? 100,
      estimatedHourlyCostMicros: options.cost,
    },
    provisioner,
  };
}

Deno.test("mixed allocator selects the lowest-cost offer within provider priority", async () => {
  const vultr = new FixtureProvisioner();
  const lightNode = new FixtureProvisioner();
  const repository = new MemorySharedNodeAllocationRepository();
  const allocator = new MixedSharedNodeProvisioner([
    source("vultr", "vultr-standard", vultr, { cost: 107_000 }),
    source("lightnode", "lightnode-standard", lightNode, { cost: 90_000 }),
  ], repository);

  await allocator.requestCapacity(demand);
  await allocator.requestCapacity(demand);

  assert.equal(vultr.requests.length, 0);
  assert.equal(lightNode.requests.length, 1);
  assert.equal(lightNode.requests[0].requestId, demand.requestId);
  assert.equal((await repository.find(demand.requestId))?.status, "completed");
});

Deno.test("mixed allocator rejects a changed demand for the same request id", async () => {
  const provider = new FixtureProvisioner();
  const allocator = new MixedSharedNodeProvisioner([
    source("vultr", "standard", provider),
  ]);
  await allocator.requestCapacity(demand);

  await assert.rejects(
    () =>
      allocator.requestCapacity({
        ...demand,
        minimumMemoryMiB: demand.minimumMemoryMiB + 1024,
      }),
    (error) =>
      error instanceof InfrastructureError &&
      error.code === "allocation_conflict" &&
      error.outcome === "definitive",
  );
  assert.equal(provider.requests.length, 1);
});

Deno.test("mixed allocator falls back only after definitive capacity exhaustion", async () => {
  const preferred = new FixtureProvisioner();
  preferred.failures.push(
    new InfrastructureError(
      "capacity_unavailable",
      "definitive",
      "vultr",
    ),
  );
  const fallback = new FixtureProvisioner();
  const repository = new MemorySharedNodeAllocationRepository();
  const allocator = new MixedSharedNodeProvisioner([
    source("vultr", "preferred", preferred, { priority: 10 }),
    source("lightnode", "fallback", fallback, { priority: 20 }),
  ], repository);

  await allocator.requestCapacity(demand);

  assert.equal(preferred.requests.length, 1);
  assert.equal(fallback.requests.length, 1);
  assert.notEqual(fallback.requests[0].requestId, demand.requestId);
  assert.ok(fallback.requests[0].requestId.length <= 96);
  const record = await repository.find(demand.requestId);
  assert.equal(record?.attempts[0].status, "failed");
  assert.equal(record?.attempts[1].status, "completed");
});

Deno.test("mixed allocator reconciles an unknown outcome with the same provider and request id", async () => {
  const preferred = new FixtureProvisioner();
  preferred.failures.push(
    new InfrastructureError("provider_unknown", "unknown", "vultr"),
  );
  const fallback = new FixtureProvisioner();
  const repository = new MemorySharedNodeAllocationRepository();
  const allocator = new MixedSharedNodeProvisioner([
    source("vultr", "preferred", preferred, { priority: 10 }),
    source("lightnode", "fallback", fallback, { priority: 20 }),
  ], repository);

  await assert.rejects(
    () => allocator.requestCapacity(demand),
    InfrastructureError,
  );
  await allocator.requestCapacity(demand);

  assert.equal(preferred.requests.length, 2);
  assert.equal(
    preferred.requests[0].requestId,
    preferred.requests[1].requestId,
  );
  assert.equal(fallback.requests.length, 0);
  assert.equal((await repository.find(demand.requestId))?.attempts.length, 1);
});

Deno.test("mixed allocator does not reselect when a persisted offer disappears", async () => {
  const original = new FixtureProvisioner();
  original.failures.push(
    new InfrastructureError("provider_unknown", "unknown", "vultr"),
  );
  const repository = new MemorySharedNodeAllocationRepository();
  const originalAllocator = new MixedSharedNodeProvisioner([
    source("vultr", "original", original),
  ], repository);
  await assert.rejects(
    () => originalAllocator.requestCapacity(demand),
    InfrastructureError,
  );

  const replacement = new FixtureProvisioner();
  const replacementAllocator = new MixedSharedNodeProvisioner([
    source("lightnode", "replacement", replacement),
  ], repository);
  await assert.rejects(
    () => replacementAllocator.requestCapacity(demand),
    (error) =>
      error instanceof InfrastructureError &&
      error.outcome === "unknown" &&
      error.code === "provider_unavailable",
  );
  assert.equal(replacement.requests.length, 0);
});

Deno.test("mixed allocator keeps large-only workloads off standard offers", async () => {
  const standard = new FixtureProvisioner();
  const large = new FixtureProvisioner();
  const allocator = new MixedSharedNodeProvisioner([
    source("vultr", "standard", standard, {
      priority: 10,
      workloadClasses: ["standard"],
    }),
    source("vultr", "large", large, {
      priority: 20,
      workloadClasses: ["standard", "large"],
    }),
  ]);

  await allocator.requestCapacity({
    ...demand,
    workloadClass: "large",
  });

  assert.equal(standard.requests.length, 0);
  assert.equal(large.requests.length, 1);
});
