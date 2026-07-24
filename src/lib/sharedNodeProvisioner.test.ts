import assert from "node:assert/strict";
import {
  MemorySharedNodeProvisioningRepository,
  renderSharedNodeCloudInit,
  VultrSharedNodeProvisioner,
} from "./sharedNodeProvisioner.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "./sharedHostingScheduler.ts";
import { MemorySharedNodeCredentialRepository } from "./sharedNodeTransport.ts";
import {
  type SharedNodeVolumeProvider,
  type VultrAdapter,
  VultrError,
  type VultrInstance,
  type VultrVolume,
} from "./vultr.ts";

const config = {
  releaseUrl: "https://releases.example/xmcl-agent",
  releaseSha256: "a".repeat(64),
  quotaHelperReleaseUrl: "https://releases.example/xmcl-quota-helper",
  quotaHelperReleaseSha256: "b".repeat(64),
  controlPlaneUrl: "https://api.example",
  region: "sgp",
  blockStorageSizeGiB: 192,
  blockStorageType: "high_perf",
  firewallGroupId: "firewall-group-1",
};

const capacityRequest = {
  requestId: "shared-capacity:service_1",
  region: "sgp",
  minimumMemoryMiB: 4096,
  minimumSharedCpu: 2,
  minimumWorkspaceGiB: 32,
};

function schedulerFixture(calls: { dispatches: number }) {
  return new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    {
      activeSubscription: async () => {
        throw new Error("unused");
      },
    },
    { dispatch: async () => { calls.dispatches += 1; } },
    undefined,
    { region: "sgp" },
  );
}

function providerFixture() {
  const calls = {
    instanceCreate: 0,
    instanceDelete: 0,
    volumeCreate: 0,
    volumeAttach: 0,
    volumeDetach: 0,
    volumeDelete: 0,
    firewallGroupIds: [] as (string | undefined)[],
    order: [] as string[],
  };
  const instances = new Map<string, VultrInstance>();
  const volumes = new Map<string, VultrVolume>();
  const provider: VultrAdapter = {
    validateCapacity: async () => {},
    createInstance: async (input) => {
      calls.instanceCreate += 1;
      calls.firewallGroupIds.push(input.firewallGroupId);
      assert.match(input.userData, /XMCL_SHARED_NODE_VOLUME_ID='volume_1'/);
      assert.match(input.userData, /XMCL_SHARED_NODE_REGION='sgp'/);
      assert.deepEqual(input.tags, [
        "xmcl-environment:production",
        "xmcl-region:sgp",
        "xmcl-node-pool:shared",
        "xmcl-capacity-request:shared-capacity:service_1",
      ]);
      const instance = {
        id: "instance_1",
        region: "sgp",
        plan: input.plan,
        label: input.label ?? input.serverId,
        status: "active",
        powerStatus: "running",
        serverStatus: "ok",
        firewallGroupId: input.firewallGroupId,
      };
      instances.set(instance.id, instance);
      return instance;
    },
    createSnapshot: async () => ({ snapshotId: "snapshot_1" }),
    reconcileCreate: async (label) =>
      [...instances.values()].find((item) => item.label === label),
    getInstance: async (id) => instances.get(id),
    start: async () => {},
    halt: async () => {},
    reboot: async () => {},
    delete: async (id) => {
      calls.instanceDelete += 1;
      calls.order.push("instance-delete");
      instances.delete(id);
    },
  };
  const volumeProvider: SharedNodeVolumeProvider = {
    createVolume: async (input) => {
      calls.volumeCreate += 1;
      const volume = {
        id: "volume_1",
        region: input.region,
        sizeGiB: input.sizeGiB,
        label: input.label,
        blockType: input.blockType,
        status: "active",
      };
      volumes.set(volume.id, volume);
      return volume;
    },
    getVolume: async (id) => volumes.get(id),
    reconcileVolume: async (label) =>
      [...volumes.values()].find((item) => item.label === label),
    attachVolume: async (id, instanceId) => {
      calls.volumeAttach += 1;
      const volume = volumes.get(id)!;
      volume.attachedToInstance = instanceId;
    },
    detachVolume: async (id) => {
      calls.volumeDetach += 1;
      calls.order.push("volume-detach");
      const volume = volumes.get(id)!;
      volume.attachedToInstance = undefined;
    },
    deleteVolume: async (id) => {
      calls.volumeDelete += 1;
      calls.order.push("volume-delete");
      volumes.delete(id);
    },
  };
  return { provider, volumeProvider, calls, instances, volumes };
}

