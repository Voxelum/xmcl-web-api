import type { Context } from "hono";
import { type AppConfig, getConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { AppEnv } from "../types.ts";
import { createBillingRuntime } from "./billingRuntime.ts";
import type { SharedHostingService } from "./sharedHosting.ts";
import {
  DurableSharedNodeCommandGateway,
  MongoSharedNodeCommandOutbox,
  MongoSharedNodeCredentialRepository,
  MongoSharedNodeIngressRepository,
  MongoSharedWorkspaceManifestRepository,
  SharedNodeIngressAssignmentProvider,
  type SharedNodeWorkspaceSigner,
  SharedNodeTransportService,
} from "./sharedNodeTransport.ts";
import {
  hasValidSharedNodeBlockStorageSettings,
  hasValidSharedNodeFirewallSettings,
  MongoSharedNodeProvisioningRepository,
  VultrSharedNodeProvisioner,
} from "./sharedNodeProvisioner.ts";
import {
  MongoSharedHostingSchedulerRepository,
  SharedHostingScheduler,
  isSharedNodeRegion,
} from "./sharedHostingScheduler.ts";
import {
  sharedHostingBillingWork,
  type SharedHostingBillingScheduledWork,
} from "./sharedHostingScheduling.ts";
import { VultrV2Adapter } from "./vultr.ts";

export interface SharedHostingRuntime {
  sharedHosting: SharedHostingService;
  scheduler: SharedHostingScheduler;
  transport: SharedNodeTransportService;
  provisioner: VultrSharedNodeProvisioner;
  billingScheduledWork: SharedHostingBillingScheduledWork;
}

export function hasSharedNodeSettings(config: AppConfig) {
  return Boolean(
    config.BILLING_RATES_JSON &&
      config.VULTR_API_TOKEN &&
    isSharedNodeRegion(config.VULTR_SHARED_NODE_REGION_ID) &&
      config.VULTR_SHARED_NODE_PLAN &&
      config.VULTR_SHARED_NODE_IMAGE_ID &&
      config.XMCL_SHARED_AGENT_RELEASE_URL &&
      config.XMCL_SHARED_AGENT_RELEASE_SHA256 &&
      config.XMCL_SHARED_QUOTA_HELPER_RELEASE_URL &&
      config.XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256 &&
      config.XMCL_CONTROL_PLANE_URL &&
      config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT &&
      config.XMCL_VULTR_OBJECT_STORAGE_REGION &&
      config.XMCL_VULTR_OBJECT_STORAGE_BUCKET &&
      config.XMCL_SHARED_NODE_CONTAINER_IMAGE &&
      hasValidSharedNodeBlockStorageSettings(
        config.VULTR_SHARED_NODE_BLOCK_STORAGE_GIB,
        config.VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE,
      ) &&
      hasValidSharedNodeFirewallSettings(
        config.VULTR_SHARED_NODE_FIREWALL_GROUP_ID,
        config.XMCL_SHARED_NODE_INGRESS_PORT_MIN,
        config.XMCL_SHARED_NODE_INGRESS_PORT_MAX,
      ),
  );
}

export function createSharedHostingRuntime(
  db: Db,
  config: AppConfig,
  workspaceSigner?: SharedNodeWorkspaceSigner,
): SharedHostingRuntime {
  if (!hasSharedNodeSettings(config)) {
    throw new Error("shared node production settings are incomplete");
  }
  const billing = createBillingRuntime(db, config);
  const credentialRepository = new MongoSharedNodeCredentialRepository(db);
  const outbox = new MongoSharedNodeCommandOutbox(db);
  const ingressRepository = new MongoSharedNodeIngressRepository(db);
  const ingress = new SharedNodeIngressAssignmentProvider(
    ingressRepository,
    credentialRepository,
    {
      portMin: config.XMCL_SHARED_NODE_INGRESS_PORT_MIN
        ? Number(config.XMCL_SHARED_NODE_INGRESS_PORT_MIN)
        : undefined,
      portMax: config.XMCL_SHARED_NODE_INGRESS_PORT_MAX
        ? Number(config.XMCL_SHARED_NODE_INGRESS_PORT_MAX)
        : undefined,
    },
  );
  const scheduler = new SharedHostingScheduler(
    new MongoSharedHostingSchedulerRepository(db),
    billing.sharedHosting,
    new DurableSharedNodeCommandGateway(outbox, ingress),
    undefined,
    { region: config.VULTR_SHARED_NODE_REGION_ID! },
  );
  const provider = new VultrV2Adapter({
    token: config.VULTR_API_TOKEN!,
    regionId: config.VULTR_SHARED_NODE_REGION_ID!,
    allowedPlans: [config.VULTR_SHARED_NODE_PLAN!],
    imageId: config.VULTR_SHARED_NODE_IMAGE_ID!,
  });
  const provisioner = new VultrSharedNodeProvisioner({
    provider,
    volumeProvider: provider,
    scheduler,
    repository: new MongoSharedNodeProvisioningRepository(db),
    enrollmentRepository: credentialRepository,
    registration: {
      isRegistered: (nodeId) => scheduler.hasNode(nodeId),
    },
    config: {
      providerPlan: config.VULTR_SHARED_NODE_PLAN,
      firewallGroupId: config.VULTR_SHARED_NODE_FIREWALL_GROUP_ID!,
      releaseUrl: config.XMCL_SHARED_AGENT_RELEASE_URL!,
      releaseSha256: config.XMCL_SHARED_AGENT_RELEASE_SHA256!,
      quotaHelperReleaseUrl: config.XMCL_SHARED_QUOTA_HELPER_RELEASE_URL!,
      quotaHelperReleaseSha256:
        config.XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256!,
      controlPlaneUrl: config.XMCL_CONTROL_PLANE_URL!,
      region: config.VULTR_SHARED_NODE_REGION_ID!,
      blockStorageSizeGiB: Number(
        config.VULTR_SHARED_NODE_BLOCK_STORAGE_GIB,
      ),
      blockStorageType: config.VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE!,
      objectStorageEndpoint: config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
      objectStorageRegion: config.XMCL_VULTR_OBJECT_STORAGE_REGION,
      objectStorageBucket: config.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
      containerImage: config.XMCL_SHARED_NODE_CONTAINER_IMAGE,
      workspaceRoot: config.XMCL_WORKSPACE_ROOT,
      rconStopTimeoutSeconds: config.XMCL_RCON_STOP_TIMEOUT_SECONDS
        ? Number(config.XMCL_RCON_STOP_TIMEOUT_SECONDS)
        : undefined,
      xfsProjectBase: config.XMCL_XFS_PROJECT_BASE
        ? Number(config.XMCL_XFS_PROJECT_BASE)
        : undefined,
    },
  });
  scheduler.attachProvisioner(provisioner);
  const transport = new SharedNodeTransportService({
    credentialRepository,
    enrollmentRepository: credentialRepository,
    commandOutbox: outbox,
    scheduler,
    workspaceSigner,
    workspaceManifestRepository: new MongoSharedWorkspaceManifestRepository(db),
    ingressRepository,
  });
  return {
    sharedHosting: billing.sharedHosting,
    scheduler,
    transport,
    provisioner,
    billingScheduledWork: sharedHostingBillingWork(billing.sharedHosting, scheduler),
  };
}

export async function getSharedHostingRuntime(
  c: Context<AppEnv>,
  workspaceSigner?: SharedNodeWorkspaceSigner,
): Promise<SharedHostingRuntime> {
  const transport = c.get("sharedNodeTransport");
  const scheduler = c.get("sharedHostingScheduler");
  const sharedHosting = c.get("sharedHostingService");
  const provisioner = c.get("sharedNodeProvisioner");
  if (transport && scheduler && sharedHosting && provisioner) {
    return {
      sharedHosting,
      scheduler,
      transport,
      provisioner,
      billingScheduledWork: sharedHostingBillingWork(sharedHosting, scheduler),
    };
  }
  const runtime = createSharedHostingRuntime(
    await c.get("getDb")(),
    getConfig(c),
    workspaceSigner ?? (c.env as {
      SHARED_NODE_WORKSPACE_SIGNER?: SharedNodeWorkspaceSigner;
    }).SHARED_NODE_WORKSPACE_SIGNER,
  );
  c.set("sharedNodeTransport", runtime.transport);
  c.set("sharedHostingScheduler", runtime.scheduler);
  c.set("sharedNodeProvisioner", runtime.provisioner);
  c.set("sharedHostingBillingScheduledWork", runtime.billingScheduledWork);
  c.set("sharedHostingService", runtime.sharedHosting);
  return runtime;
}
