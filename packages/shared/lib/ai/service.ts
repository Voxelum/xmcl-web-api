export type AiUsage =
  | { resource: "ai_request"; quantity: number; unit: "request" }
  | { resource: "ai_tokens"; quantity: number; unit: "token" };

export interface AiModel {
  capability: string;
  model: string;
  maxInputLength: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  rateVersions: { ai_request: number; ai_tokens: number };
}

export interface AiRequestCommand {
  requestId: string;
  accountId: string;
  capability: string;
  model?: string;
  input: string;
  idempotencyKey: string;
}

export interface UsageAuthorizationRequest {
  accountId: string;
  resource: AiUsage["resource"];
  sourceId: string;
  expectedQuantity: number;
  unit: AiUsage["unit"];
  settlementIntervalSeconds: number;
  rateVersion: number;
  idempotencyKey: string;
  expiresAt: string;
}

export interface UsageAuthorization {
  authorizationId: string;
  accountId: string;
  resource: AiUsage["resource"];
  sourceId: string;
  status: "authorized" | "rejected" | "expired" | "released";
  rateVersion: number;
  expiresAt: string;
  actionOnExhaustion: "stop_required";
}

export interface CanonicalUsageEvent {
  eventType: "usage.recorded.v1";
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  authorizationId: string;
  resource: AiUsage["resource"];
  sourceId: string;
  quantity: number;
  unit: AiUsage["unit"];
  rateVersion: number;
  intervalStart: string;
  intervalEnd: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface UsageSettlementResult {
  settlementId: string;
  usageEventId: string;
  action: "continue" | "stop_required";
  status: "settled" | "rejected" | "pending";
  rateVersion: number;
}

export interface AiProviderResult {
  providerRequestId: string;
  output: string;
  usage: AiUsage[];
}

/** Server-only provider adapter. Its construction is responsible for reading secret bindings. */
export interface AiProviderAdapter {
  request(input: {
    requestId: string;
    capability: string;
    model: string;
    input: string;
    maxOutputTokens: number;
  }): Promise<AiProviderResult>;
}

/** Injected Billing D2/D3 adapter; it is never selected from request data. */
export interface UsageSettlementGateway {
  authorize(request: UsageAuthorizationRequest): Promise<UsageAuthorization>;
  release(
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<UsageAuthorization>;
  settle(event: CanonicalUsageEvent): Promise<UsageSettlementResult>;
}

export interface AiRequestResult extends AiProviderResult {
  requestId: string;
}

export interface AiRequestRecord {
  accountId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  result: AiRequestResult;
  events: CanonicalUsageEvent[];
  settledEventIds: string[];
  status: "pending_settlement" | "completed";
}

export interface AiRequestClaim {
  accountId: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface AiRequestRepository {
  claim(claim: AiRequestClaim): Promise<
    | { status: "claimed" }
    | { status: "existing"; record: AiRequestRecord }
    | { status: "conflict" }
  >;
  persistProviderResult(record: AiRequestRecord): Promise<void>;
  markSettled(
    accountId: string,
    idempotencyKey: string,
    eventId: string,
  ): Promise<AiRequestRecord>;
  release(claim: AiRequestClaim): Promise<void>;
}

export interface AiServiceDependencies {
  models: readonly AiModel[];
  authorizations?: UsageSettlementGateway;
  provider?: AiProviderAdapter;
  requests?: AiRequestRepository;
  now?: () => Date;
}

export class AiRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_ai_request"
      | "ai_model_not_found"
      | "insufficient_balance"
      | "ai_authorization_conflict"
      | "ai_provider_not_configured"
      | "ai_usage_not_configured"
      | "ai_request_store_not_configured"
      | "ai_provider_unavailable"
      | "ai_usage_publish_failed"
      | "ai_idempotency_conflict"
      | "ai_request_in_progress",
    readonly status: 400 | 404 | 409 | 422 | 502 | 503,
  ) {
    super(code);
  }
}

const authorizationWindowSeconds = 300;

function fingerprint(command: AiRequestCommand) {
  return JSON.stringify({
    accountId: command.accountId,
    capability: command.capability,
    model: command.model,
    input: command.input,
  });
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mappedAuthorizationError(error: unknown): AiRequestError {
  if (error instanceof AiRequestError) return error;
  const code = typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (code === "insufficient_balance") {
    return new AiRequestError("insufficient_balance", 422);
  }
  return new AiRequestError("ai_authorization_conflict", 409);
}

export class AiRequestService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: AiServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  listModels() {
    return this.dependencies.models.map(({ capability, model }) => ({
      capability,
      model,
      usageResources: ["ai_request", "ai_tokens"],
    }));
  }

  async execute(command: AiRequestCommand): Promise<AiRequestResult> {
    if (
      !validText(command.requestId) || !validText(command.accountId) ||
      !validText(command.capability) || !validText(command.input) ||
      !validText(command.idempotencyKey)
    ) {
      throw new AiRequestError("invalid_ai_request", 400);
    }
    const model = this.dependencies.models.find((candidate) =>
      candidate.capability === command.capability &&
      (command.model === undefined || candidate.model === command.model)
    );
    if (!model) throw new AiRequestError("ai_model_not_found", 404);
    if (command.input.length > model.maxInputLength) {
      throw new AiRequestError("invalid_ai_request", 400);
    }
    const authorizations = this.dependencies.authorizations;
    if (!authorizations) {
      throw new AiRequestError("ai_usage_not_configured", 503);
    }
    const provider = this.dependencies.provider;
    if (!provider) {
      throw new AiRequestError("ai_provider_not_configured", 503);
    }
    const requests = this.dependencies.requests;
    if (!requests) {
      throw new AiRequestError("ai_request_store_not_configured", 503);
    }

    const claim: AiRequestClaim = {
      accountId: command.accountId,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: fingerprint(command),
    };
    const claimed = await requests.claim(claim);
    if (claimed.status === "existing") {
      return await this.settlePending(
        authorizations,
        requests,
        claimed.record,
      );
    }
    if (claimed.status === "conflict") {
      throw new AiRequestError("ai_idempotency_conflict", 409);
    }

    const now = this.now();
    const intervalStart = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + authorizationWindowSeconds * 1000,
    ).toISOString();
    const authorizationRecords: UsageAuthorization[] = [];
    const source = (resource: AiUsage["resource"]) =>
      `ai:${command.requestId}:${resource}`;

    try {
      for (
        const usage of [
          {
            resource: "ai_request" as const,
            quantity: 1,
            unit: "request" as const,
            rateVersion: model.rateVersions.ai_request,
          },
          {
            resource: "ai_tokens" as const,
            quantity: model.maxTotalTokens,
            unit: "token" as const,
            rateVersion: model.rateVersions.ai_tokens,
          },
        ]
      ) {
        const authorization = await authorizations.authorize({
          accountId: command.accountId,
          resource: usage.resource,
          sourceId: source(usage.resource),
          expectedQuantity: usage.quantity,
          unit: usage.unit,
          settlementIntervalSeconds: authorizationWindowSeconds,
          rateVersion: usage.rateVersion,
          idempotencyKey:
            `${command.idempotencyKey}:authorize:${usage.resource}`,
          expiresAt,
        });
        if (
          authorization.status !== "authorized" ||
          authorization.accountId !== command.accountId ||
          authorization.resource !== usage.resource ||
          authorization.sourceId !== source(usage.resource) ||
          authorization.rateVersion !== usage.rateVersion
        ) {
          throw new AiRequestError("ai_authorization_conflict", 409);
        }
        authorizationRecords.push(authorization);
      }
    } catch (error) {
      await this.releaseAll(
        authorizations,
        authorizationRecords,
        command,
        "authorization",
      );
      await requests.release(claim);
      throw mappedAuthorizationError(error);
    }

    let providerResult: AiProviderResult;
    try {
      providerResult = await provider.request({
        requestId: command.requestId,
        capability: command.capability,
        model: model.model,
        input: command.input,
        maxOutputTokens: model.maxOutputTokens,
      });
      assertProviderResult(providerResult);
    } catch {
      await this.releaseAll(
        authorizations,
        authorizationRecords,
        command,
        "provider",
      );
      await requests.release(claim);
      throw new AiRequestError("ai_provider_unavailable", 502);
    }

    const requestResult = { requestId: command.requestId, ...providerResult };
    const events = providerResult.usage.map((measured) => {
      const authorization = authorizationRecords.find((candidate) =>
        candidate.resource === measured.resource
      );
      if (!authorization) {
        throw new AiRequestError("ai_usage_publish_failed", 502);
      }
      return {
        eventType: "usage.recorded.v1",
        eventId: `${command.requestId}:${measured.resource}`,
        schemaVersion: 1,
        accountId: command.accountId,
        authorizationId: authorization.authorizationId,
        resource: measured.resource,
        sourceId: authorization.sourceId,
        quantity: measured.quantity,
        unit: measured.unit,
        rateVersion: authorization.rateVersion,
        intervalStart,
        intervalEnd: expiresAt,
        occurredAt: this.now().toISOString(),
        idempotencyKey: `${command.idempotencyKey}:${measured.resource}`,
      } satisfies CanonicalUsageEvent;
    });
    return await this.settlePending(authorizations, requests, {
      ...claim,
      result: requestResult,
      events,
      settledEventIds: [],
      status: "pending_settlement",
    }, true);
  }

