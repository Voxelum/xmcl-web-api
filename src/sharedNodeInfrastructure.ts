import type { Db } from "./db.ts";

export type SharedNodeWorkloadClass = "standard" | "large";

export interface SharedNodeCapacityDemand {
  requestId: string;
  region: string;
  workloadClass: SharedNodeWorkloadClass;
  minimumMemoryMiB: number;
  minimumSharedCpu: number;
  minimumWorkspaceGiB: number;
}

export interface SharedNodeProvisioner {
  requestCapacity(input: SharedNodeCapacityDemand): Promise<void>;
}

export type InfrastructureErrorCode =
  | "allocation_conflict"
  | "capacity_unavailable"
  | "provider_rejected"
  | "provider_unavailable"
  | "provider_unknown"
  | "invalid_provider_response";

export class InfrastructureError extends Error {
  constructor(
    readonly code: InfrastructureErrorCode,
    readonly outcome: "definitive" | "unknown",
    readonly providerId?: string,
    readonly status?: number,
    readonly diagnostic?: "timeout" | "network",
  ) {
    super(code);
  }
}

export function normalizeInfrastructureError(
  error: unknown,
  providerId?: string,
) {
  if (error instanceof InfrastructureError) return error;
  return new InfrastructureError(
    "provider_unknown",
    "unknown",
    providerId,
  );
}

export function infrastructureErrorDiagnostic(error: InfrastructureError) {
  if (error.status) return `${error.code}:${error.status}`;
  if (error.diagnostic) return `${error.code}:${error.diagnostic}`;
  return error.code;
}

export interface SharedNodeCapacityOffer {
  providerId: string;
  offerId: string;
  region: string;
  workloadClasses: readonly SharedNodeWorkloadClass[];
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
  priority: number;
  estimatedHourlyCostMicros?: number;
}

export interface SharedNodeCapacitySource {
  offer: SharedNodeCapacityOffer;
  provisioner: SharedNodeProvisioner;
}

export interface SharedNodeAllocationAttempt {
  providerId: string;
  offerId: string;
  allocationRequestId: string;
  status: "selected" | "completed" | "failed" | "unknown";
  error?: string;
  updatedAt: string;
}

export interface SharedNodeAllocationRecord {
  requestId: string;
  demand: SharedNodeCapacityDemand;
  status: "selecting" | "provisioning" | "completed" | "failed" | "unknown";
  selectedProviderId?: string;
  selectedOfferId?: string;
  attempts: SharedNodeAllocationAttempt[];
  updatedAt: string;
}

export interface SharedNodeAllocationRepository {
  find(requestId: string): Promise<SharedNodeAllocationRecord | undefined>;
  create(
    record: SharedNodeAllocationRecord,
  ): Promise<SharedNodeAllocationRecord>;
  save(record: SharedNodeAllocationRecord): Promise<void>;
}

export class MemorySharedNodeAllocationRepository
  implements SharedNodeAllocationRepository {
  private readonly records = new Map<string, SharedNodeAllocationRecord>();

  find(requestId: string) {
    const value = this.records.get(requestId);
    return Promise.resolve(value ? structuredClone(value) : undefined);
  }

  create(record: SharedNodeAllocationRecord) {
    const existing = this.records.get(record.requestId);
    if (existing) return Promise.resolve(structuredClone(existing));
    this.records.set(record.requestId, structuredClone(record));
    return Promise.resolve(structuredClone(record));
  }

  save(record: SharedNodeAllocationRecord) {
    this.records.set(record.requestId, structuredClone(record));
    return Promise.resolve();
  }
}