function provisionerFixture(options: {
  drainTimeoutMs?: number;
  registration?: (
    nodeId: string,
    volumeProvider: SharedNodeVolumeProvider,
    firewallGroupIds: readonly (string | undefined)[],
  ) => Promise<void>;
} = {}) {
  const schedulerCalls = { dispatches: 0 };
  const scheduler = schedulerFixture(schedulerCalls);
  const repository = new MemorySharedNodeProvisioningRepository();
  const enrollmentRepository = new MemorySharedNodeCredentialRepository();
  const providers = providerFixture();
  let registrationCalls = 0;
  const provisioner = new VultrSharedNodeProvisioner({
    provider: providers.provider,
    volumeProvider: providers.volumeProvider,
    scheduler,
    repository,
    enrollmentRepository,
    registration: {
      isRegistered: (nodeId) => scheduler.hasNode(nodeId),
      waitForRegistration: async (nodeId) => {
        registrationCalls += 1;
        await options.registration?.(
          nodeId,
          providers.volumeProvider,
          providers.calls.firewallGroupIds,
        );
        await scheduler.registerNode({
          nodeId,
          region: "sgp",
          status: "ready",
          totalMemoryMiB: 12 * 1024,
          totalSharedCpu: 8,
          totalWorkspaceGiB: 128,
        });
      },
    },
    config,
    drainTimeoutMs: options.drainTimeoutMs,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  return {
    ...providers,
    scheduler,
    schedulerCalls,
    get registrationCalls() {
      return registrationCalls;
    },
    repository,
    provisioner,
  };
}

Deno.test("shared node volume is persisted, attached, and confirmed before registration", async () => {
  const fixture = provisionerFixture({
    registration: async (_nodeId, volumeProvider, firewallGroupIds) => {
      assert.deepEqual(firewallGroupIds, ["firewall-group-1"]);
      const volume = await volumeProvider.getVolume("volume_1");
      assert.equal(volume?.attachedToInstance, "instance_1");
    },
  });

  await fixture.provisioner.requestCapacity(capacityRequest);
  await fixture.provisioner.requestCapacity(capacityRequest);

  assert.equal(fixture.calls.volumeCreate, 1);
  assert.equal(fixture.calls.instanceCreate, 1);
  assert.equal(fixture.calls.volumeAttach, 1);
  const record = await fixture.repository.find(capacityRequest.requestId);
  assert.deepEqual(
    {
      volumeId: record?.volumeId,
      firewallGroupId: record?.firewallGroupId,
      volumeLabel: record?.volumeLabel,
      volumeSizeGiB: record?.volumeSizeGiB,
      volumeStatus: record?.volumeStatus,
      status: record?.status,
    },
    {
      volumeId: "volume_1",
      firewallGroupId: "firewall-group-1",
      volumeLabel: "xmcl-shared-volume-shared-capacity:service_1",
      volumeSizeGiB: 192,
      volumeStatus: "attached",
      status: "ready",
    },
  );
});

Deno.test("missing or wrong firewall group never attaches storage or registers a node", async () => {
  for (const [firewallGroupId, outcome, status] of [
    [undefined, "unknown", "unknown"],
    ["another-firewall-group", "definitive", "failed"],
  ] as const) {
    const fixture = provisionerFixture();
    const create = fixture.provider.createInstance;
    fixture.provider.createInstance = async (input) => ({
      ...await create(input),
      firewallGroupId,
    });

    await assert.rejects(
      () => fixture.provisioner.requestCapacity(capacityRequest),
      (error) =>
        error instanceof VultrError &&
        error.outcome === outcome,
    );
    assert.equal(fixture.calls.volumeAttach, 0);
    assert.equal(fixture.registrationCalls, 0);
    assert.equal(fixture.schedulerCalls.dispatches, 0);
    assert.equal(
      (await fixture.repository.find(capacityRequest.requestId))?.status,
      status,
    );
  }
});

Deno.test("a reconciled VM without the expected firewall group cannot become ready", async () => {
  const fixture = provisionerFixture();
  fixture.provider.reconcileCreate = async () => ({
    id: "instance_1",
    region: "sgp",
    plan: "vc2-4c-16gb",
    label: "xmcl-shared-shared-capacity:service_1",
    status: "active",
    powerStatus: "running",
    serverStatus: "ok",
  });

  await assert.rejects(
    () => fixture.provisioner.requestCapacity(capacityRequest),
    (error) =>
      error instanceof VultrError &&
      error.code === "invalid_provider_response" &&
      error.outcome === "unknown",
  );
  assert.equal(fixture.calls.instanceCreate, 0);
  assert.equal(fixture.calls.volumeAttach, 0);
  assert.equal(fixture.registrationCalls, 0);
  assert.equal(fixture.schedulerCalls.dispatches, 0);
  assert.equal(
    (await fixture.repository.find(capacityRequest.requestId))?.status,
    "unknown",
  );
});

Deno.test("a changed firewall group on a durable record fails before provider changes", async () => {
  const fixture = provisionerFixture();
  await fixture.provisioner.requestCapacity(capacityRequest);
  const provisioner = new VultrSharedNodeProvisioner({
    provider: fixture.provider,
    volumeProvider: fixture.volumeProvider,
    scheduler: fixture.scheduler,
    repository: fixture.repository,
    enrollmentRepository: new MemorySharedNodeCredentialRepository(),
    registration: { isRegistered: (nodeId) => fixture.scheduler.hasNode(nodeId) },
    config: { ...config, firewallGroupId: "firewall-group-2" },
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  const createsBefore = fixture.calls.instanceCreate;
  const attachmentsBefore = fixture.calls.volumeAttach;

  await assert.rejects(
    () => provisioner.requestCapacity(capacityRequest),
    (error) =>
      error instanceof VultrError &&
      error.code === "provider_rejected" &&
      error.outcome === "definitive",
  );
  assert.equal(fixture.calls.instanceCreate, createsBefore);
  assert.equal(fixture.calls.volumeAttach, attachmentsBefore);
  assert.equal(
    (await fixture.repository.find(capacityRequest.requestId))?.firewallGroupId,
    "firewall-group-1",
  );
});

Deno.test("an unknown volume create is reconciled by deterministic label without a duplicate", async () => {
  const fixture = provisionerFixture();
  const create = fixture.volumeProvider.createVolume;
  let first = true;
  fixture.volumeProvider.createVolume = async (input) => {
    const volume = await create(input);
    if (first) {
      first = false;
      throw new VultrError("provider_unknown", "unknown");
    }
    return volume;
  };

  await assert.rejects(
    () => fixture.provisioner.requestCapacity(capacityRequest),
    VultrError,
  );
  await fixture.provisioner.requestCapacity(capacityRequest);

  assert.equal(fixture.calls.volumeCreate, 1);
  assert.equal(fixture.calls.instanceCreate, 1);
  assert.equal(
    (await fixture.repository.find(capacityRequest.requestId))?.volumeId,
    "volume_1",
  );
});

Deno.test("an unknown VM create reconciles its durable volume and VM before retry", async () => {
  const fixture = provisionerFixture();
  const create = fixture.provider.createInstance;
  let first = true;
  fixture.provider.createInstance = async (input) => {
    const instance = await create(input);
    if (first) {
      first = false;
      throw new VultrError("provider_unknown", "unknown");
    }
    return instance;
  };

  await assert.rejects(
    () => fixture.provisioner.requestCapacity(capacityRequest),
    VultrError,
  );
  await fixture.provisioner.requestCapacity(capacityRequest);

  assert.equal(fixture.calls.volumeCreate, 1);
  assert.equal(fixture.calls.instanceCreate, 1);
  assert.equal(fixture.calls.volumeAttach, 1);
  assert.equal(
    (await fixture.repository.find(capacityRequest.requestId))?.status,
    "ready",
  );
});

Deno.test("wrong volume region, size, or type fails definitively before VM creation", async () => {
  for (const invalid of [
    { region: "ewr", sizeGiB: 192, blockType: "high_perf" },
    { region: "sgp", sizeGiB: 128, blockType: "high_perf" },
    { region: "sgp", sizeGiB: 192, blockType: "storage_opt" },
  ]) {
    const fixture = provisionerFixture();
    fixture.volumeProvider.createVolume = async (input) => ({
      id: "volume_1",
      label: input.label,
      status: "active",
      ...invalid,
    });
    await assert.rejects(
      () => fixture.provisioner.requestCapacity(capacityRequest),
      (error) =>
        error instanceof VultrError &&
        error.code === "provider_rejected" &&
        error.outcome === "definitive",
    );
    assert.equal(fixture.calls.instanceCreate, 0);
    assert.equal(
      (await fixture.repository.find(capacityRequest.requestId))?.status,
      "failed",
    );
  }
});

Deno.test("wrong attachment target fails without deleting the request volume", async () => {
  const fixture = provisionerFixture();
  fixture.volumeProvider.attachVolume = async (id) => {
    fixture.calls.volumeAttach += 1;
    fixture.volumes.get(id)!.attachedToInstance = "another-instance";
  };

  await assert.rejects(
    () => fixture.provisioner.requestCapacity(capacityRequest),
    (error) =>
      error instanceof VultrError &&
      error.code === "provider_rejected" &&
      error.outcome === "definitive",
  );
  assert.equal(fixture.calls.volumeDelete, 0);
  assert.equal(
    (await fixture.repository.find(capacityRequest.requestId))?.volumeStatus,
    "unknown",
  );
});

Deno.test("drain blocks deletion while services are active", async () => {
  const fixture = provisionerFixture({ drainTimeoutMs: 0 });
  await fixture.provisioner.requestCapacity(capacityRequest);
  fixture.scheduler.activeServicesOnNode = async () => [{
    serviceId: "shared_service_active",
  }] as never;

  await assert.rejects(
    () =>
      fixture.provisioner.drainNode(
        "shared-node-shared-capacity:service_1",
      ),
    VultrError,
  );
  assert.equal(fixture.calls.instanceDelete, 0);
  assert.equal(fixture.calls.volumeDelete, 0);
});

Deno.test("successful drain deletes VM, confirms detach, then deletes its owned volume", async () => {
  const fixture = provisionerFixture();
  await fixture.provisioner.requestCapacity(capacityRequest);
  await fixture.provisioner.drainNode("shared-node-shared-capacity:service_1");

  assert.deepEqual(fixture.calls.order, [
    "instance-delete",
    "volume-detach",
    "volume-delete",
  ]);
  const record = await fixture.repository.find(capacityRequest.requestId);
  assert.equal(record?.status, "deleted");
  assert.equal(record?.volumeStatus, "deleted");
});

Deno.test("shared cloud-init safely waits for its exact Vultr volume", () => {
  const value = renderSharedNodeCloudInit({
    nodeId: "shared-node-1",
    ...config,
    volumeId: "vol-abc",
    controlPlaneCredential: "one-time-enrollment-token",
    totalMemoryMiB: 12 * 1024,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 128,
  });

  assert.match(value, /XMCL_SHARED_NODE_VOLUME_ID='vol-abc'/);
  assert.match(value, /XMCL_SHARED_NODE_REGION='sgp'/);
  assert.match(value, /XMCL_WORKSPACE_ROOT='\/var\/lib\/xmcl-shared\/workspaces'/);
  assert.match(value, /\/dev\/disk\/by-id\/scsi-0Vultr_Block_Storage_/);
  assert.match(value, /refusing to use the root filesystem device/);
  assert.match(value, /SECONDS \+ 300/);
  assert.match(value, /mkfs\.xfs/);
  assert.match(value, /defaults,pquota/);
  assert.match(value, /xmcl-shared-volume-setup\.service/);
  assert.match(value, /Requires=docker\.service xmcl-shared-volume-setup\.service/);
  assert.match(value, /\/etc\/xmcl-shared-node-agent\/quota-helper\.json/);
  assert.equal(value.includes("XMCL_XFS_DEVICE"), false);
  assert.equal(value.includes("/dev/vdb"), false);
  assert.equal(value.includes(config.firewallGroupId), false);
  assert.throws(
    () =>
      renderSharedNodeCloudInit({
        nodeId: "shared-node-1",
        ...config,
        volumeId: "vol-abc",
        workspaceRoot: "/var/lib/not-the-volume",
        controlPlaneCredential: "one-time-enrollment-token",
        totalMemoryMiB: 12 * 1024,
        totalSharedCpu: 8,
        totalWorkspaceGiB: 128,
      }),
    /shared node provisioning configuration is invalid/,
  );
});
