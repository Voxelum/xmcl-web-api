import type { AppConfig } from "./config.ts";
import { getHasher } from "./hasher.ts";
import { parseAgnesApiKeys } from "./agnes.ts";
import { translate } from "./translation.ts";
import type {
  TranslationEdgeCache,
  TranslationEdgeValue,
} from "./translationEdgeCache.ts";
import {
  type TranslationContentType,
  type TranslationRecord,
  type TranslationStore,
} from "./translationStore.ts";

const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 100;
const LEASE_MS = 20 * 60_000;
const HOT_REFRESH_MS = 6 * 60 * 60_000;
const NORMAL_REFRESH_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const EDGE_SYNC_RETRY_MS = 5 * 60_000;
const EDGE_STALE_GRACE_MS = 10 * 60_000;
const SOURCE_TIMEOUT_MS = 30_000;

export interface TranslationScheduledResult {
  claimed: number;
  translated: number;
  unchanged: number;
  failed: number;
  edgeSynced: number;
  edgeSyncFailed: number;
  edgeRetryScheduled: number;
  edgeOnly: number;
}

export async function runTranslationScheduledSweep(
  store: TranslationStore,
  config: AppConfig,
  input: {
    now?: Date;
    clock?: () => Date;
    fetcher?: typeof fetch;
    translateSource?: typeof translateScheduledSource;
    edgeCache?: TranslationEdgeCache;
  } = {},
): Promise<TranslationScheduledResult> {
  const now = input.now ?? new Date();
  const clock = input.clock ?? (() => new Date());
  const fetcher = input.fetcher ?? fetch;
  const translateSource = input.translateSource ?? translateScheduledSource;
  const limit = scheduledLimit(config.TRANSLATION_SCHEDULED_BATCH_LIMIT);
  const apiKeys = parseAgnesApiKeys(config.AGNES_API_KEYS);
  const due = await store.listDue(now, limit);
  const result: TranslationScheduledResult = {
    claimed: 0,
    translated: 0,
    unchanged: 0,
    failed: 0,
    edgeSynced: 0,
    edgeSyncFailed: 0,
    edgeRetryScheduled: 0,
    edgeOnly: 0,
  };

  for (let index = 0; index < due.length; index++) {
    const candidate = due[index];
    const claimedAt = clock();
    const claimed = await store.claim(
      candidate,
      crypto.randomUUID(),
      new Date(claimedAt.getTime() + LEASE_MS),
    );
    if (!claimed) continue;
    result.claimed++;

    if (claimed.edgeSyncPending && claimed.content) {
      try {
        const attemptedAt = clock();
        const resumeAt = claimed.edgeSyncResumeAt
          ? new Date(claimed.edgeSyncResumeAt)
          : nextRefreshAt(claimed, attemptedAt);
        const edgeValue: TranslationEdgeValue = {
          locale: claimed.locale,
          type: claimed.type,
          projectId: claimed.projectId,
          content: claimed.content,
          contentType: claimed.contentType,
          sourceHash: claimed.sourceHash,
          updatedAt: claimed.updatedAt,
          validUntil: edgeRetryValidUntil(resumeAt, attemptedAt),
        };
        if (await syncEdgeCache(input.edgeCache, edgeValue, result)) {
          await store.completeEdgeSync(claimed);
        } else {
          await store.retryEdgeSync(
            claimed,
            new Date(attemptedAt.getTime() + EDGE_SYNC_RETRY_MS),
          );
          result.edgeRetryScheduled++;
        }
        result.edgeOnly++;
      } catch (error) {
        console.error({
          event: "translation.edge_cache.retry_failed",
          locale: claimed.locale,
          type: claimed.type,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      continue;
    }

    try {
      const source = await fetchTranslationSource(
        claimed,
        config.CURSEFORGE_KEY,
        fetcher,
      );
      const sourceHash = (await getHasher())(source.body);
      if (claimed.content && claimed.sourceHash === sourceHash) {
        const completedAt = clock();
        const refreshAt = nextRefreshAt(claimed, completedAt);
        const edgeValue = {
          locale: claimed.locale,
          type: claimed.type,
          projectId: claimed.projectId,
          content: claimed.content,
          contentType: claimed.contentType,
          sourceHash: claimed.sourceHash,
          updatedAt: completedAt.toISOString(),
          validUntil: edgeValidUntil(refreshAt),
        };
        if (input.edgeCache) {
          await store.stageEdgeSync(claimed, {
            content: claimed.content,
            contentType: claimed.contentType,
            sourceHash,
            nextProcessAt: refreshAt,
          });
          await finishStagedEdgeSync(
            store,
            claimed,
            input.edgeCache,
            edgeValue,
            completedAt,
            result,
          );
        } else {
          await store.complete(claimed, refreshAt);
        }
        result.unchanged++;
        continue;
      }

      const content = await translateSource(
        claimed.locale,
        source.body,
        source.contentType,
        apiKeys[index % apiKeys.length],
      );
      const completedAt = clock();
      const refreshAt = nextRefreshAt(claimed, completedAt);
      const edgeValue = {
        locale: claimed.locale,
        type: claimed.type,
        projectId: claimed.projectId,
        content,
        contentType: source.contentType,
        sourceHash,
        updatedAt: completedAt.toISOString(),
        validUntil: edgeValidUntil(refreshAt),
      };
      if (input.edgeCache) {
        await store.stageEdgeSync(claimed, {
          content,
          contentType: source.contentType,
          sourceHash,
          nextProcessAt: refreshAt,
        });
        await finishStagedEdgeSync(
          store,
          claimed,
          input.edgeCache,
          edgeValue,
          completedAt,
          result,
        );
      } else {
        await store.putTranslation(claimed, {
          content,
          contentType: source.contentType,
          sourceHash,
          nextProcessAt: refreshAt,
        });
      }
      result.translated++;
    } catch (error) {
      result.failed++;
      try {
        await store.fail(
          claimed,
          error instanceof Error ? error.message : String(error),
          new Date(clock().getTime() + RETRY_MS),
        );
      } catch (failureError) {
        console.error({
          event: "translation.scheduled.failure_state_write_failed",
          locale: claimed.locale,
          type: claimed.type,
          errorName: failureError instanceof Error
            ? failureError.name
            : "UnknownError",
        });
      }
    }
  }

  return result;
}

async function syncEdgeCache(
  edgeCache: TranslationEdgeCache | undefined,
  value: TranslationEdgeValue,
  result: TranslationScheduledResult,
): Promise<boolean> {
  if (!edgeCache) return true;
  try {
    await edgeCache.put(value);
    result.edgeSynced++;
    return true;
  } catch (error) {
    result.edgeSyncFailed++;
    console.error({
      event: "translation.edge_cache.sync_failed",
      locale: value.locale,
      type: value.type,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

async function finishStagedEdgeSync(
  store: TranslationStore,
  claimed: TranslationRecord,
  edgeCache: TranslationEdgeCache,
  value: TranslationEdgeValue,
  completedAt: Date,
  result: TranslationScheduledResult,
) {
  const synced = await syncEdgeCache(edgeCache, value, result);
  try {
    if (synced) {
      await store.completeEdgeSync(claimed);
      return;
    }
    await store.retryEdgeSync(
      claimed,
      new Date(completedAt.getTime() + EDGE_SYNC_RETRY_MS),
    );
    result.edgeRetryScheduled++;
  } catch (error) {
    console.error({
      event: "translation.edge_cache.state_finalize_failed",
      locale: value.locale,
      type: value.type,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function fetchTranslationSource(
  record: Pick<TranslationRecord, "type" | "projectId">,
  curseforgeKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ body: string; contentType: TranslationContentType }> {
  const id = encodeURIComponent(record.projectId);
  const isModrinth = record.type === "modrinth";
  if (!isModrinth && !curseforgeKey) {
    throw new Error("CURSEFORGE_KEY is not configured");
  }
  const response = await fetcher(
    isModrinth
      ? `https://api.modrinth.com/v2/project/${id}`
      : `https://api.curseforge.com/v1/mods/${id}/description`,
    {
      headers: isModrinth
        ? {
          accept: "application/json",
          "user-agent": "xmcl-web-api/translation-scheduler",
        }
        : {
          accept: "application/json",
          "user-agent": "xmcl-web-api/translation-scheduler",
          "x-api-key": curseforgeKey!,
        },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `${record.type} source returned HTTP ${response.status}`,
    );
  }
  const body = await response.json() as {
    body?: unknown;
    data?: unknown;
  };
  const content = isModrinth ? body.body : body.data;
  if (typeof content !== "string") {
    throw new Error(`${record.type} source response has no description`);
  }
  return {
    body: content,
    contentType: isModrinth ? "text/markdown" : "text/html",
  };
}

export async function translateScheduledSource(
  locale: string,
  source: string,
  contentType: TranslationContentType,
  apiKey: string,
) {
  const result = await translate(locale, source, contentType, apiKey);
  if (typeof result === "object") {
    throw new Error(result.error.message || "translation provider failed");
  }
  if (!result.trim()) {
    throw new Error("translation provider returned no content");
  }
  return result;
}

function scheduledLimit(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_BATCH_LIMIT)
    : DEFAULT_BATCH_LIMIT;
}

function nextRefreshAt(record: TranslationRecord, now: Date) {
  const interval = record.accessCount >= 100
    ? HOT_REFRESH_MS
    : NORMAL_REFRESH_MS;
  return new Date(now.getTime() + interval);
}

function edgeValidUntil(nextRefreshAt: Date) {
  return new Date(nextRefreshAt.getTime() + EDGE_STALE_GRACE_MS).toISOString();
}

function edgeRetryValidUntil(resumeAt: Date, attemptedAt: Date) {
  return new Date(
    Math.max(
      resumeAt.getTime() + EDGE_STALE_GRACE_MS,
      attemptedAt.getTime() + EDGE_SYNC_RETRY_MS + EDGE_STALE_GRACE_MS,
    ),
  ).toISOString();
}
