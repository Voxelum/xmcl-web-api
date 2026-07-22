import type { Context } from "hono";
import type { AppEnv } from "../types.ts";
import type {
  AdminOperationCompleted,
  AdminOperationRequested,
  BillingAuthorizationGateway,
  WorkerGateway,
  WorldBackupDeletionGateway,
} from "./serverControlProposals.ts";
import {
  type ServerControlOptions,
  ServerControlService,
  type SweepResult,
} from "./serverControl.ts";
import type { ServerRepository } from "./serverRepository.ts";
import type { VultrAdapter } from "./vultr.ts";

export interface ServerControlExpiredStopScanner {
  listExpiredStops(
    at: string,
  ): Promise<Array<{ accountId: string; taskId: string }>>;
}

export interface AdminOperationOperationAdapter {
  complete(
    accountId: string,
    completion: AdminOperationCompleted,
  ): Promise<void>;
}

export interface ServerControlRuntime {
  service: ServerControlService;
  sweepExpiredStops(at?: string): Promise<SweepResult[]>;
  handleAdminOperation(
    accountId: string,
    event: AdminOperationRequested,
  ): Promise<AdminOperationCompleted>;
}

export interface ServerControlRuntimeDependencies extends
  Omit<
    ServerControlOptions,
    "repository" | "provider" | "authorizations" | "worker" | "deletion"
  > {
  repository: ServerRepository;
  vultr: VultrAdapter;
  billingAuthorizations: BillingAuthorizationGateway;
  workerStops: WorkerGateway;
  worldBackupDeletion: WorldBackupDeletionGateway;
  expiredStops: ServerControlExpiredStopScanner;
  adminOperationService: AdminOperationOperationAdapter;
}

export class ServerControlRuntimeConfigurationError extends Error {
  constructor(
    message =
      "ServerControl runtime requires injected Billing, Worker, WorldBackup, AdminOperation, Vultr, and stop-sweep adapters",
  ) {
    super(message);
  }
}

export function createServerControlRuntime(
  dependencies: ServerControlRuntimeDependencies,
): ServerControlRuntime {
  if (
    !dependencies.repository || !dependencies.vultr ||
    !dependencies.billingAuthorizations || !dependencies.workerStops ||
    !dependencies.worldBackupDeletion || !dependencies.expiredStops ||
    !dependencies.adminOperationService
  ) {
    throw new ServerControlRuntimeConfigurationError();
  }
  const service = new ServerControlService({
    ...dependencies,
    provider: dependencies.vultr,
    authorizations: dependencies.billingAuthorizations,
    worker: dependencies.workerStops,
    deletion: dependencies.worldBackupDeletion,
  });
  return {
    service,
    async sweepExpiredStops(at = new Date().toISOString()) {
      return await service.sweepExpiredStops(
        await dependencies.expiredStops.listExpiredStops(at),
        at,
      );
    },
    async handleAdminOperation(accountId, event) {
      const completion = await service.handleAdminOperation(accountId, event);
      await dependencies.adminOperationService.complete(accountId, completion);
      return completion;
    },
  };
}

export function getServerControlRuntime(
  context: Context<AppEnv>,
): ServerControlRuntime {
  const runtime = context.get("serverControlRuntime");
  if (!runtime) throw new ServerControlRuntimeConfigurationError();
  return runtime;
}
