import type {
  BillingSettlementAdapter,
  BillingSettlementResult,
  CanonicalServerTimeUsage,
  LeaseBinding,
  ServerControlLeaseAdapter,
} from "./service.ts";

/** Deterministic in-memory ServerControl adapter for route composition tests only. */
export class DeterministicM4LeaseAdapter implements ServerControlLeaseAdapter {
  constructor(private readonly leases: readonly LeaseBinding[]) {}

  getLease(serverId: string, leaseId: string) {
    return Promise.resolve(
      this.leases.find((lease) =>
        lease.serverId === serverId && lease.leaseId === leaseId
      ),
    );
  }
}

/** Deterministic in-memory Billing adapter for route composition tests only. */
export class DeterministicM3SettlementAdapter
  implements BillingSettlementAdapter {
  readonly received: CanonicalServerTimeUsage[] = [];

  constructor(
    private readonly result: Omit<BillingSettlementResult, "usageEventId">,
  ) {}

  settle(event: CanonicalServerTimeUsage): Promise<BillingSettlementResult> {
    this.received.push(structuredClone(event));
    return Promise.resolve({
      ...this.result,
      usageEventId: event.eventId,
    });
  }
}
