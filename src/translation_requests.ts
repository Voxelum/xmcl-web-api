import type { Db, MongoCollection } from "./db.ts";

export const TRANSLATION_REQUESTS_COLLECTION = "translation_requests";

export type TranslationContentType = "text/html" | "text/markdown";
export type TranslationRequestStatus = "pending" | "succeeded" | "failed";

/**
 * Durable metadata for a translation source version. It intentionally never
 * contains the source body; batch workers fetch that body again after claiming
 * the request.
 */
export interface TranslationRequest {
  _id: string;
  lang: string;
  type: string;
  projectId: string;
  bodyHash: string;
  contentType: TranslationContentType;
  status: TranslationRequestStatus;
  createdAt: Date;
  firstRequestedAt: Date;
  lastRequestedAt: Date;
  updatedAt: Date;
  requestCount: number;
  attempts: number;
  claimedBy?: string;
  claimToken?: string;
  claimedAt?: Date;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  notBefore?: Date;
}

export interface TranslationRequestSource {
  lang: string;
  type: string;
  projectId: string;
  bodyHash: string;
  contentType: TranslationContentType;
}

export interface TranslationClaim {
  requestId: string;
  bodyHash: string;
  claimToken: string;
}

export interface ClaimTranslationRequestOptions {
  workerId: string;
  claimToken: string;
  now?: Date;
  leaseMs?: number;
}

export interface FailTranslationRequestOptions extends TranslationClaim {
  error: unknown;
  now?: Date;
  /**
   * Set this only for a retryable failure. Omitting it marks the source version
   * terminally failed until a different source hash is requested.
   */
  retryAt?: Date;
}

function requests(db: Db): MongoCollection {
  return db.collection(TRANSLATION_REQUESTS_COLLECTION);
}

export function translationRequestId(
  source: Pick<TranslationRequestSource, "lang" | "type" | "projectId">,
): string {
  return `${source.lang}:${source.type}:${source.projectId}`;
}

function didMatch(result: unknown): boolean {
  return typeof result === "object" && result !== null &&
    "matchedCount" in result &&
    Number((result as { matchedCount?: unknown }).matchedCount) > 0;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null &&
    Number((error as { code?: unknown }).code) === 11000
  ) ||
    error instanceof Error && /duplicate key/i.test(error.message);
}

function asUpdatedDocument(result: unknown): TranslationRequest | undefined {
  if (!result) return undefined;
  if (typeof result === "object" && "value" in result) {
    return ((result as { value?: TranslationRequest | null }).value ??
      undefined);
  }
  return result as TranslationRequest;
}

function errorMessage(error: unknown): string {
  let message: string | undefined;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = undefined;
    }
  }
  return (message || "Unknown translation failure").slice(0, 1_000);
}

/**
 * Create or touch the one request record for a language, source type, and
 * project. A source-hash change atomically invalidates any previous lease and
 * makes the new source version pending. Calls with the same hash only update
 * request timestamps/counts; they do not clear a backoff or repeat work.
 */
export async function recordTranslationRequest(
  db: Db,
  source: TranslationRequestSource,
  now = new Date(),
): Promise<void> {
  const coll = requests(db);
  const _id = translationRequestId(source);

  // A conditional update handles source replacement in one document operation.
  // If no document exists, or a competing request inserted a different hash,
  // the hash-qualified upsert below either creates it or retries the replacement.
  for (let retries = 0; retries < 3; retries++) {
    const replacement = await coll.updateOne(
      { _id, bodyHash: { $ne: source.bodyHash } },
      {
        $set: {
          ...source,
          status: "pending",
          lastRequestedAt: now,
          updatedAt: now,
          attempts: 0,
        },
        $inc: { requestCount: 1 },
        $unset: {
          claimedBy: "",
          claimToken: "",
          claimedAt: "",
          leaseExpiresAt: "",
          completedAt: "",
          failedAt: "",
          lastError: "",
          notBefore: "",
        },
      },
    );
    if (didMatch(replacement)) return;

    try {
      await coll.updateOne(
        { _id, bodyHash: source.bodyHash },
        {
          $setOnInsert: {
            _id,
            ...source,
            status: "pending",
            createdAt: now,
            firstRequestedAt: now,
            attempts: 0,
          },
          $set: { lastRequestedAt: now, updatedAt: now },
          $inc: { requestCount: 1 },
        },
        { upsert: true },
      );
      return;
    } catch (error) {
      if (!isDuplicateKeyError(error) || retries === 2) throw error;
    }
  }
}

