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
import type { TranslationJob } from "./translation_service.ts";
import type { AccountRuntime } from "./lib/accountRuntime.ts";
import type { WorkerRuntime } from "./lib/worker/runtime.ts";
import type { XmclPrincipal } from "./lib/session.ts";
import type { BillingService } from "./lib/billing.ts";
import type { PayPalService } from "./lib/paypal.ts";
import type { UsageSettlementService } from "./lib/usageSettlement.ts";
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
  /**
   * Offload a translation to a platform queue (Deno.Kv / Cloudflare Queue).
   * Returns true if accepted (route replies 202); absent or false means the
   * route translates inline. Azure has no queue and always translates inline.
   */
  enqueueTranslation?: (job: TranslationJob) => Promise<boolean>;
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
  paypalService?: PayPalService;
  usageSettlementService?: UsageSettlementService;
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
  TRANSLATION_KV?: unknown;
  TRANSLATION_QUEUE?: unknown;
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
