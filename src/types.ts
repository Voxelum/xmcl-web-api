import type { Db } from "./db.ts";
import type { AuditEvent, AuditLog } from "./lib/audit.ts";
import type { MetricsReader } from "./lib/observability.ts";
import type {
  AdminOperationRepository,
  AdminOperationService,
  AdminPrincipal,
  AdminPrincipalAuthenticator,
  BillingAdminOperationCommandAdapter,
  ServerControlAdminOperationCommandAdapter,
} from "./lib/operations.ts";
import type { ReconciliationRepository } from "./lib/reconciliation.ts";
import type {
  WorldBackupRestoreWorkerPrincipal,
  WorldBackupService,
} from "./lib/worldBackupService.ts";
import type { AccountRuntime } from "./lib/accountRuntime.ts";
import type { WorkerRuntime } from "./lib/worker/runtime.ts";
import type { XmclPrincipal } from "./lib/session.ts";
import type { BillingService } from "./lib/billing.ts";
import type { BillingRuntime } from "./lib/billingRuntime.ts";
import type { PayPalService } from "./lib/paypal.ts";
import type { UsageSettlementService } from "./lib/usageSettlement.ts";
import type { SharedHostingService } from "./lib/sharedHosting.ts";
import type { SharedHostingScheduler } from "./lib/sharedHostingScheduler.ts";
import type { SharedHostingBillingScheduledWork } from "./lib/sharedHostingScheduling.ts";
import type { SharedNodeTransportService } from "./lib/sharedNodeTransport.ts";
import type { VultrSharedNodeProvisioner } from "./lib/sharedNodeProvisioner.ts";
import type { AiServiceDependencies } from "./lib/ai/service.ts";
import type { ServerControlRuntime } from "./lib/serverControlRuntime.ts";
import type {
  ServerCompatibilityGateway,
  WorkerDeploymentGateway,
} from "./lib/deploymentTasks.ts";
import type { ModpackDeploymentRuntime } from "./lib/modpackDeploymentRuntime.ts";

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
  paypalService?: PayPalService;
  usageSettlementService?: UsageSettlementService;
  /** Shared-hosting plan subscriptions and renewal billing. */
  sharedHostingService?: SharedHostingService;
  /** Global shared-node scheduler; Docker and direct grant transfers remain node-agent owned. */
  sharedHostingScheduler?: SharedHostingScheduler;
  /** Trusted UTC renewal sweep; never supplied by a browser request. */
  sharedHostingBillingScheduledWork?: SharedHostingBillingScheduledWork;
  /** Authenticated internal transport for shared-node agents. */
  sharedNodeTransport?: SharedNodeTransportService;
  sharedNodeProvisioner?: VultrSharedNodeProvisioner;
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
 * Cloudflare resource bindings. Absent on Deno/Azure (where the realtime group
 * endpoint uses the native WebSocket upgrade instead of a Durable Object).
 * Secret/text vars are read through hono/adapter `env(c)` and typed in
 * `AppConfig`, so they are intentionally loose here.
 */
export interface AppBindings {
  GROUP_ROOM?: unknown;
  SHARED_NODE_WORKSPACE_SIGNER?: unknown;
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
