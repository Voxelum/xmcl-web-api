import { AccountError, type AccountRepository, randomId } from "./account.ts";
import type { VerifiedIdentity } from "./oauth/types.ts";

export class AccountMergeService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(input: {
    currentAccountId: string;
    verifiedTargetIdentity: VerifiedIdentity;
    requestId: string;
  }) {
    const destination = await this.repository.getAccount(
      input.currentAccountId,
    );
    if (!destination || destination.status !== "active") {
      throw new AccountError(409, "account_not_active");
    }
    const binding = await this.repository.findIdentity(
      input.verifiedTargetIdentity.provider,
      input.verifiedTargetIdentity.subject,
    );
    if (!binding) throw new AccountError(404, "merge_target_not_found");
    if (binding.accountId === input.currentAccountId) {
      throw new AccountError(409, "same_account_merge");
    }
    const source = await this.repository.getAccount(binding.accountId);
    if (!source || source.status !== "active") {
      throw new AccountError(409, "merge_target_not_active");
    }
    const createdAt = this.now();
    const merge = {
      mergeId: randomId("mrg"),
      sourceAccountId: source.accountId,
      targetAccountId: destination.accountId,
      targetIdentity: {
        provider: input.verifiedTargetIdentity.provider,
        subject: input.verifiedTargetIdentity.subject,
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
      status: "prepared" as const,
    };
    await this.repository.saveMerge(merge);
    await this.repository.saveAudit({
      auditId: randomId("audit"),
      accountId: destination.accountId,
      action: "account.merge_prepared",
      occurredAt: createdAt.toISOString(),
      requestId: input.requestId,
      metadata: {
        mergeId: merge.mergeId,
        sourceIdentityProvider: input.verifiedTargetIdentity.provider,
      },
    });
    return {
      mergeId: merge.mergeId,
      expiresAt: merge.expiresAt,
      destinationAccountId: destination.accountId,
      sourceSummary: { identities: source.identities.length },
      resourceSummary: {
        externalResources: "resolved_by_resource_owners",
      },
    };
  }

  async confirm(input: {
    currentAccountId: string;
    mergeId: string;
    confirmed: boolean;
    idempotencyKey: string;
    requestId: string;
  }) {
    if (!input.confirmed) {
      throw new AccountError(422, "merge_confirmation_required");
    }
    if (!input.idempotencyKey) {
      throw new AccountError(422, "idempotency_key_required");
    }
    const scope = `account-merge:${input.currentAccountId}`;
    const fingerprint = input.mergeId;
    const stored = await this.repository.getIdempotency(
      scope,
      input.idempotencyKey,
    );
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw new AccountError(409, "idempotency_conflict");
      }
      return stored.response as Record<string, unknown>;
    }
    const merge = await this.repository.getMerge(input.mergeId);
    if (!merge || merge.targetAccountId !== input.currentAccountId) {
      throw new AccountError(404, "merge_not_found");
    }
    if (merge.status === "completed" && merge.taskId) {
      return this.task(
        merge.taskId,
        input.requestId,
        input.currentAccountId,
        merge.createdAt,
      );
    }
    if (Date.parse(merge.expiresAt) <= this.now().getTime()) {
      throw new AccountError(410, "merge_expired");
    }
    const destination = await this.repository.getAccount(merge.targetAccountId);
    const source = await this.repository.getAccount(merge.sourceAccountId);
    if (!destination || destination.status !== "active") {
      throw new AccountError(409, "account_not_active");
    }
    if (!source || source.status !== "active") {
      throw new AccountError(409, "merge_target_not_active");
    }

    for (const identity of source.identities) {
      await this.repository.moveIdentity(
        identity.provider,
        identity.subject,
        source.accountId,
        destination.accountId,
      );
      if (
        !destination.identities.some((candidate) =>
          candidate.provider === identity.provider &&
          candidate.subject === identity.subject
        )
      ) destination.identities.push(identity);
    }
    const now = this.now().toISOString();
    source.status = "merged";
    source.mergedIntoAccountId = destination.accountId;
    source.identities = [];
    for (const sessionId of source.sessionIds ?? []) {
      const session = await this.repository.getSession(sessionId);
      if (session) {
        session.revokedAt ??= now;
        await this.repository.saveSession(session);
      }
    }
    await this.repository.saveAccount(destination);
    await this.repository.saveAccount(source);
    merge.status = "completed";
    merge.taskId = randomId("task");
    await this.repository.saveMerge(merge);
    const response = this.task(
      merge.taskId,
      input.requestId,
      destination.accountId,
      now,
    );
    await this.repository.saveIdempotency({
      scope,
      key: input.idempotencyKey,
      fingerprint,
      response,
    });
    await this.repository.saveAudit({
      auditId: randomId("audit"),
      accountId: destination.accountId,
      action: "account.merge_completed",
      occurredAt: now,
      requestId: input.requestId,
      metadata: {
        mergeId: merge.mergeId,
        mergedAccountId: source.accountId,
      },
    });
    return response;
  }

  private task(
    taskId: string,
    requestId: string,
    accountId: string,
    time: string,
  ) {
    return {
      taskId,
      requestId,
      status: "succeeded",
      resource: { type: "account", id: accountId },
      result: { accountId },
      createdAt: time,
      updatedAt: time,
    };
  }
}
