import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Db, MongoCollection } from "../db.ts";
import type {
  TranslationEdgeCache,
  TranslationEdgeValue,
} from "../translationEdgeCache.ts";
import type {
  TranslationKey,
  TranslationRecord,
  TranslationStore,
} from "../translationStore.ts";
import {
  claimNextTranslationRequest,
  completeTranslationRequest,
  failTranslationRequest,
  recordTranslationRequest,
} from "../translation_requests.ts";
import type { AppEnv } from "../types.ts";
import { createTranslationRoutes, requestedLocale } from "./translation.ts";

type Document = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equals(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function matches(document: Document, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") {
      return (expected as Record<string, unknown>[]).every((part) =>
        matches(document, part)
      );
    }
    if (key === "$or") {
      return (expected as Record<string, unknown>[]).some((part) =>
        matches(document, part)
      );
    }

    const actual = document[key];
    if (
      expected && typeof expected === "object" && !(expected instanceof Date)
    ) {
      const operators = expected as Record<string, unknown>;
      return Object.entries(operators).every(([operator, value]) => {
        if (operator === "$eq") return equals(actual, value);
        if (operator === "$ne") return !equals(actual, value);
        if (operator === "$exists") {
          return Boolean(value) === (actual !== undefined);
        }
        if (operator === "$lte") {
          return actual instanceof Date && value instanceof Date
            ? actual.getTime() <= value.getTime()
            : (actual as number) <= (value as number);
        }
        throw new Error(`Unsupported test filter operator ${operator}`);
      });
    }
    return equals(actual, expected);
  });
}

function equalityFields(filter: Record<string, unknown>): Document {
  const document: Document = {};
  for (const [key, value] of Object.entries(filter)) {
    if (
      !key.startsWith("$") && (
        typeof value !== "object" || value === null || value instanceof Date
      )
    ) {
      document[key] = value;
    }
  }
  return document;
}

function applyUpdate(
  document: Document,
  update: Record<string, unknown>,
  inserting: boolean,
) {
  if (inserting && update.$setOnInsert) {
    Object.assign(document, clone(update.$setOnInsert as Document));
  }
  if (update.$set) Object.assign(document, clone(update.$set as Document));
  if (update.$inc) {
    for (const [key, value] of Object.entries(update.$inc as Document)) {
      document[key] = Number(document[key] ?? 0) + Number(value);
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset as Document)) {
      delete document[key];
    }
  }
}

class MemoryCollection implements MongoCollection {
  readonly documents = new Map<string, Document>();

  seed(document: Document) {
    this.documents.set(String(document._id), clone(document));
  }

  async findOne(filter: Document) {
    const found = [...this.documents.values()].find((document) =>
      matches(document, filter)
    );
    return found && clone(found);
  }

  async findOneAndUpdate(
    filter: Document,
    update: Document,
    options?: {
      sort?: Record<string, 1 | -1>;
      returnDocument?: "before" | "after";
    },
  ) {
    const candidates = [...this.documents.values()].filter((document) =>
      matches(document, filter)
    );
    const sort = options?.sort;
    if (sort) {
      candidates.sort((left, right) => {
        for (const [field, direction] of Object.entries(sort)) {
          const a = left[field] instanceof Date
            ? (left[field] as Date).getTime()
            : left[field];
          const b = right[field] instanceof Date
            ? (right[field] as Date).getTime()
            : right[field];
          if (a === b) continue;
          return (a! < b! ? -1 : 1) * direction;
        }
        return 0;
      });
    }
    const found = candidates[0];
    if (!found) return undefined;
    const before = clone(found);
    applyUpdate(found, update, false);
    return clone(options?.returnDocument === "before" ? before : found);
  }

  async updateOne(
    filter: Document,
    update: Document,
    options?: { upsert?: boolean },
  ) {
    let found = [...this.documents.values()].find((document) =>
      matches(document, filter)
    );
    const inserting = !found && Boolean(options?.upsert);
    if (inserting) {
      found = equalityFields(filter);
      this.documents.set(String(found._id), found);
    }
    if (!found) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(found, update, inserting);
    return { matchedCount: inserting ? 0 : 1, modifiedCount: 1 };
  }

  async replaceOne(
    filter: Document,
    replacement: Document,
    options?: { upsert?: boolean },
  ) {
    const found = [...this.documents.values()].find((document) =>
      matches(document, filter)
    );
    if (found || options?.upsert) {
      this.documents.set(String(replacement._id), clone(replacement));
      return { matchedCount: found ? 1 : 0 };
    }
    return { matchedCount: 0 };
  }