  private async settlePending(
    authorizations: UsageSettlementGateway,
    requests: AiRequestRepository,
    record: AiRequestRecord,
    persist = false,
  ): Promise<AiRequestResult> {
    let current = record;
    if (persist) await requests.persistProviderResult(current);
    try {
      for (const event of current.events) {
        if (current.settledEventIds.includes(event.eventId)) continue;
        const settlement = await authorizations.settle(event);
        if (
          settlement.usageEventId !== event.eventId ||
          settlement.rateVersion !== event.rateVersion
        ) throw new AiRequestError("ai_usage_publish_failed", 502);
        current = await requests.markSettled(
          current.accountId,
          current.idempotencyKey,
          event.eventId,
        );
      }
      return current.result;
    } catch (error) {
      if (error instanceof AiRequestError) throw error;
      throw new AiRequestError("ai_usage_publish_failed", 502);
    }
  }

  private async releaseAll(
    authorizations: UsageSettlementGateway,
    records: UsageAuthorization[],
    command: AiRequestCommand,
    reason: "authorization" | "provider",
  ) {
    await Promise.allSettled(
      records.map((authorization) =>
        authorizations.release(
          authorization.authorizationId,
          `${command.idempotencyKey}:release:${reason}:${authorization.resource}`,
        )
      ),
    );
  }
}

function assertProviderResult(result: AiProviderResult) {
  if (
    !validText(result.providerRequestId) || typeof result.output !== "string"
  ) {
    throw new Error("invalid_provider_response");
  }
  const request = result.usage.filter((usage) =>
    usage.resource === "ai_request" && usage.unit === "request" &&
    usage.quantity === 1
  );
  const tokens = result.usage.filter((usage) =>
    usage.resource === "ai_tokens" && usage.unit === "token" &&
    Number.isSafeInteger(usage.quantity) && usage.quantity > 0
  );
  if (
    result.usage.length !== 2 || request.length !== 1 || tokens.length !== 1
  ) {
    throw new Error("invalid_provider_usage");
  }
}
