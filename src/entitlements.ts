import type { BillingStore } from "./ledger.ts";
import type { SharedHostingSubscription } from "./sharedHosting.ts";
import type { XmclPlusSubscription } from "./xmclPlus.ts";

export interface AccountEntitlements {
  ai: boolean;
  turn: boolean;
}

export class BillingEntitlementReader {
  constructor(
    private readonly store: BillingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(accountId: string): Promise<AccountEntitlements> {
    const now = this.now().getTime();
    return await this.store.read((state) => {
      const plus = [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .some((subscription) =>
          subscription.accountId === accountId &&
          subscription.status === "active" &&
          Date.parse(subscription.currentPeriodEndsAt) > now
        );
      const hosting = [...state.sharedHostingSubscriptions.values()]
        .map((value) => value as SharedHostingSubscription)
        .some((subscription) =>
          subscription.accountId === accountId &&
          subscription.status === "active" &&
          Date.parse(subscription.currentPeriodEndsAt) > now
        );
      return {
        ai: plus || hosting,
        turn: plus,
      };
    });
  }
}