  async deleteOne(filter: Document) {
    const found = [...this.documents.values()].find((document) =>
      matches(document, filter)
    );
    if (found) this.documents.delete(String(found._id));
    return { deletedCount: found ? 1 : 0 };
  }
}

class MemoryDb implements Db {
  private readonly collections = new Map<string, MemoryCollection>();

  collection(name: string): MemoryCollection {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new MemoryCollection();
      this.collections.set(name, collection);
    }
    return collection;
  }
}

const source = {
  lang: "ja",
  type: "modrinth",
  projectId: "project",
  bodyHash: "hash-a",
  contentType: "text/markdown" as const,
};

Deno.test("translation request ledger deduplicates and replaces source versions", async () => {
  const db = new MemoryDb();
  const first = new Date("2026-07-23T00:00:00.000Z");
  await recordTranslationRequest(db, source, first);
  await recordTranslationRequest(
    db,
    source,
    new Date("2026-07-23T00:01:00.000Z"),
  );
  await recordTranslationRequest(
    db,
    { ...source, bodyHash: "hash-b" },
    new Date("2026-07-23T00:02:00.000Z"),
  );

  const document = await db.collection("translation_requests").findOne({
    _id: "ja:modrinth:project",
  });
  assert.ok(document);
  assert.equal(document.bodyHash, "hash-b");
  assert.equal(document.status, "pending");
  assert.equal(document.requestCount, 3);
  assert.equal(document.attempts, 0);
  assert.equal(
    (document.lastRequestedAt as Date).toISOString(),
    "2026-07-23T00:02:00.000Z",
  );
  assert.equal("body" in document, false);
});

Deno.test("translation request claims honor retry times and stale completion tokens", async () => {
  const db = new MemoryDb();
  const start = new Date("2026-07-23T00:00:00.000Z");
  await recordTranslationRequest(db, source, start);

  const first = await claimNextTranslationRequest(db, {
    workerId: "daily-worker",
    claimToken: "claim-one",
    now: start,
  });
  assert.equal(first?.claimToken, "claim-one");
  assert.equal(
    await completeTranslationRequest(
      db,
      {
        requestId: first!._id,
        bodyHash: first!.bodyHash,
        claimToken: "stale-claim",
      },
      start,
    ),
    false,
  );
  assert.equal(
    await failTranslationRequest(db, {
      requestId: first!._id,
      bodyHash: first!.bodyHash,
      claimToken: "claim-one",
      error: new Error("upstream timeout"),
      retryAt: new Date("2026-07-23T01:00:00.000Z"),
      now: start,
    }),
    true,
  );
  assert.equal(
    await claimNextTranslationRequest(db, {
      workerId: "daily-worker",
      claimToken: "too-early",
      now: new Date("2026-07-23T00:59:59.000Z"),
    }),
    undefined,
  );

  const retry = await claimNextTranslationRequest(db, {
    workerId: "daily-worker",
    claimToken: "claim-two",
    now: new Date("2026-07-23T01:00:00.000Z"),
  });
  assert.equal(retry?.claimToken, "claim-two");
  assert.equal(retry?.attempts, 2);
  assert.equal(
    await failTranslationRequest(db, {
      requestId: retry!._id,
      bodyHash: retry!.bodyHash,
      claimToken: "claim-two",
      error: "invalid source",
      now: new Date("2026-07-23T01:01:00.000Z"),
    }),
    true,
  );
  assert.equal(
    await claimNextTranslationRequest(db, {
      workerId: "daily-worker",
      claimToken: "terminal",
      now: new Date("2026-07-24T00:00:00.000Z"),
    }),
    undefined,
  );
});

async function withTranslationFetch<T>(
  responder: (url: URL) => Response | Promise<Response>,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string) =>
    Promise.resolve(responder(
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url),
    ));
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

class MemoryTranslationStore implements TranslationStore {
  readonly records = new Map<string, TranslationRecord>();
  accesses = 0;

  key(key: TranslationKey) {
    return `${key.locale}:${key.type}:${key.projectId}`;
  }

  get(key: TranslationKey) {
    return Promise.resolve(this.records.get(this.key(key)));
  }

  recordAccess(key: TranslationKey, now = new Date()) {
    this.accesses++;
    const id = this.key(key);
    const existing = this.records.get(id);
    const timestamp = now.toISOString();
    const record: TranslationRecord = existing
      ? {
        ...existing,
        accessCount: existing.accessCount + 1,
        lastAccessedAt: timestamp,
      }
      : {
        ...key,
        contentType: key.type === "modrinth" ? "text/markdown" : "text/html",
        status: "pending",
        accessCount: 1,
        firstAccessedAt: timestamp,
        lastAccessedAt: timestamp,
        nextProcessAt: timestamp,
        updatedAt: timestamp,
      };
    this.records.set(id, record);
    return Promise.resolve(record);
  }

