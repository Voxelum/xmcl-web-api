import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import type { Db, MongoCollection } from "../db.ts";
import { getHasher } from "../lib/hasher.ts";
import {
  claimNextTranslationRequest,
  completeTranslationRequest,
  failTranslationRequest,
  recordTranslationRequest,
} from "../translation_requests.ts";

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
  responder: (url: URL) => Response,
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

function translationApp(db: Db) {
  return createApp((app) => {
    app.use("*", async (c, next) => {
      c.set("getDb", async () => db);
      await next();
    });
  });
}

function translationResponse(url: URL): Response {
  if (url.hostname === "api.modrinth.com") {
    return Response.json({ body: "Fresh source description" });
  }
  if (url.hostname === "i18n.example") {
    return new Response(null, { status: 404 });
  }
  throw new Error(`Unexpected fetch ${url}`);
}

Deno.test("translation serves matching cache entries and records misses for batch work", async () => {
  const db = new MemoryDb();
  const app = translationApp(db);
  const bodyHash = (await getHasher())("Fresh source description");
  db.collection("ja_translation").seed({
    _id: "cached-project",
    bodyHash,
    content: "Cached translation",
  });
  const environment = { TRANSLATION_I18N_BASE: "https://i18n.example" };

  const cached = await withTranslationFetch(
    translationResponse,
    () =>
      app.request(
        "/translation?type=modrinth&id=cached-project",
        { headers: { "accept-language": "ja" } },
        environment,
      ),
  );
  assert.equal(cached.status, 200);
  assert.equal(await cached.text(), "Cached translation");
  assert.equal(db.collection("translation_requests").documents.size, 0);

  const missed = await withTranslationFetch(
    translationResponse,
    () =>
      app.request(
        "/translation?type=modrinth&id=missing-project",
        { headers: { "accept-language": "ja" } },
        environment,
      ),
  );
  assert.equal(missed.status, 202);
  assert.equal(missed.headers.get("retry-after"), "86400");
  const request = await db.collection("translation_requests").findOne({
    _id: "ja:modrinth:missing-project",
  });
  assert.ok(request);
  assert.equal(request.bodyHash, bodyHash);
  assert.equal(request.contentType, "text/markdown");
  assert.equal("body" in request, false);
});

Deno.test("translation does not record a request when the source fetch fails", async () => {
  const db = new MemoryDb();
  const app = translationApp(db);

  const response = await withTranslationFetch(
    (url) =>
      url.hostname === "api.modrinth.com"
        ? new Response("unavailable", { status: 503 })
        : new Response(null, { status: 404 }),
    () =>
      app.request(
        "/translation?type=modrinth&id=missing-project",
        { headers: { "accept-language": "ja" } },
        { TRANSLATION_I18N_BASE: "https://i18n.example" },
      ),
  );
  assert.equal(response.status, 503);
  assert.equal(db.collection("translation_requests").documents.size, 0);
});
