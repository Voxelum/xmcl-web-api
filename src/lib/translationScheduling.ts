import type { AppConfig } from "../config.ts";
import { getHasher } from "./hasher.ts";
import { parseAgnesApiKeys } from "./agnes.ts";
import { translate } from "./translation.ts";
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
const SOURCE_TIMEOUT_MS = 30_000;

export interface TranslationScheduledResult {
  claimed: number;
  translated: number;
  unchanged: number;
  failed: number;
}

export async function runTranslationScheduledSweep(
  store: TranslationStore,
  config: AppConfig,
  input: {
    now?: Date;
    clock?: () => Date;
    fetcher?: typeof fetch;
    translateSource?: typeof translateScheduledSource;
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

    try {
      const source = await fetchTranslationSource(
        claimed,
        config.CURSEFORGE_KEY,
        fetcher,
      );
      const sourceHash = (await getHasher())(source.body);
      if (claimed.content && claimed.sourceHash === sourceHash) {
        await store.complete(claimed, nextRefreshAt(claimed, clock()));
        result.unchanged++;
        continue;
      }

      const content = await translateSource(
        claimed.locale,
        source.body,
        source.contentType,
        apiKeys[index % apiKeys.length],
      );
      await store.putTranslation(claimed, {
        content,
        contentType: source.contentType,
        sourceHash,
        nextProcessAt: nextRefreshAt(claimed, clock()),
      });
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
