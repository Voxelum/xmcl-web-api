import type {
  TranslationContentType,
  TranslationKey,
} from "./translationStore.ts";

const EDGE_CACHE_VERSION = 1;
const MAX_EDGE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TranslationEdgeValue extends TranslationKey {
  content: string;
  contentType: TranslationContentType;
  sourceHash?: string;
  updatedAt: string;
  validUntil: string;
}

export interface TranslationEdgeCache {
  get(key: TranslationKey): Promise<TranslationEdgeValue | undefined>;
  put(value: TranslationEdgeValue): Promise<void>;
}

interface KvNamespace {
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface StoredTranslation extends TranslationEdgeValue {
  version: number;
}

export class KvTranslationEdgeCache implements TranslationEdgeCache {
  constructor(
    private readonly namespace: KvNamespace,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: TranslationKey): Promise<TranslationEdgeValue | undefined> {
    const value = await this.namespace.get(edgeCacheKey(key), "json");
    if (!isStoredTranslation(value, key, this.now())) return undefined;
    const { version: _version, ...translation } = value;
    return translation;
  }

  async put(value: TranslationEdgeValue): Promise<void> {
    const validUntil = Date.parse(value.validUntil);
    if (!Number.isFinite(validUntil) || validUntil <= this.now()) {
      throw new Error("Translation edge cache expiry must be in the future");
    }
    const stored: StoredTranslation = {
      version: EDGE_CACHE_VERSION,
      ...value,
    };
    const requestedTtl = Math.ceil(
      (validUntil - this.now()) / 1_000,
    );
    const expirationTtl = Math.max(
      60,
      Math.min(requestedTtl, MAX_EDGE_CACHE_TTL_SECONDS),
    );
    await this.namespace.put(
      edgeCacheKey(value),
      JSON.stringify(stored),
      { expirationTtl },
    );
  }
}

export function getTranslationEdgeCache(
  binding: unknown,
): TranslationEdgeCache | undefined {
  if (
    !binding || typeof binding !== "object" ||
    typeof (binding as Partial<KvNamespace>).get !== "function" ||
    typeof (binding as Partial<KvNamespace>).put !== "function"
  ) {
    return undefined;
  }
  return new KvTranslationEdgeCache(binding as KvNamespace);
}

export function edgeCacheKey(key: TranslationKey) {
  return `v${EDGE_CACHE_VERSION}:${key.locale}:${key.type}:${key.projectId}`;
}

function isStoredTranslation(
  value: unknown,
  key: TranslationKey,
  now: number,
): value is StoredTranslation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredTranslation>;
  return candidate.version === EDGE_CACHE_VERSION &&
    candidate.locale === key.locale &&
    candidate.type === key.type &&
    candidate.projectId === key.projectId &&
    typeof candidate.content === "string" &&
    candidate.content.length > 0 &&
    (candidate.contentType === "text/html" ||
      candidate.contentType === "text/markdown") &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.validUntil === "string" &&
    Date.parse(candidate.validUntil) > now;
}