export class MongoSharedNodeAllocationRepository
  implements SharedNodeAllocationRepository {
  constructor(private readonly db: Db) {}

  async find(requestId: string) {
    const value = await this.db.collection("shared_node_allocations").findOne({
      _id: requestId,
    });
    return value as SharedNodeAllocationRecord | undefined;
  }

  async create(record: SharedNodeAllocationRecord) {
    const document = { ...structuredClone(record), _id: record.requestId };
    try {
      await this.db.collection("shared_node_allocations").insertOne(document);
      return structuredClone(record);
    } catch (error) {
      const existing = await this.find(record.requestId);
      if (existing) return existing;
      throw error;
    }
  }

  async save(record: SharedNodeAllocationRecord) {
    await this.db.collection("shared_node_allocations").replaceOne(
      { _id: record.requestId },
      { ...structuredClone(record), _id: record.requestId },
      { upsert: true },
    );
  }
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function validateOffer(offer: SharedNodeCapacityOffer) {
  const workloadClasses = new Set(offer.workloadClasses);
  if (
    !validIdentifier(offer.providerId) ||
    !validIdentifier(offer.offerId) ||
    !validIdentifier(offer.region) ||
    offer.workloadClasses.length === 0 ||
    workloadClasses.size !== offer.workloadClasses.length ||
    [...workloadClasses].some((value) =>
      value !== "standard" && value !== "large"
    ) ||
    !Number.isSafeInteger(offer.totalMemoryMiB) ||
    !Number.isSafeInteger(offer.totalSharedCpu) ||
    !Number.isSafeInteger(offer.totalWorkspaceGiB) ||
    !Number.isSafeInteger(offer.priority) ||
    offer.totalMemoryMiB <= 0 ||
    offer.totalSharedCpu <= 0 ||
    offer.totalWorkspaceGiB <= 0 ||
    offer.estimatedHourlyCostMicros !== undefined &&
      (!Number.isSafeInteger(offer.estimatedHourlyCostMicros) ||
        offer.estimatedHourlyCostMicros < 0)
  ) {
    throw new Error("shared node capacity offer is invalid");
  }
}

function supports(
  offer: SharedNodeCapacityOffer,
  demand: SharedNodeCapacityDemand,
) {
  return offer.region === demand.region &&
    offer.workloadClasses.includes(demand.workloadClass) &&
    offer.totalMemoryMiB >= demand.minimumMemoryMiB &&
    offer.totalSharedCpu >= demand.minimumSharedCpu &&
    offer.totalWorkspaceGiB >= demand.minimumWorkspaceGiB;
}

function compareOffers(
  left: SharedNodeCapacityOffer,
  right: SharedNodeCapacityOffer,
) {
  return left.priority - right.priority ||
    (left.estimatedHourlyCostMicros ?? Number.MAX_SAFE_INTEGER) -
      (right.estimatedHourlyCostMicros ?? Number.MAX_SAFE_INTEGER) ||
    left.providerId.localeCompare(right.providerId) ||
    left.offerId.localeCompare(right.offerId);
}

function sourceKey(providerId: string, offerId: string) {
  return `${providerId}\n${offerId}`;
}

function sameDemand(
  left: SharedNodeCapacityDemand,
  right: SharedNodeCapacityDemand,
) {
  return left.requestId === right.requestId &&
    left.region === right.region &&
    left.workloadClass === right.workloadClass &&
    left.minimumMemoryMiB === right.minimumMemoryMiB &&
    left.minimumSharedCpu === right.minimumSharedCpu &&
    left.minimumWorkspaceGiB === right.minimumWorkspaceGiB;
}

export class MixedSharedNodeProvisioner implements SharedNodeProvisioner {
  private readonly sources: readonly SharedNodeCapacitySource[];
  private readonly sourceByKey: ReadonlyMap<string, SharedNodeCapacitySource>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    sources: readonly SharedNodeCapacitySource[],
    private readonly repository: SharedNodeAllocationRepository =
      new MemorySharedNodeAllocationRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const source of sources) validateOffer(source.offer);
    const keys = sources.map((source) =>
      sourceKey(source.offer.providerId, source.offer.offerId)
    );
    if (new Set(keys).size !== keys.length) {
      throw new Error("duplicate shared node capacity offer");
    }
    this.sources = [...sources];
    this.sourceByKey = new Map(
      sources.map((source) => [
        sourceKey(source.offer.providerId, source.offer.offerId),
        source,
      ]),
    );
  }

  async requestCapacity(input: SharedNodeCapacityDemand) {
    const existing = this.inFlight.get(input.requestId);
    if (existing) return await existing;
    const operation = this.allocate(input);
    this.inFlight.set(input.requestId, operation);
    try {
      await operation;
    } finally {
      this.inFlight.delete(input.requestId);
    }
  }

  private async allocate(input: SharedNodeCapacityDemand) {
    let record = await this.repository.find(input.requestId);
    if (!record) {
      const selected = this.nextSource(input, {
        requestId: input.requestId,
        demand: input,
        status: "selecting",
        attempts: [],
        updatedAt: this.now().toISOString(),
      });
      record = await this.repository.create({
        requestId: input.requestId,
        demand: structuredClone(input),
        status: selected ? "selecting" : "failed",
        selectedProviderId: selected?.offer.providerId,
        selectedOfferId: selected?.offer.offerId,
        attempts: [],
        updatedAt: this.now().toISOString(),
      });
    }
    if (!sameDemand(record.demand, input)) {
      throw new InfrastructureError("allocation_conflict", "definitive");
    }
    if (record.status === "completed") return;

    while (true) {
      const source = this.selectedSource(record) ??
        this.nextSource(input, record);
      if (!source) {
        record.status = "failed";
        record.selectedProviderId = undefined;
        record.selectedOfferId = undefined;
        record.updatedAt = this.now().toISOString();
        await this.repository.save(record);
        throw new InfrastructureError(
          "capacity_unavailable",
          "definitive",
        );
      }

      let attempt = record.attempts.find((candidate) =>
        candidate.providerId === source.offer.providerId &&
        candidate.offerId === source.offer.offerId &&
        (candidate.status === "selected" || candidate.status === "unknown")
      );
      if (!attempt) {
        attempt = {
          providerId: source.offer.providerId,
          offerId: source.offer.offerId,
          allocationRequestId: record.attempts.length === 0
            ? input.requestId
            : await allocationRequestId(
              input.requestId,
              record.attempts.length,
            ),
          status: "selected",
          updatedAt: this.now().toISOString(),
        };
        record.attempts.push(attempt);
      } else {
        attempt.status = "selected";
        attempt.error = undefined;
        attempt.updatedAt = this.now().toISOString();
      }
      record.status = "provisioning";
      record.selectedProviderId = source.offer.providerId;
      record.selectedOfferId = source.offer.offerId;
      record.updatedAt = this.now().toISOString();
      await this.repository.save(record);

      try {
        await source.provisioner.requestCapacity({
          ...input,
          requestId: attempt.allocationRequestId,
        });
        attempt.status = "completed";
        attempt.error = undefined;
        attempt.updatedAt = this.now().toISOString();
        record.status = "completed";
        record.updatedAt = attempt.updatedAt;
        await this.repository.save(record);
        return;
      } catch (error) {
        const failure = normalizeInfrastructureError(
          error,
          source.offer.providerId,
        );
        attempt.status = failure.outcome === "definitive"
          ? "failed"
          : "unknown";
        attempt.error = infrastructureErrorDiagnostic(failure);
        attempt.updatedAt = this.now().toISOString();
        record.status = attempt.status;
        record.updatedAt = attempt.updatedAt;
        await this.repository.save(record);

        if (
          failure.code === "capacity_unavailable" &&
          failure.outcome === "definitive"
        ) {
          record.status = "selecting";
          record.selectedProviderId = undefined;
          record.selectedOfferId = undefined;
          record.updatedAt = this.now().toISOString();
          await this.repository.save(record);
          continue;
        }
        throw failure;
      }
    }
  }

  private selectedSource(record: SharedNodeAllocationRecord) {
    if (!record.selectedProviderId || !record.selectedOfferId) return undefined;
    const source = this.sourceByKey.get(
      sourceKey(record.selectedProviderId, record.selectedOfferId),
    );
    if (!source) {
      throw new InfrastructureError(
        "provider_unavailable",
        "unknown",
        record.selectedProviderId,
      );
    }
    return source;
  }

  private nextSource(
    input: SharedNodeCapacityDemand,
    record: SharedNodeAllocationRecord,
  ) {
    const attempted = new Set(
      record.attempts.map((attempt) =>
        sourceKey(attempt.providerId, attempt.offerId)
      ),
    );
    return this.sources
      .filter((source) =>
        supports(source.offer, input) &&
        !attempted.has(
          sourceKey(source.offer.providerId, source.offer.offerId),
        )
      )
      .sort((left, right) => compareOffers(left.offer, right.offer))[0];
  }
}

async function allocationRequestId(requestId: string, attempt: number) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${requestId}:${attempt}`),
  );
  const suffix = [...new Uint8Array(digest)].slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const prefix = requestId.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 78);
  return `${prefix}:${suffix}`;
}