function claimFilter(
  requestId: string | undefined,
  now: Date,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $and: [
      {
        $or: [
          {
            status: "pending",
            $or: [
              { notBefore: { $exists: false } },
              { notBefore: { $lte: now } },
            ],
          },
          { status: "failed", notBefore: { $lte: now } },
        ],
      },
      {
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
        ],
      },
    ],
  };
  if (requestId) filter._id = requestId;
  return filter;
}

async function claim(
  db: Db,
  requestId: string | undefined,
  options: ClaimTranslationRequestOptions,
): Promise<TranslationRequest | undefined> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("leaseMs must be a positive finite number");
  }

  const result = await requests(db).findOneAndUpdate(
    claimFilter(requestId, now),
    {
      $set: {
        status: "pending",
        claimedBy: options.workerId,
        claimToken: options.claimToken,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
      $unset: { notBefore: "" },
    },
    { returnDocument: "after" },
  );
  return asUpdatedDocument(result);
}

/**
 * Atomically lease an eligible request. A batch worker must use the returned
 * body hash and claim token when completing or failing its work.
 */
export function claimNextTranslationRequest(
  db: Db,
  options: ClaimTranslationRequestOptions,
): Promise<TranslationRequest | undefined> {
  return claim(db, undefined, options);
}

/** Atomically lease a known request when a worker has selected it itself. */
export function claimTranslationRequest(
  db: Db,
  requestId: string,
  options: ClaimTranslationRequestOptions,
): Promise<TranslationRequest | undefined> {
  return claim(db, requestId, options);
}

/**
 * Mark a claimed source version complete after its translated content was
 * written to `<lang>_translation`. A stale lease cannot complete a replacement
 * source version because both its token and hash are matched.
 */
export async function completeTranslationRequest(
  db: Db,
  claim: TranslationClaim,
  now = new Date(),
): Promise<boolean> {
  const result = await requests(db).updateOne(
    {
      _id: claim.requestId,
      bodyHash: claim.bodyHash,
      status: "pending",
      claimToken: claim.claimToken,
    },
    {
      $set: { status: "succeeded", completedAt: now, updatedAt: now },
      $unset: {
        claimedBy: "",
        claimToken: "",
        claimedAt: "",
        leaseExpiresAt: "",
        failedAt: "",
        lastError: "",
        notBefore: "",
      },
    },
  );
  return didMatch(result);
}

/**
 * Release a claimed request after an error. A retryable failure remains
 * claimable only when `retryAt` has passed; omitting it records a terminal
 * failure. The claim token prevents one expired worker from overwriting a newer
 * worker's result.
 */
export async function failTranslationRequest(
  db: Db,
  options: FailTranslationRequestOptions,
): Promise<boolean> {
  const now = options.now ?? new Date();
  const result = await requests(db).updateOne(
    {
      _id: options.requestId,
      bodyHash: options.bodyHash,
      status: "pending",
      claimToken: options.claimToken,
    },
    {
      $set: {
        status: "failed",
        failedAt: now,
        updatedAt: now,
        lastError: errorMessage(options.error),
        ...(options.retryAt ? { notBefore: options.retryAt } : {}),
      },
      $unset: {
        claimedBy: "",
        claimToken: "",
        claimedAt: "",
        leaseExpiresAt: "",
        ...(options.retryAt ? {} : { notBefore: "" }),
      },
    },
  );
  return didMatch(result);
}
