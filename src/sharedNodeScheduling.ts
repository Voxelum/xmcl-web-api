import type { SharedNodeTransportService } from "./sharedNodeTransport.ts";

export interface SharedNodeScheduledWork {
  sweep(at: string): Promise<{ redelivered: number }>;
}

export class SharedNodeSchedulingConfigurationError extends Error {
  constructor() {
    super("SHARED_NODE_SCHEDULED_WORK must provide sweep(at)");
  }
}

export async function runSharedNodeScheduledSweep(
  work: SharedNodeScheduledWork | SharedNodeTransportService | undefined,
  at: string,
) {
  if (!work || typeof work.sweep !== "function") {
    throw new SharedNodeSchedulingConfigurationError();
  }
  return await work.sweep(at);
}
