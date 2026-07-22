import type { SweepResult } from "./serverControl.ts";

export interface ServerControlScheduledWork {
  sweepExpiredStops(at: string): Promise<SweepResult[]>;
}

export class ServerControlSchedulingConfigurationError extends Error {
  constructor() {
    super("SERVER_CONTROL_SCHEDULED_WORK must provide sweepExpiredStops(at)");
  }
}

export async function runServerControlScheduledSweep(
  work: ServerControlScheduledWork | undefined,
  at: string,
): Promise<SweepResult[]> {
  if (!work || typeof work.sweepExpiredStops !== "function") {
    throw new ServerControlSchedulingConfigurationError();
  }
  return await work.sweepExpiredStops(at);
}
