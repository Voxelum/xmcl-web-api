import assert from "node:assert/strict";
import { AccountService, MemoryAccountRepository } from "./account.ts";
import { AccountMergeService } from "./accountMerge.ts";

Deno.test("account merge preserves a paid source tier", async () => {
  const repository = new MemoryAccountRepository();
  const accounts = new AccountService(repository);
  const destination = await accounts.bindIdentity({
    identity: { provider: "microsoft", subject: "destination-user" },
    linkedBy: "web_link",
  });
  const source = await accounts.bindIdentity({
    identity: { provider: "modrinth", subject: "paid-source-user" },
    linkedBy: "web_link",
  });
  source.account.tier = "pro";
  await repository.saveAccount(source.account);

  const merges = new AccountMergeService(repository);
  const prepared = await merges.prepare({
    currentAccountId: destination.account.accountId,
    verifiedTargetIdentity: {
      provider: "modrinth",
      subject: "paid-source-user",
    },
    requestId: "request-prepare",
  });
  await merges.confirm({
    currentAccountId: destination.account.accountId,
    mergeId: prepared.mergeId,
    confirmed: true,
    idempotencyKey: "merge-tier",
    requestId: "request-confirm",
  });

  const merged = await repository.getAccount(destination.account.accountId);
  assert.equal(merged?.tier, "pro");
});