  listDue() {
    return Promise.resolve([]);
  }
  claim() {
    return Promise.resolve(undefined);
  }
  putTranslation() {
    return Promise.resolve();
  }
  complete() {
    return Promise.resolve();
  }
  fail() {
    return Promise.resolve();
  }
  stageEdgeSync() {
    return Promise.resolve();
  }
  completeEdgeSync() {
    return Promise.resolve();
  }
  retryEdgeSync() {
    return Promise.resolve();
  }
}

class FailingTranslationStore extends MemoryTranslationStore {
  override get(): Promise<TranslationRecord | undefined> {
    return Promise.reject(new Error("Azure unavailable"));
  }

  override recordAccess(): Promise<TranslationRecord> {
    return Promise.reject(new Error("Azure unavailable"));
  }
}

class MemoryEdgeCache implements TranslationEdgeCache {
  readonly values = new Map<string, TranslationEdgeValue>();

  get(key: TranslationKey) {
    return Promise.resolve(
      this.values.get(`${key.locale}:${key.type}:${key.projectId}`),
    );
  }

  put(value: TranslationEdgeValue) {
    this.values.set(
      `${value.locale}:${value.type}:${value.projectId}`,
      value,
    );
    return Promise.resolve();
  }
}

function translationApp(
  store: TranslationStore,
  staticBase =
    "https://raw.githubusercontent.com/Voxelum/xmcl-community-content-i18n-extra/main",
  edgeCache?: TranslationEdgeCache,
) {
  const app = new Hono<AppEnv>();
  app.route(
    "/",
    createTranslationRoutes(() => store, staticBase, () => edgeCache),
  );
  return app;
}

