import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import {
  getTranslationStore,
  type TranslationKey,
  type TranslationStore,
  type TranslationType,
} from "../lib/translationStore.ts";
import {
  getTranslationEdgeCache,
  type TranslationEdgeCache,
} from "../lib/translationEdgeCache.ts";
import type { AppEnv } from "../types.ts";

interface StaticTranslation {
  content?: unknown;
  contentType?: unknown;
  type?: unknown;
}

const TRANSLATION_RETRY_AFTER_SECONDS = 300;
const TRANSLATION_CACHE_MAX_AGE_SECONDS = 30 * 86_400;
const TRANSLATION_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 7 * 86_400;
const TRANSLATION_RATE_LIMIT_CAPACITY = 60;
const TRANSLATION_RATE_LIMIT_WINDOW_MS = 60_000;
const TRANSLATION_MAX_CONCURRENT_PER_CLIENT = 5;
const STATIC_NOT_FOUND_TTL_MS = 6 * 60 * 60_000;
const STATIC_NOT_FOUND_CACHE_LIMIT = 2_048;

interface TranslationRateBucket {
  tokens: number;
  updatedAt: number;
}

type StoreResolver = (c: Context<AppEnv>) => TranslationStore | undefined;
type EdgeCacheResolver = (
  c: Context<AppEnv>,
) => TranslationEdgeCache | undefined;

const translationRateBuckets = new Map<string, TranslationRateBucket>();
const translationActiveRequests = new Map<string, number>();
const staticNotFoundUntil = new Map<string, number>();
const staticInFlight = new Map<
  string,
  Promise<StaticTranslation | undefined>
>();
let staticCooldownUntil = 0;

