import assert from "node:assert/strict";
import { MemoryBillingStore } from "./ledger.ts";
import {
  runTurnMeteringSweep,
  TurnCredentialMeter,
} from "./turnMetering.ts";
import { XmclPlusService } from "./xmclPlus.ts";

const issuedAt = new Date("2026-08-12T00:00:00.000Z");

async function fixture() {
  const store = new MemoryBillingStore();
  await store.transaction((state) => {
    state.plusSubscriptions.set("plus_1", {
      subscriptionId: "plus_1",
      accountId: "account",
      status: "active",
      currentPeriodStartedAt: "2026-08-01T00:00:00.000Z",
      currentPeriodEndsAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  });
  return {
    store,
    meter: new TurnCredentialMeter(store, () => issuedAt),
    plus: new XmclPlusService(store, { now: () => issuedAt }),
  };
}

Deno.test("TURN analytics settles cumulative egress exactly once", async () => {
  const { meter, plus } = await fixture();
  assert.equal(
    await meter.authorize("account", "credential_1", 3_600),
    true,
  );
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.variables.accountId, "cf-account");
    assert.equal(body.variables.identifier, "credential_1");
    assert.match(body.query, /customIdentifier: \$identifier/);
    return Response.json({
      data: {
        viewer: {
          accounts: [{
            usage: [{ sum: { egressBytes: 1234 } }],
          }],
        },
      },
    });
  };
  const at = new Date("2026-08-12T00:05:00.000Z");
  const first = await runTurnMeteringSweep(
    meter,
    { accountId: "cf-account", apiToken: "token" },
    at,
    fetcher,
  );
  const replay = await runTurnMeteringSweep(
    meter,
    { accountId: "cf-account", apiToken: "token" },
    at,
    fetcher,
  );
  assert.equal(first.settledEgressBytes, 1234);
  assert.equal(replay.settledEgressBytes, 0);
  const allowances = await plus.allowances("account");
  assert.equal(allowances.turnEgressBytes.consumed, 1234);
  assert.equal(allowances.turnEgressBytes.remaining, 20_000_000_000 - 1234);
  assert.equal(allowances.turnEgressBytes.meteringStatus, "active");
});

Deno.test("TURN credentials require remaining Together allowance", async () => {
  const { meter } = await fixture();
  assert.equal(await meter.authorize("other", "credential_2", 300), false);
});

Deno.test("TURN credentials allow only one active issuance per account", async () => {
  const { meter, store } = await fixture();
  assert.equal(
    await meter.authorize(
      "account",
      "credential_1",
      300,
      "3d3c4b29-a806-49b3-b92f-b4ec1e2e6e52",
    ),
    true,
  );
  assert.equal(
    await store.read((state) =>
      state.turnCredentialIssuances.get("credential_1")?.turnSessionId
    ),
    "3d3c4b29-a806-49b3-b92f-b4ec1e2e6e52",
  );
  assert.equal(await meter.authorize("account", "credential_2", 300), false);
  await meter.release("credential_1");
  assert.equal(await meter.authorize("account", "credential_2", 300), true);
});
