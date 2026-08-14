import type { Db } from "./db.ts";
import type { AuditEvent, AuditLog } from "./audit.ts";
import type { MetricsReader } from "./observability.ts";
import type {
  AdminOperationRepository,
  AdminOperationService,
  AdminPrincipal,
  AdminPrincipalAuthenticator,
  BillingAdminOperationCommandAdapter,
  ServerControlAdminOperationCommandAdapter,
} from "./operations.ts";
import type { ReconciliationRepository } from "./reconciliation.ts";
import type {
  WorldBackupRestoreWorkerPrincipal,
  WorldBackupService,
} from "./worldBackupService.ts";
import type { AccountRuntime } from "./accountRuntime.ts";
import type { WorkerRuntime } from "./worker/runtime.ts";
import type { XmclPrincipal } from "./session.ts";
import type { BillingService } from "./billing.ts";
import type { BillingRuntime } from "./billingRuntime.ts";
import type { WaffoService } from "./waffo.ts";
import type { UsageSettlementService } from "./usageSettlement.ts";
import type { SharedHostingService } from "./sharedHosting.ts";
import type { XmclPlusService } from "./xmclPlus.ts";
import type { SharedHostingScheduler } from "./sharedHostingScheduler.ts";
import type { SharedHostingBillingScheduledWork } from "./sharedHostingScheduling.ts";
import type { SharedNodeTransportService } from "./sharedNodeTransport.ts";
import type { SharedNodeProvisioner } from "./sharedHostingScheduler.ts";
import type { AiServiceDependencies } from "./ai/service.ts";
import type { ServerControlRuntime } from "./serverControlRuntime.ts";
import type {
  ServerCompatibilityGateway,
  WorkerDeploymentGateway,
} from "./deploymentTasks.ts";
import type { ModpackDeploymentRuntime } from "./modpackDeploymentRuntime.ts";
import type {
  CompilerGrantAuthority,
  SharedModdedRuntimeService,
} from "./sharedModdedRuntime.ts";
import type { SharedWorldSeedService } from "./sharedWorldSeed.ts";
import type { DurableObjectNamespace } from "./cloudflare/types.ts";

export interface MicrosoftMinecraftProfile {
  id: string;
  name: string;
}

export interface MicrosoftProfile {
  id: string;
  userPrincipalName: string;
}

