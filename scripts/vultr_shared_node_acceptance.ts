import { MongoClient } from "mongodb";
import process from "node:process";
import type { Db } from "../src/db.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "../src/sharedHostingScheduler.ts";
import {
  MemorySharedNodeProvisioningRepository,
  VultrSharedNodeProvisioner,
} from "../src/sharedNodeProvisioner.ts";
import { MongoSharedNodeCredentialRepository } from "../src/sharedNodeTransport.ts";
import { VultrV2Adapter } from "../src/vultr.ts";

async function main() {
  const acknowledgement = "I_UNDERSTAND_TEMPORARY_RESOURCES";
  if (process.env.VULTR_LIVE_ACCEPTANCE !== acknowledgement) {
    throw new Error(
      `Set VULTR_LIVE_ACCEPTANCE=${acknowledgement} to run this cost-incurring check`,
    );
  }

  function required(name: string) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  }

  function integer(name: string) {
    const value = Number(required(name));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  }

  const region = required("VULTR_SHARED_NODE_REGION_ID");
  const plan = required("VULTR_SHARED_NODE_PLAN");
  const requestId = `acceptance-${Date.now()}-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const nodeId = `shared-node-${requestId}`;
  const mongo = new MongoClient(required("MONGO_CONNECION_STRING"));
  await mongo.connect();
  const database = mongo.db(required("MONGODB_NAME"));
  const db = database as unknown as Db;
  const credentials = new MongoSharedNodeCredentialRepository(db);
  const scheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    {
      activeSubscription: async () => {
        throw new Error("subscriptions are not used by node acceptance");
      },
    },
    { dispatch: async () => {} },
    undefined,
    { region },
  );
  const provider = new VultrV2Adapter({
    token: required("VULTR_API_TOKEN"),
    regionId: region,
    allowedPlans: [plan],
    imageId: required("VULTR_SHARED_NODE_IMAGE_ID"),
  });
  const repository = new MemorySharedNodeProvisioningRepository();
  const provisioner = new VultrSharedNodeProvisioner({
    provider,
    volumeProvider: provider,
    scheduler,
    repository,
    enrollmentRepository: credentials,
    registration: {
      isRegistered: async (candidate) =>
        Boolean(await credentials.findCredential(candidate)),
    },
    config: {
      providerPlan: plan,
      firewallGroupId: required("VULTR_SHARED_NODE_FIREWALL_GROUP_ID"),
      releaseUrl: required("XMCL_SHARED_AGENT_RELEASE_URL"),
      releaseSha256: required("XMCL_SHARED_AGENT_RELEASE_SHA256"),
      quotaHelperReleaseUrl: required("XMCL_SHARED_QUOTA_HELPER_RELEASE_URL"),
      quotaHelperReleaseSha256: required(
        "XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256",
      ),
      controlPlaneUrl: required("XMCL_CONTROL_PLANE_URL"),
      region,
      blockStorageSizeGiB: integer("VULTR_SHARED_NODE_BLOCK_STORAGE_GIB"),
      blockStorageType: required("VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE"),
      objectStorageEndpoint: required("XMCL_VULTR_OBJECT_STORAGE_ENDPOINT"),
      objectStorageRegion: required("XMCL_VULTR_OBJECT_STORAGE_REGION"),
      objectStorageBucket: required("XMCL_VULTR_OBJECT_STORAGE_BUCKET"),
      containerImage: required("XMCL_SHARED_NODE_CONTAINER_IMAGE"),
    },
    profiles: [{
      profileId: "live-acceptance",
      providerPlan: plan,
      workloadClasses: ["standard", "large"],
      totalMemoryMiB: integer("VULTR_SHARED_NODE_TOTAL_MEMORY_MIB"),
      totalSharedCpu: integer("VULTR_SHARED_NODE_TOTAL_SHARED_CPU"),
      totalWorkspaceGiB: integer("VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB"),
    }],
    pollIntervalMs: 5_000,
    registrationTimeoutMs: 15 * 60_000,
  });

  let acceptanceError: unknown;
  try {
    console.log(`Provisioning temporary shared node ${nodeId} in ${region}`);
    await provisioner.requestCapacity({
      requestId,
      region,
      workloadClass: "standard",
      minimumMemoryMiB: 4 * 1024,
      minimumSharedCpu: 2,
      minimumWorkspaceGiB: 32,
    });
    const credential = await credentials.findCredential(nodeId);
    const heartbeat = await credentials.findHeartbeat(nodeId);
    if (!credential || !heartbeat || heartbeat.status !== "ready") {
      throw new Error("node registered without a ready heartbeat");
    }
    console.log(
      `Node registered: agent=${heartbeat.agentVersion}, ingress=${heartbeat.ingress.host}`,
    );
  } catch (error) {
    acceptanceError = error;
  } finally {
    const record = await repository.find(requestId);
    try {
      if (record?.status === "ready") {
        await provisioner.drainNode(nodeId);
      } else if (record) {
        if (record.instanceId) await provider.delete(record.instanceId);
        if (record.volumeId) {
          const volume = await provider.getVolume(record.volumeId);
          if (volume?.attachedToInstance) {
            await provider.detachVolume(record.volumeId);
          }
          await provider.deleteVolume(record.volumeId);
        }
      }
      await database.collection<{ _id: string }>("shared_node_credentials")
        .deleteOne({
          _id: nodeId,
        });
      await database.collection<{ _id: string }>("shared_node_enrollments")
        .deleteOne({
          _id: nodeId,
        });
      await database.collection<{ _id: string }>("shared_node_heartbeats")
        .deleteOne({
          _id: nodeId,
        });
      console.log(`Temporary shared node ${nodeId} was removed`);
    } catch (cleanupError) {
      throw new AggregateError(
        [acceptanceError, cleanupError].filter((value) => value !== undefined),
        "Vultr acceptance or cleanup failed",
      );
    } finally {
      await mongo.close();
    }
  }

  if (acceptanceError) throw acceptanceError;
  console.log("Vultr shared-node live acceptance passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
