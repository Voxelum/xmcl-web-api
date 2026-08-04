import type { Context } from "hono";
import type { AppEnv } from "../../types.ts";
import { WorkerRequestAuthenticator } from "../workerAuth.ts";
import type { WorkerRepository } from "../workerRepository.ts";
import {
  type BillingSettlementAdapter,
  type ServerControlLeaseAdapter,
  type WorkerRuntimeDependencies as WorkerServiceDependencies,
  WorkerRuntimeService,
} from "./service.ts";

export interface WorkerRuntime {
  authenticator: WorkerRequestAuthenticator;
  service: WorkerRuntimeService;
  requestId?: () => string;
}

export interface WorkerRuntimeConfiguration
  extends Omit<WorkerServiceDependencies, "leases" | "settlements"> {
  serverControlLeases: ServerControlLeaseAdapter;
  billingSettlements: BillingSettlementAdapter;
  authenticator?: WorkerRequestAuthenticator;
  requestId?: () => string;
}

export class WorkerRuntimeConfigurationError extends Error {
  constructor() {
    super(
      "Worker runtime requires injected ServerControl lease and Billing settlement adapters",
    );
  }
}

export function createWorkerRuntime(
  dependencies: WorkerRuntimeConfiguration,
): WorkerRuntime {
  const serviceDependencies: WorkerServiceDependencies = {
    ...dependencies,
    leases: dependencies.serverControlLeases,
    settlements: dependencies.billingSettlements,
  };
  return {
    authenticator: dependencies.authenticator ??
      new WorkerRequestAuthenticator(
        dependencies.repository as WorkerRepository,
      ),
    service: new WorkerRuntimeService(serviceDependencies),
    requestId: dependencies.requestId,
  };
}

export type WorkerRuntimeResolver = (
  context: Context<AppEnv>,
) => Promise<WorkerRuntime>;

export function getWorkerRuntime(
  context: Context<AppEnv>,
): Promise<WorkerRuntime> {
  const runtime = context.get("workerRuntime");
  if (!runtime) return Promise.reject(new WorkerRuntimeConfigurationError());
  return Promise.resolve(runtime);
}