export function createTranslationRoutes(
  resolveStore: StoreResolver = (c) => getTranslationStore(getConfig(c)),
  staticTranslationBase?: string,
  resolveEdgeCache: EdgeCacheResolver = (c) =>
    getTranslationEdgeCache(c.env.TRANSLATION_CACHE),
) {
  return new Hono<AppEnv>().get("/translation", async (c) => {
    const permit = acquireTranslationPermit(translationClientKey(c));
    if (!permit || permit.retryAfter > 0) {
      return c.json(
        {
          error: "rate_limited",
          message: "Too many translation requests",
        },
        429,
        { "retry-after": String(permit?.retryAfter ?? 1) },
      );
    }

    try {
      const key = requestKey(c);
      if (key.locale === "en" || key.locale.startsWith("en-")) {
        return c.body(null, 204);
      }

      const edgeCache = resolveEdgeCache(c);
      if (edgeCache) {
        try {
          const edge = await edgeCache.get(key);
          if (edge) {
            deferResolvedAccess(c, resolveStore, key);
            return translationResponse(
              c,
              edge.content,
              edge.contentType,
              key.locale,
              "cloudflare-kv",
            );
          }
        } catch (error) {
          console.error({
            event: "translation.edge_cache.read_failed",
            locale: key.locale,
            type: key.type,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }

      let store: TranslationStore | undefined;
      let dynamic: Awaited<ReturnType<TranslationStore["get"]>> = undefined;
      try {
        store = resolveStore(c);
        dynamic = store ? await store.get(key) : undefined;
      } catch (error) {
        console.error({
          event: "translation.store.read_failed",
          locale: key.locale,
          type: key.type,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (dynamic?.content) {
        deferAccess(c, store!, key);
        return translationResponse(
          c,
          dynamic.content,
          dynamic.contentType,
          key.locale,
          "azure-table",
        );
      }

      const staticEntry = await fetchStaticTranslation(
        staticTranslationBase?.replace(/\/+$/, "") ?? staticBase(getConfig(c)),
        key,
      );
      if (
        staticEntry && typeof staticEntry.content === "string" &&
        (staticEntry.type === undefined || staticEntry.type === key.type)
      ) {
        if (store) deferAccess(c, store, key);
        return translationResponse(
          c,
          staticEntry.content,
          staticEntry.contentType === "text/html"
            ? "text/html"
            : key.type === "curseforge"
            ? "text/html"
            : "text/markdown",
          key.locale,
          "static",
        );
      }

      if (!store) {
        console.error({
          event: "translation.store.not_configured",
          locale: key.locale,
          type: key.type,
        });
        return c.json(
          {
            error: "translation_store_unavailable",
            message: "Translation storage is not configured",
          },
          503,
        );
      }

      try {
        await store.recordAccess(key);
      } catch (error) {
        console.error({
          event: "translation.access_record.failed",
          locale: key.locale,
          type: key.type,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return c.json(
          {
            error: "translation_store_unavailable",
            message: "Translation demand could not be recorded",
          },
          503,
        );
      }
      return c.body(null, 202, {
        "retry-after": String(TRANSLATION_RETRY_AFTER_SECONDS),
      });
    } finally {
      permit.release();
    }
  });
}

export default createTranslationRoutes();

function requestKey(c: Context<AppEnv>): TranslationKey {
  const type = c.req.query("type");
  if (type !== "modrinth" && type !== "curseforge") {
    throw new HTTPException(400, { message: "Invalid type" });
  }
  const projectId = c.req.query("id")?.trim();
  if (
    !projectId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectId)
  ) {
    throw new HTTPException(400, { message: "Invalid id" });
  }
  const locale = requestedLocale(c.req.header("accept-language"));
  if (!locale) {
    throw new HTTPException(400, { message: "Invalid language" });
  }
  return { locale, type, projectId };
}

export function requestedLocale(value: string | undefined) {
  if (!value) return undefined;
  const candidates = value
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => /^q=([01](?:\.\d{1,3})?)$/i.exec(parameter.trim()))
        .find(Boolean);
      return {
        tag,
        quality: quality ? Number(quality[1]) : 1,
      };
    })
    .filter((candidate) =>
      candidate.tag !== "*" && candidate.quality > 0 &&
      /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(candidate.tag)
    )
    .sort((a, b) => b.quality - a.quality);
  for (const candidate of candidates) {
    try {
      return Intl.getCanonicalLocales(candidate.tag)[0];
    } catch {
      // Continue to the next valid preference.
    }
  }
  return undefined;
}

async function fetchStaticTranslation(
  base: string,
  key: TranslationKey,
): Promise<StaticTranslation | undefined> {
  const modern = `${base}/${encodeURIComponent(key.locale)}/${
    encodeURIComponent(key.type)
  }/${encodeURIComponent(key.projectId)}.json`;
  const modernEntry = await fetchStaticUrl(modern);
  if (modernEntry) return modernEntry;

  // Migration fallback for the original `<locale>/<projectId>.json` layout.
  const legacy = `${base}/${encodeURIComponent(key.locale)}/${
    encodeURIComponent(key.projectId)
  }.json`;
  const legacyEntry = await fetchStaticUrl(legacy);
  return legacyEntry?.type === key.type ? legacyEntry : undefined;
}

async function fetchStaticUrl(
  url: string,
): Promise<StaticTranslation | undefined> {
  if (Date.now() < staticCooldownUntil) return undefined;
  const notFoundUntil = staticNotFoundUntil.get(url);
  if (notFoundUntil && notFoundUntil > Date.now()) return undefined;
  const existing = staticInFlight.get(url);
  if (existing) return await existing;
  const pending = fetchStaticUrlUncached(url).finally(() => {
    staticInFlight.delete(url);
  });
  staticInFlight.set(url, pending);
  return await pending;
}

async function fetchStaticUrlUncached(
  url: string,
): Promise<StaticTranslation | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  } catch {
    return undefined;
  }
  if (response.status === 429 || response.status === 403) {
    const now = Date.now();
    const retryAfter = Number(response.headers.get("retry-after"));
    const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
    const requestedUntil = Number.isFinite(retryAfter) && retryAfter > 0
      ? now + retryAfter * 1_000
      : Number.isFinite(resetAt) && resetAt > now
      ? resetAt
      : now + 60_000;
    staticCooldownUntil = Math.max(
      staticCooldownUntil,
      Math.min(requestedUntil, now + 10 * 60_000),
    );
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.status === 404) {
    rememberStaticNotFound(url);
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  try {
    return await response.json() as StaticTranslation;
  } catch {
    return undefined;
  }
}

function rememberStaticNotFound(url: string) {
  const now = Date.now();
  for (const [key, expiry] of staticNotFoundUntil) {
    if (expiry <= now) staticNotFoundUntil.delete(key);
  }
  if (staticNotFoundUntil.size >= STATIC_NOT_FOUND_CACHE_LIMIT) {
    const oldest = staticNotFoundUntil.keys().next().value;
    if (oldest) staticNotFoundUntil.delete(oldest);
  }
  staticNotFoundUntil.set(url, now + STATIC_NOT_FOUND_TTL_MS);
}

function deferAccess(
  c: Context<AppEnv>,
  store: TranslationStore,
  key: TranslationKey,
) {
  const work = store.recordAccess(key).catch((error) => {
    console.error({
      event: "translation.access_record.failed",
      locale: key.locale,
      type: key.type,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
  const waitUntil = c.get("waitUntil");
  if (waitUntil) waitUntil(work);
  else void work;
}

function deferResolvedAccess(
  c: Context<AppEnv>,
  resolveStore: StoreResolver,
  key: TranslationKey,
) {
  const work = Promise.resolve()
    .then(() => resolveStore(c))
    .then((store) => store?.recordAccess(key))
    .catch((error) => {
      console.error({
        event: "translation.access_record.failed",
        locale: key.locale,
        type: key.type,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  deferWork(c, work);
}

function deferWork(c: Context<AppEnv>, work: Promise<unknown>) {
  const waitUntil = c.get("waitUntil");
  if (waitUntil) waitUntil(work);
  else void work;
}

function translationResponse(
  c: Context<AppEnv>,
  content: string,
  contentType: "text/html" | "text/markdown",
  locale: string,
  source: "cloudflare-kv" | "azure-table" | "static",
) {
  return c.body(content, 200, {
    "content-language": locale,
    "content-type": contentType,
    "cache-control": `public, max-age=${TRANSLATION_CACHE_MAX_AGE_SECONDS}, ` +
      `stale-while-revalidate=${TRANSLATION_CACHE_STALE_WHILE_REVALIDATE_SECONDS}`,
    "x-xmcl-translation-source": source,
    "vary": "accept-language",
  });
}

function staticBase(config: ReturnType<typeof getConfig>) {
  return (config.TRANSLATION_I18N_BASE ??
    "https://raw.githubusercontent.com/Voxelum/xmcl-community-content-i18n-extra/main")
    .replace(/\/+$/, "");
}

function translationClientKey(c: Context<AppEnv>) {
  return c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";
}

function acquireTranslationPermit(client: string):
  | { retryAfter: number; release: () => void }
  | undefined {
  const now = Date.now();
  const active = translationActiveRequests.get(client) ?? 0;
  if (active >= TRANSLATION_MAX_CONCURRENT_PER_CLIENT) {
    return { retryAfter: 1, release: () => {} };
  }
  const previous = translationRateBuckets.get(client) ?? {
    tokens: TRANSLATION_RATE_LIMIT_CAPACITY,
    updatedAt: now,
  };
  const refill = Math.max(0, now - previous.updatedAt) *
    TRANSLATION_RATE_LIMIT_CAPACITY / TRANSLATION_RATE_LIMIT_WINDOW_MS;
  const bucket = {
    tokens: Math.min(TRANSLATION_RATE_LIMIT_CAPACITY, previous.tokens + refill),
    updatedAt: now,
  };
  if (bucket.tokens < 1) {
    translationRateBuckets.set(client, bucket);
    return {
      retryAfter: Math.max(
        1,
        Math.ceil(
          (1 - bucket.tokens) * TRANSLATION_RATE_LIMIT_WINDOW_MS /
            TRANSLATION_RATE_LIMIT_CAPACITY / 1_000,
        ),
      ),
      release: () => {},
    };
  }
  bucket.tokens -= 1;
  translationRateBuckets.set(client, bucket);
  translationActiveRequests.set(client, active + 1);
  return {
    retryAfter: 0,
    release: () => {
      const current = translationActiveRequests.get(client) ?? 1;
      if (current <= 1) translationActiveRequests.delete(client);
      else translationActiveRequests.set(client, current - 1);
    },
  };
}
