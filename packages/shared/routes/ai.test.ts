import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import type {
  AiModel,
  AiRequestClaim,
  AiRequestRecord,
  AiRequestRepository,
  AiServiceDependencies,
  CanonicalUsageEvent,
  UsageAuthorization,
  UsageAuthorizationRequest,
  UsageSettlementGateway,
} from "../lib/ai/service.ts";
import { createAiRoutes } from "./ai.ts";
import type { AppEnv } from "../types.ts";

const model: AiModel = {
  capability: "troubleshoot",
  model: "provider-neutral-small",
  maxInputLength: 1_000,
  maxOutputTokens: 100,
  maxTotalTokens: 1_100,
  rateVersions: { ai_request: 7, ai_tokens: 8 },
};

class MemoryRequests implements AiRequestRepository {
  private readonly records = new Map<
    string,
    AiRequestClaim | AiRequestRecord
  >();

  async claim(claim: AiRequestClaim) {
    const key = `${claim.accountId}:${claim.idempotencyKey}`;
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, claim);
      return { status: "claimed" as const };
    }
    if (
      !("result" in existing) ||
      existing.requestFingerprint !== claim.requestFingerprint
    ) return { status: "conflict" as const };
    return { status: "existing" as const, record: structuredClone(existing) };
  }

  async persistProviderResult(record: AiRequestRecord) {
    this.records.set(`${record.accountId}:${record.idempotencyKey}`, record);
  }

  async markSettled(
    accountId: string,
    idempotencyKey: string,
    eventId: string,
  ) {
    const key = `${accountId}:${idempotencyKey}`;
    const record = this.records.get(key);
    if (!record || !("result" in record)) {
      throw new Error("missing pending result");
    }
    if (!record.settledEventIds.includes(eventId)) {
      record.settledEventIds.push(eventId);
    }
    record.status = record.settledEventIds.length === record.events.length
      ? "completed"
      : "pending_settlement";
    return structuredClone(record);
  }

  async release(claim: AiRequestClaim) {
    const key = `${claim.accountId}:${claim.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing && !("result" in existing)) this.records.delete(key);
  }
}

class UsageGateway implements UsageSettlementGateway {
  readonly calls: string[] = [];
  readonly authorizations: UsageAuthorizationRequest[] = [];
  readonly releases: string[] = [];
  readonly events: CanonicalUsageEvent[] = [];
  rejectResource?: "ai_request" | "ai_tokens";
  failFirstSettlement = false;
  private failedSettlement = false;

  async authorize(
    request: UsageAuthorizationRequest,
  ): Promise<UsageAuthorization> {
    this.calls.push(`authorize:${request.resource}`);
    this.authorizations.push(request);
    if (this.rejectResource === request.resource) {
      throw { code: "insufficient_balance" };
    }
    return {
      authorizationId: `auth_${request.resource}`,
      accountId: request.accountId,
      resource: request.resource,
      sourceId: request.sourceId,
      status: "authorized",
      rateVersion: request.rateVersion,
      expiresAt: request.expiresAt,
      actionOnExhaustion: "stop_required",
    };
  }

  async release(
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<UsageAuthorization> {
    this.calls.push(`release:${authorizationId}`);
    this.releases.push(idempotencyKey);
    const resource = authorizationId === "auth_ai_request"
      ? "ai_request"
      : "ai_tokens";
    return {
      authorizationId,
      accountId: "acct_test",
      resource,
      sourceId: "released",
      status: "released",
      rateVersion: resource === "ai_request" ? 7 : 8,
      expiresAt: "2026-07-22T10:05:00.000Z",
      actionOnExhaustion: "stop_required",
    };
  }

  async settle(event: CanonicalUsageEvent) {
    this.calls.push(`settle:${event.resource}`);
    this.events.push(event);
    if (this.failFirstSettlement && !this.failedSettlement) {
      this.failedSettlement = true;
      throw new Error("temporary settlement failure");
    }
    return {
      settlementId: `settlement_${event.resource}`,
      usageEventId: event.eventId,
      action: "continue" as const,
      status: "settled" as const,
      rateVersion: event.rateVersion,
    };
  }
}

function fixture(dependencies?: AiServiceDependencies) {
  const runtime = {
    sessions: {
      verify: async (token: string) => {
        if (token !== "session-token") throw new Error("bad session");
        return {
          sessionId: "session_test",
          familyId: "family_test",
          accountId: "acct_test",
          scopes: ["ai:invoke"],
          issuedAt: "2026-07-22T10:00:00.000Z",
          expiresAt: "2026-07-23T10:00:00.000Z",
        };
      },
    },
  } as unknown as AccountRuntime;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("accountRuntime", runtime);
    c.set("aiServiceDependencies", dependencies);
    await next();
  });
  app.route("/", createAiRoutes());
  return {
    app,
    request: (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: "Bearer session-token",
          "content-type": "application/json",
          ...init.headers,
        },
      }),
  };
}

function dependencies(usage = new UsageGateway()) {
  let providerCalls = 0;
  const result: AiServiceDependencies = {
    models: [model],
    requests: new MemoryRequests(),
    authorizations: usage,
    now: () => new Date("2026-07-22T10:00:00.000Z"),
    provider: {
      async request() {
        providerCalls += 1;
        return {
          providerRequestId: "provider_001",
          output: "Check the launcher log.",
          usage: [
            {
              resource: "ai_request" as const,
              quantity: 1,
              unit: "request" as const,
            },
            {
              resource: "ai_tokens" as const,
              quantity: 42,
              unit: "token" as const,
            },
          ],
        };
      },
    },
  };
  return { result, usage, providerCalls: () => providerCalls };
}

Deno.test("mounted AI route requires Account scope and reports unconfigured adapters", async () => {
  const app = createAiRoutes(async () => ({
    sessions: {
      verify: async () => ({
        sessionId: "session",
        familyId: "family",
        accountId: "acct_test",
        scopes: [],
        issuedAt: "2026-07-22T10:00:00.000Z",
        expiresAt: "2026-07-23T10:00:00.000Z",
      }),
    },
  } as unknown as AccountRuntime));
  const forbidden = await app.request("/v1/ai/models", {
    headers: { authorization: "Bearer session-token" },
  });
  assert.equal(forbidden.status, 403);

  const configuredModels = fixture({ models: [model] });
  const response = await configuredModels.request("/v1/ai/troubleshoot", {
    method: "POST",
    headers: { "idempotency-key": "intent-unconfigured" },
    body: JSON.stringify({ input: "fixture" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "ai_usage_not_configured");
});

Deno.test("mounted AI route authorizes before provider and settles shared-v1 canonical usage", async () => {
  const state = dependencies();
  const app = fixture(state.result);
  const catalog = await app.request("/v1/ai/models");
  assert.deepEqual(await catalog.json(), [{
    capability: "troubleshoot",
    model: "provider-neutral-small",
    usageResources: ["ai_request", "ai_tokens"],
  }]);
  const response = await app.request("/v1/ai/troubleshoot", {
    method: "POST",
    headers: {
      "idempotency-key": "intent-success",
      "x-request-id": "air_success",
    },
    body: JSON.stringify({ model: model.model, input: "The game exits." }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(state.usage.calls, [
    "authorize:ai_request",
    "authorize:ai_tokens",
    "settle:ai_request",
    "settle:ai_tokens",
  ]);
  assert.deepEqual(
    state.usage.authorizations.map((entry) => ({
      resource: entry.resource,
      sourceId: entry.sourceId,
      expectedQuantity: entry.expectedQuantity,
      settlementIntervalSeconds: entry.settlementIntervalSeconds,
    })),
    [
      {
        resource: "ai_request",
        sourceId: "ai:air_success:ai_request",
        expectedQuantity: 1,
        settlementIntervalSeconds: 300,
      },
      {
        resource: "ai_tokens",
        sourceId: "ai:air_success:ai_tokens",
        expectedQuantity: 1_100,
        settlementIntervalSeconds: 300,
      },
    ],
  );
  assert.deepEqual(
    state.usage.events.map((event) => ({
      eventType: event.eventType,
      eventId: event.eventId,
      sourceId: event.sourceId,
      rateVersion: event.rateVersion,
    })),
    [
      {
        eventType: "usage.recorded.v1",
        eventId: "air_success:ai_request",
        sourceId: "ai:air_success:ai_request",
        rateVersion: 7,
      },
      {
        eventType: "usage.recorded.v1",
        eventId: "air_success:ai_tokens",
        sourceId: "ai:air_success:ai_tokens",
        rateVersion: 8,
      },
    ],
  );
});

Deno.test("provider failure compensates every Billing authorization and publishes no usage", async () => {
  const state = dependencies();
  state.result.provider = {
    async request() {
      throw new Error("provider credential must not leak");
    },
  };
  const app = fixture(state.result);
  const response = await app.request("/v1/ai/troubleshoot", {
    method: "POST",
    headers: { "idempotency-key": "intent-provider-failure" },
    body: JSON.stringify({ input: "fixture" }),
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "ai_provider_unavailable");
  assert.deepEqual(state.usage.calls, [
    "authorize:ai_request",
    "authorize:ai_tokens",
    "release:auth_ai_request",
    "release:auth_ai_tokens",
  ]);
  assert.equal(state.usage.events.length, 0);
});

Deno.test("second Billing authorization rejection releases the first without calling provider", async () => {
  const usage = new UsageGateway();
  usage.rejectResource = "ai_tokens";
  const state = dependencies(usage);
  const app = fixture(state.result);
  const response = await app.request("/v1/ai/troubleshoot", {
    method: "POST",
    headers: { "idempotency-key": "intent-balance" },
    body: JSON.stringify({ input: "fixture" }),
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "insufficient_balance");
  assert.equal(state.providerCalls(), 0);
  assert.deepEqual(usage.calls, [
    "authorize:ai_request",
    "authorize:ai_tokens",
    "release:auth_ai_request",
  ]);
});

Deno.test("idempotent route retry returns the stored result without another provider or settlement", async () => {
  const state = dependencies();
  const app = fixture(state.result);
  const request = {
    method: "POST",
    headers: { "idempotency-key": "intent-retry", "x-request-id": "air_retry" },
    body: JSON.stringify({ input: "fixture" }),
  };
  const first = await app.request("/v1/ai/troubleshoot", request);
  const retry = await app.request("/v1/ai/troubleshoot", request);

  assert.equal(first.status, 200);
  assert.deepEqual(await retry.json(), await first.json());
  assert.equal(state.providerCalls(), 1);
  assert.equal(state.usage.events.length, 2);
});

Deno.test("settlement failure retries the duplicate canonical event without another provider call", async () => {
  const usage = new UsageGateway();
  usage.failFirstSettlement = true;
  const state = dependencies(usage);
  const app = fixture(state.result);
  const request = {
    method: "POST",
    headers: {
      "idempotency-key": "intent-settlement-retry",
      "x-request-id": "air_settlement_retry",
    },
    body: JSON.stringify({ input: "fixture" }),
  };

  const first = await app.request("/v1/ai/troubleshoot", request);
  assert.equal(first.status, 502);
  const retry = await app.request("/v1/ai/troubleshoot", request);

  assert.equal(retry.status, 200);
  assert.equal(state.providerCalls(), 1);
  assert.deepEqual(usage.calls, [
    "authorize:ai_request",
    "authorize:ai_tokens",
    "settle:ai_request",
    "settle:ai_request",
    "settle:ai_tokens",
  ]);
  assert.equal(
    usage.events.filter((event) =>
      event.eventId === "air_settlement_retry:ai_request"
    ).length,
    2,
  );
  assert.equal(
    usage.events.filter((event) =>
      event.eventId === "air_settlement_retry:ai_tokens"
    ).length,
    1,
  );
});
