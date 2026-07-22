import {
  type ModpackArchiveStore,
  ModpackDeploymentCoordinator,
  type ModpackDeploymentRepository,
  type ModpackDeploymentTaskDispatcher,
  type ServerCompatibilityGateway,
  type WorkerDeploymentGateway,
} from "./deploymentTasks.ts";
import type { ModpackSourceResolver } from "./modpackSources/types.ts";

/**
 * ModpackDeployment-owned durable dependencies are composed once by the platform. ServerControl and Worker
 * adapters are supplied separately at route composition so ModpackDeployment never constructs
 * or writes either module's resources.
 */
export interface ModpackDeploymentRuntime {
  createCoordinator(input: {
    serverControlTarget: ServerCompatibilityGateway;
    workerStaging: WorkerDeploymentGateway;
  }): ModpackDeploymentCoordinator;
}

export interface ModpackDeploymentRuntimeDependencies {
  repository: ModpackDeploymentRepository;
  archives: ModpackArchiveStore;
  dispatcher: ModpackDeploymentTaskDispatcher;
  resolvers: readonly ModpackSourceResolver[];
  now?: () => string;
  id?: (prefix: string) => string;
}

export function createModpackDeploymentRuntime(
  dependencies: ModpackDeploymentRuntimeDependencies,
): ModpackDeploymentRuntime {
  if (
    !dependencies.repository || !dependencies.archives ||
    !dependencies.dispatcher || !dependencies.resolvers
  ) {
    throw new Error(
      "ModpackDeployment runtime requires repository, archive, dispatcher, and source resolvers",
    );
  }
  return {
    createCoordinator({ serverControlTarget, workerStaging }) {
      return new ModpackDeploymentCoordinator(
        dependencies.repository,
        dependencies.archives,
        serverControlTarget,
        workerStaging,
        dependencies.dispatcher,
        dependencies.resolvers,
        dependencies.now,
        dependencies.id,
      );
    },
  };
}