Deno.test("translation serves dynamic cache without fetching project source", async () => {
  const store = new MemoryTranslationStore();
  const now = new Date().toISOString();
  store.records.set("ja:modrinth:cached-project", {
    locale: "ja",
    type: "modrinth",
    projectId: "cached-project",
    content: "Cached translation",
    contentType: "text/markdown",
    status: "ready",
    accessCount: 10,
    firstAccessedAt: now,
    lastAccessedAt: now,
    nextProcessAt: now,
    updatedAt: now,
  });
  const app = translationApp(store, "https://i18n.example");
  let fetches = 0;
  const cached = await withTranslationFetch(
    () => {
      fetches++;
      throw new Error("cache hit must not fetch");
    },
    () =>
      app.request(
        "/translation?type=modrinth&id=cached-project",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(cached.status, 200);
  assert.equal(await cached.text(), "Cached translation");
  assert.equal(cached.headers.get("x-xmcl-translation-source"), "azure-table");
  assert.equal(fetches, 0);
});

Deno.test("translation serves KV before Azure and still records demand", async () => {
  const store = new MemoryTranslationStore();
  const edge = new MemoryEdgeCache();
  edge.values.set("ja:modrinth:edge-project", {
    locale: "ja",
    type: "modrinth",
    projectId: "edge-project",
    content: "Edge translation",
    contentType: "text/markdown",
    updatedAt: "2026-08-05T00:00:00.000Z",
    validUntil: "2099-08-05T00:00:00.000Z",
  });
  const app = translationApp(store, "https://i18n.example", edge);
  const response = await withTranslationFetch(
    () => {
      throw new Error("KV hit must not fetch");
    },
    () =>
      app.request(
        "/translation?type=modrinth&id=edge-project",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Edge translation");
  assert.equal(
    response.headers.get("x-xmcl-translation-source"),
    "cloudflare-kv",
  );
  await Promise.resolve();
  assert.equal(store.accesses, 1);
});

Deno.test("translation Table fallback never writes KV from request path", async () => {
  const store = new MemoryTranslationStore();
  const edge = new MemoryEdgeCache();
  const now = new Date().toISOString();
  store.records.set("ja:modrinth:read-through", {
    locale: "ja",
    type: "modrinth",
    projectId: "read-through",
    content: "Table translation",
    contentType: "text/markdown",
    status: "ready",
    accessCount: 1,
    firstAccessedAt: now,
    lastAccessedAt: now,
    nextProcessAt: now,
    updatedAt: now,
  });
  const app = translationApp(store, "https://i18n.example", edge);
  const response = await app.request(
    "/translation?type=modrinth&id=read-through",
    { headers: { "accept-language": "ja" } },
  );
  assert.equal(response.status, 200);
  await Promise.resolve();
  assert.equal(
    edge.values.get("ja:modrinth:read-through"),
    undefined,
  );
});

Deno.test("translation serves modern static layout and records access", async () => {
  const store = new MemoryTranslationStore();
  const app = translationApp(store, "https://i18n.example");
  let fetchedPath = "";
  const response = await withTranslationFetch(
    (url) => {
      fetchedPath = url.pathname;
      return Response.json({
        type: "modrinth",
        contentType: "text/markdown",
        content: "Static translation",
      });
    },
    () =>
      app.request(
        "/translation?type=modrinth&id=static-project",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(fetchedPath, "/ja/modrinth/static-project.json");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Static translation");
  await Promise.resolve();
  assert.equal(store.accesses, 1);
});

Deno.test("translation uses legacy static files only when provider type matches", async () => {
  const store = new MemoryTranslationStore();
  const app = translationApp(store, "https://i18n.example");
  const paths: string[] = [];
  const response = await withTranslationFetch(
    (url) => {
      paths.push(url.pathname);
      if (url.pathname.includes("/modrinth/")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        type: "curseforge",
        content: "Wrong provider",
      });
    },
    () =>
      app.request(
        "/translation?type=modrinth&id=legacy-project",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(paths, [
    "/ja/modrinth/legacy-project.json",
    "/ja/legacy-project.json",
  ]);
});

Deno.test("translation serves static cache while Azure Table is unavailable", async () => {
  const app = translationApp(
    new FailingTranslationStore(),
    "https://i18n.example",
  );
  const response = await withTranslationFetch(
    () =>
      Response.json({
        type: "modrinth",
        content: "Static fallback",
      }),
    () =>
      app.request(
        "/translation?type=modrinth&id=azure-outage-static",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Static fallback");
});

Deno.test("translation returns 503 when a miss cannot be recorded", async () => {
  const app = translationApp(
    new FailingTranslationStore(),
    "https://i18n.example",
  );
  const response = await withTranslationFetch(
    () => new Response(null, { status: 404 }),
    () =>
      app.request(
        "/translation?type=modrinth&id=azure-outage-miss",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.json()).error,
    "translation_store_unavailable",
  );
});

Deno.test("translation miss records access without fetching provider source", async () => {
  const store = new MemoryTranslationStore();
  const app = translationApp(store, "https://i18n.example");
  let providerFetches = 0;
  const response = await withTranslationFetch(
    (url) => {
      if (
        url.hostname === "api.modrinth.com" ||
        url.hostname === "api.curseforge.com"
      ) providerFetches++;
      return new Response(null, { status: 404 });
    },
    () =>
      app.request(
        "/translation?type=modrinth&id=missing-project",
        { headers: { "accept-language": "ja" } },
      ),
  );
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("retry-after"), "300");
  assert.equal(providerFetches, 0);
  assert.equal(store.accesses, 1);
  assert.ok(store.records.has("ja:modrinth:missing-project"));
});

Deno.test("translation static misses are negatively cached", async () => {
  const store = new MemoryTranslationStore();
  const app = translationApp(store, "https://i18n.example");
  let i18nCalls = 0;
  await withTranslationFetch(
    () => {
      i18nCalls++;
      return new Response(null, { status: 404 });
    },
    async () => {
      const request = () =>
        app.request(
          "/translation?type=modrinth&id=negative-cache-project",
          { headers: { "accept-language": "fr" } },
        );
      assert.equal((await request()).status, 202);
      assert.equal((await request()).status, 202);
    },
  );
  // Modern and legacy paths are each fetched once.
  assert.equal(i18nCalls, 2);
});

Deno.test("translation locale selection honors quality and canonical form", () => {
  assert.equal(requestedLocale("zh-cn;q=0.8, zh-TW;q=0.9"), "zh-TW");
  assert.equal(requestedLocale("invalid_locale"), undefined);
});

Deno.test("translation applies a per-client request limit", async () => {
  const app = translationApp(new MemoryTranslationStore());
  const headers = {
    "accept-language": "en",
    "cf-connecting-ip": "translation-rate-limit-test",
  };

  for (let index = 0; index < 60; index += 1) {
    assert.equal(
      (await app.request("/translation?type=modrinth&id=limited", { headers }))
        .status,
      204,
    );
  }

  const limited = await app.request(
    "/translation?type=modrinth&id=limited",
    { headers },
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
});
