import type { Context } from "hono";
import { type AppConfig, getConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { AppEnv } from "./types.ts";
import { type BillingRuntime, createBillingRuntime } from "./billingRuntime.ts";
import type { SharedHostingService } from "./sharedHosting.ts";
import {
  DurableSharedNodeCommandGateway,
  MongoSharedNodeCommandOutbox,
  MongoSharedNodeCredentialRepository,
  MongoSharedNodeIngressRepository,
  MongoSharedWorkspaceManifestRepository,
  SharedNodeIngressAssignmentProvider,
  SharedNodeTransportService,
  type SharedNodeWorkspaceSigner,
} from "./sharedNodeTransport.ts";
import {
  hasValidSharedNodeBlockStorageSettings,
  hasValidSharedNodeFirewallSettings,
  hasValidSharedNodeIngressSettings,
  isImmutableSharedRuntimeImage,
  MongoSharedNodeProvisioningRepository,
  type SharedNodeVmProfile,
  VultrSharedNodeProvisioner,
} from "./sharedNodeProvisioner.ts";
import {
  isSharedNodeRegion,
  MongoSharedHostingSchedulerRepository,
  SharedHostingScheduler,
  type SharedNodeProvisioner,
} from "./sharedHostingScheduler.ts";
import { enabledSharedHostingRegions } from "./sharedHostingRegions.ts";
import {
  type SharedHostingBillingScheduledWork,
  sharedHostingBillingWork,
} from "./sharedHostingScheduling.ts";
import { VultrV2Adapter } from "./vultr.ts";
import {
  MixedSharedNodeProvisioner,
  MongoSharedNodeAllocationRepository,
  type SharedNodeCapacitySource,
} from "./sharedNodeInfrastructure.ts";

export interface SharedHostingRuntime {
  billing: BillingRuntime["billing"];
  sharedHosting: SharedHostingService;
  scheduler: SharedHostingScheduler;
  transport: SharedNodeTransportService;
  provisioner: SharedNodeProvisioner;
  billingScheduledWork: SharedHostingBillingScheduledWork;
}

function positiveSafeInteger(value: string | undefined) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function sharedNodeProfileFromConfig(
  config: AppConfig,
): SharedNodeVmProfile | undefined {
  if (!config.VULTR_SHARED_NODE_PLAN) return undefined;
  const totalMemoryMiB = positiveSafeInteger(
    config.VULTR_SHARED_NODE_TOTAL_MEMORY_MIB,
  );
  const totalSharedCpu = positiveSafeInteger(
    config.VULTR_SHARED_NODE_TOTAL_SHARED_CPU,
  );
  const totalWorkspaceGiB = positiveSafeInteger(
    config.VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB,
  );
  if (
    totalMemoryMiB === undefined ||
    totalSharedCpu === undefined ||
    totalWorkspaceGiB === undefined
  ) {
    return undefined;
  }
  return {
    profileId:
      `shared-${config.VULTR_SHARED_NODE_PLAN}-${totalMemoryMiB}m-${totalSharedCpu}c-${totalWorkspaceGiB}g`,
    providerPlan: config.VULTR_SHARED_NODE_PLAN,
    workloadClasses: ["standard", "large"],
    totalMemoryMiB,
    totalSharedCpu,
    totalWorkspaceGiB,
  };
}

export function hasSharedNodeSettings(config: AppConfig) {
  const regions = sharedNodeRegionsFromConfig(config);
  const capacityMode = sharedNodeCapacityModeFromConfig(config);
  const common = Boolean(
    config.BILLING_RATES_JSON &&
      regions &&
      config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT &&
      config.XMCL_VULTR_OBJECT_STORAGE_REGION &&
      config.XMCL_VULTR_OBJECT_STORAGE_BUCKET &&
      hasValidSharedNodeIngressSettings(
        config.XMCL_SHARED_NODE_INGRESS_PORT_MIN,
        config.XMCL_SHARED_NODE_INGRESS_PORT_MAX,
      ),
  );
  if (!common || !capacityMode) return false;
  if (capacityMode === "preprovisioned") {
    return true;
  }
  const profile = sharedNodeProfileFromConfig(config);
  return Boolean(
    config.VULTR_API_TOKEN &&
      profile &&
      config.VULTR_SHARED_NODE_IMAGE_ID &&
      config.XMCL_SHARED_AGENT_RELEASE_URL &&
      config.XMCL_SHARED_AGENT_RELEASE_SHA256 &&
      config.XMCL_SHARED_QUOTA_HELPER_RELEASE_URL &&
      config.XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256 &&
      config.XMCL_CONTROL_PLANE_URL &&
      isImmutableSharedRuntimeImage(config.XMCL_SHARED_NODE_CONTAINER_IMAGE) &&
      hasValidSharedNodeBlockStorageSettings(
        config.VULTR_SHARED_NODE_BLOCK_STORAGE_GIB,
        config.VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE,
        profile?.totalWorkspaceGiB,
      ) &&
      hasValidSharedNodeFirewallSettings(
        config.VULTR_SHARED_NODE_FIREWALL_GROUP_ID,
        config.XMCL_SHARED_NODE_INGRESS_PORT_MIN,
        config.XMCL_SHARED_NODE_INGRESS_PORT_MAX,
      ),
  );
}

export function sharedNodeRegionsFromConfig(config: AppConfig) {
  const values = (
    config.XMCL_SHARED_NODE_REGION_IDS ??
      config.VULTR_SHARED_NODE_REGION_IDS
  )?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ??
    (config.VULTR_SHARED_NODE_REGION_ID
      ? [config.VULTR_SHARED_NODE_REGION_ID]
      : []);
  try {
    return enabledSharedHostingRegions(values).map((region) => region.regionId);
  } catch {
    return undefined;
  }
}

export function sharedNodeCapacityModeFromConfig(config: AppConfig) {
  const value = config.XMCL_SHARED_NODE_CAPACITY_MODE ?? "vultr";
  return value === "vultr" || value === "preprovisioned" ? value : undefined;
}

export function createSharedHostingRuntime(
  db: Db,
  config: AppConfig,
  workspaceSigner?: SharedNodeWorkspaceSigner,
): SharedHostingRuntime {
  if (!hasSharedNodeSettings(config)) {
    throw new Error("shared node production settings are incomplete");
  }
  const capacityMode = sharedNodeCapacityModeFromConfig(config)!;
  const profile = capacityMode === "vultr"
    ? sharedNodeProfileFromConfig(config)!
    : undefined;
  const regions = sharedNodeRegionsFromConfig(config)!;
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
    { region: regions[0], regions },
  );
  const provisioningRepository = new MongoSharedNodeProvisioningRepository(db);
  const capacitySources: SharedNodeCapacitySource[] = capacityMode === "vultr"
    ? regions.map((region) => {
      const provider = new VultrV2Adapter({
        token: config.VULTR_API_TOKEN!,
        regionId: region,
        allowedPlans: [config.VULTR_SHARED_NODE_PLAN!],
        imageId: config.VULTR_SHARED_NODE_IMAGE_ID!,
      });
      const provisioner = new VultrSharedNodeProvisioner({
        provider,
        volumeProvider: provider,
        scheduler,
        repository: provisioningRepository,
        enrollmentRepository: credentialRepository,
        registration: {
          isRegistered: (nodeId) => scheduler.hasNode(nodeId),
        },
        config: {
          providerPlan: profile!.providerPlan,
          firewallGroupId: config.VULTR_SHARED_NODE_FIREWALL_GROUP_ID!,
          releaseUrl: config.XMCL_SHARED_AGENT_RELEASE_URL!,
          releaseSha256: config.XMCL_SHARED_AGENT_RELEASE_SHA256!,
          quotaHelperReleaseUrl: config.XMCL_SHARED_QUOTA_HELPER_RELEASE_URL!,
          quotaHelperReleaseSha256: config
            .XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256!,
          controlPlaneUrl: config.XMCL_CONTROL_PLANE_URL!,
          region,
          blockStorageSizeGiB: Number(
            config.VULTR_SHARED_NODE_BLOCK_STORAGE_GIB,
          ),
          blockStorageType: config.VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE!,
          objectStorageEndpoint: config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
          objectStorageRegion: config.XMCL_VULTR_OBJECT_STORAGE_REGION,
          objectStorageBucket: config.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
          containerImage: config.XMCL_SHARED_NODE_CONTAINER_IMAGE!,
          workspaceRoot: config.XMCL_WORKSPACE_ROOT,
          rconStopTimeoutSeconds: config.XMCL_RCON_STOP_TIMEOUT_SECONDS
            ? Number(config.XMCL_RCON_STOP_TIMEOUT_SECONDS)
            : undefined,
          xfsProjectBase: config.XMCL_XFS_PROJECT_BASE
            ? Number(config.XMCL_XFS_PROJECT_BASE)
            : undefined,
        },
        profiles: [profile!],
      });
      return {
        offer: {
          providerId: "vultr",
          offerId: `vultr:${region}:${profile!.profileId}`,
          region,
          workloadClasses: profile!.workloadClasses,
          totalMemoryMiB: profile!.totalMemoryMiB,
          totalSharedCpu: profile!.totalSharedCpu,
          totalWorkspaceGiB: profile!.totalWorkspaceGiB,
          priority: 100,
        },
        provisioner,
      };
    })
    : [];
  const provisioner = new MixedSharedNodeProvisioner(
    capacitySources,
    new MongoSharedNodeAllocationRepository(db),
  );
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
  scheduler.attachRetentionPurger((service) =>
    transport.purgeRetainedWorkspace(service)
  );
  return {
    billing: billing.billing,
    sharedHosting: billing.sharedHosting,
    scheduler,
    transport,
    provisioner,
    billingScheduledWork: sharedHostingBillingWork(
      billing.sharedHosting,
      scheduler,
    ),
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
  const billing = c.get("billingService");
  if (transport && scheduler && sharedHosting && provisioner && billing) {
    return {
      billing,
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
  c.set("billingService", runtime.billing);
  c.set("sharedHostingService", runtime.sharedHosting);
  return runtime;
}