/** Per-request values shared between middleware and route handlers. */
export interface AppVariables {
  /** Lazily opens (and caches) the MongoDB connection for this isolate. */
  getDb: () => Promise<Db>;
  /** Keeps non-critical persistence alive after a Cloudflare response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Set by the Minecraft auth middleware when a valid token is present. */
  minecraftProfile?: MicrosoftMinecraftProfile;
  /** Set by the Microsoft Graph auth middleware. */
  microsoftProfile?: MicrosoftProfile;
  /** ISO country code resolved by a platform geo middleware (Deno/Azure). */
  country?: string;
  /** Optional Account test/platform override; production builds it from DB + env. */
  accountRuntime?: AccountRuntime;
  xmclPrincipal?: XmclPrincipal;
  /** Independent admin-session verifier; never accepts normal user sessions. */
  adminOperationAuthenticator?: AdminPrincipalAuthenticator;
  /** Set only by the AdminOperation admin middleware after the independent verification. */
  adminPrincipal?: AdminPrincipal;
  /** Fully composed AdminOperation service override for tests or platform composition. */
  adminOperationService?: AdminOperationService;
  /** Durable AdminOperation command dependencies for the mounted route composition. */
  adminOperationRepository?: AdminOperationRepository;
  adminOperationAuditLog?: AuditLog;
  billingAdminOperationAdapter?: BillingAdminOperationCommandAdapter;
  serverControlAdminOperationAdapter?:
    ServerControlAdminOperationCommandAdapter;
  adminOperationNow?: () => string;
  adminOperationAuditEvents?: () => Promise<
    { items: AuditEvent[]; nextCursor?: string }
  >;
  adminOperationMetrics?: MetricsReader;
  adminOperationReconciliation?: Pick<ReconciliationRepository, "latest">;
  /** Read-only account projection supplied by the account owner. */
  adminOperationAccountReader?: { read(accountId: string): Promise<unknown> };
  adminOperationAccountSearch?: {
    search(query: string): Promise<{ items: unknown[] }>;
  };
  /** WorldBackup platform composition injects its owned backup adapter. */
  worldBackupService?: WorldBackupService;
  /** Dedicated Worker/internal-service authenticator for WorldBackup restore event callbacks. */
  worldBackupRestoreWorkerAuthenticator?: {
    authenticate(input: {
      authorization?: string;
      method: string;
      path: string;
      body: string;
      timestamp?: string;
      nonce?: string;
      signature?: string;
    }): Promise<WorldBackupRestoreWorkerPrincipal | undefined>;
  };
  /** Billing dependencies are injected by platform composition; never browser supplied. */
  billingService?: BillingService;
  billingRuntime?: BillingRuntime;
  waffoService?: WaffoService;
  usageSettlementService?: UsageSettlementService;
  /** Shared-hosting plan subscriptions and renewal billing. */
  sharedHostingService?: SharedHostingService;
  /** XMCL Plus subscription and allowance projection. */
  xmclPlusService?: XmclPlusService;
  /** Global shared-node scheduler; Docker and direct grant transfers remain node-agent owned. */
  sharedHostingScheduler?: SharedHostingScheduler;
  /** Trusted UTC renewal sweep; never supplied by a browser request. */
  sharedHostingBillingScheduledWork?: SharedHostingBillingScheduledWork;
  /** Authenticated internal transport for shared-node agents. */
  sharedNodeTransport?: SharedNodeTransportService;
  sharedNodeProvisioner?: SharedNodeProvisioner;
  /** Compiler-owned shared modpack deployment composition; never browser supplied. */
  sharedModdedRuntime?: SharedModdedRuntimeService;
  /** Service-owned local world seed lifecycle; no browser storage credentials. */
  sharedWorldSeedService?: SharedWorldSeedService;
  /** Compiler callback middleware sets this only after server-side authentication. */
  sharedModdedCompilerPrincipal?: { compilerId: string };
  /** Exact bytes verified by compiler workload identity before callback JSON parsing. */
  sharedModdedCompilerRawBody?: Uint8Array;
  /** Compiler grant issuer is separate from all node command grants. */
  sharedModdedCompilerGrants?: CompilerGrantAuthority;
  /** Complete ServerControl composition; absent routes and scheduled work fail explicitly. */
  serverControlRuntime?: ServerControlRuntime;
  /** Platform composition injects ServerControl/Billing-backed Worker worker adapters here. */
  workerRuntime?: WorkerRuntime;
  /** Ai platform composition supplies server-only provider, Billing gateway, and durable request store. */
  aiServiceDependencies?: AiServiceDependencies;
  /** ModpackDeployment-owned durable composition; it receives only these external ServerControl/Worker adapters. */
  modpackDeploymentRuntime?: ModpackDeploymentRuntime;
  /** ServerControl's account-owned server/template lifecycle projection for ModpackDeployment. */
  modpackDeploymentServerControlTarget?: ServerCompatibilityGateway;
  /** Worker's staging, atomic-switch, and snapshot-restore adapter for ModpackDeployment. */
  modpackDeploymentWorkerStaging?: WorkerDeploymentGateway;
}

/**
 * Cloudflare resource bindings. Secret/text vars are read through hono/adapter
 * `env(c)` and typed in `AppConfig`, so they are intentionally loose here.
 */
export interface AppBindings {
  MULTIPLAYER_ROOMS?: unknown;
  SHARED_NODE_WORKSPACE_SIGNER?: unknown;
  TRANSLATION_CACHE?: unknown;
  DPOP_REPLAY?: DurableObjectNamespace;
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
