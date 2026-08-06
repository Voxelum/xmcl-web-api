import assert from "node:assert/strict";
import type { AppConfig } from "./config.ts";
import { getHasher } from "./hasher.ts";
import {
  fetchTranslationSource,
  runTranslationScheduledSweep,
} from "./translationScheduling.ts";
import type {
  TranslationEdgeCache,
  TranslationEdgeValue,
} from "./translationEdgeCache.ts";
import type {
  TranslationRecord,
  TranslationStore,
} from "./translationStore.ts";

function dueRecord(
  overrides: Partial<TranslationRecord> = {},
): TranslationRecord {
  return {
    locale: "ja",
    type: "modrinth",
    projectId: "project",
    contentType: "text/markdown",
    status: "pending",
    accessCount: 1,
    firstAccessedAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T00:00:00.000Z",
    nextProcessAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    etag: 'W/"due"',
    ...overrides,
  };
}

class ScheduledStore implements TranslationStore {
  translated?: string;
  completed = 0;
  failed = 0;
  claimedUntil: string[] = [];
  failedUntil?: string;
  edgeCompleted = 0;
  edgeRetriedAt?: string;

  constructor(readonly due: TranslationRecord[]) {}

  get() {
    return Promise.resolve(undefined);
  }
  recordAccess() {
    return Promise.resolve(this.due[0]);
  }
  listDue(_now: Date, limit: number) {
    return Promise.resolve(this.due.slice(0, limit));
  }
  claim(record: TranslationRecord, leaseToken: string, leaseExpiresAt: Date) {
    this.claimedUntil.push(leaseExpiresAt.toISOString());
    return Promise.resolve({
      ...record,
      status: "processing" as const,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      etag: 'W/"claimed"',
    });
  }
  putTranslation(
    _record: TranslationRecord,
    input: {
      content: string;
      contentType: "text/markdown" | "text/html";
      sourceHash: string;
      nextProcessAt: Date;
    },
  ) {
    this.translated = input.content;
    return Promise.resolve();
  }
  stageEdgeSync(
    _record: TranslationRecord,
    input: {
      content: string;
      contentType: "text/markdown" | "text/html";
      sourceHash: string;
      nextProcessAt: Date;
    },
  ) {
    this.translated = input.content;
    return Promise.resolve();
  }
  complete() {
    this.completed++;
    return Promise.resolve();
  }
  fail(_record: TranslationRecord, _error: string, nextProcessAt: Date) {
    this.failed++;
    this.failedUntil = nextProcessAt.toISOString();
    return Promise.resolve();
  }
  completeEdgeSync() {
    this.edgeCompleted++;
    return Promise.resolve();
  }
  retryEdgeSync(_record: TranslationRecord, retryAt: Date) {
    this.edgeRetriedAt = retryAt.toISOString();
    return Promise.resolve();
  }
}

const config = {
  AGNES_API_KEYS: '["agnes-key"]',
} as AppConfig;

Deno.test("scheduled translation fetches source with controlled headers", async () => {
  let request: Request | undefined;
  const source = await fetchTranslationSource(
    { type: "curseforge", projectId: "1234" },
    "curseforge-key",
    async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: "<p>Source</p>" });
    },
  );

  assert.equal(source.body, "<p>Source</p>");
  assert.equal(source.contentType, "text/html");
  assert.equal(request!.headers.get("x-api-key"), "curseforge-key");
  assert.equal(
    request!.headers.get("user-agent"),
    "xmcl-web-api/translation-scheduler",
  );
  assert.equal(request!.headers.has("authorization"), false);
  assert.equal(request!.headers.has("cookie"), false);
});

Deno.test("scheduled sweep translates and writes due records", async () => {
  const store = new ScheduledStore([dueRecord()]);
  const result = await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    fetcher: async () => Response.json({ body: "Source description" }),
    translateSource: (
      locale,
      source,
      contentType,
      apiKey,
    ) => {
      assert.equal(locale, "ja");
      assert.equal(source, "Source description");
      assert.equal(contentType, "text/markdown");
      assert.equal(apiKey, "agnes-key");
      return Promise.resolve("Translated description");
    },
  });

  assert.deepEqual(result, {
    claimed: 1,
    translated: 1,
    unchanged: 0,
    failed: 0,
    edgeSynced: 0,
    edgeSyncFailed: 0,
    edgeRetryScheduled: 0,
    edgeOnly: 0,
  });
  assert.equal(store.translated, "Translated description");
});

Deno.test("scheduled sweep writes Table before propagating to edge cache", async () => {
  const order: string[] = [];
  const store = new ScheduledStore([dueRecord()]);
  store.stageEdgeSync = (_record, _input) => {
    order.push("table");
    return Promise.resolve();
  };
  const values: TranslationEdgeValue[] = [];
  const edgeCache: TranslationEdgeCache = {
    get: () => Promise.resolve(undefined),
    put: (value) => {
      order.push("edge");
      values.push(value);
      return Promise.resolve();
    },
  };
  const result = await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    fetcher: async () => Response.json({ body: "Source description" }),
    translateSource: () => Promise.resolve("Translated"),
    edgeCache,
  });
  assert.deepEqual(order, ["table", "edge"]);
  assert.equal(values[0].content, "Translated");
  assert.equal(result.edgeSynced, 1);
  assert.equal(result.edgeSyncFailed, 0);
  assert.equal(result.edgeRetryScheduled, 0);
  assert.equal(result.edgeOnly, 0);
});

Deno.test("edge cache failure does not roll back a completed translation", async () => {
  const store = new ScheduledStore([dueRecord()]);
  const times = [
    new Date("2026-01-01T01:00:00.000Z"),
    new Date("2026-01-01T01:00:00.000Z"),
  ];
  const result = await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    clock: () => times.shift()!,
    fetcher: async () => Response.json({ body: "Source description" }),
    translateSource: () => Promise.resolve("Translated"),
    edgeCache: {
      get: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error("KV unavailable")),
    },
  });
  assert.equal(store.translated, "Translated");
  assert.equal(store.failed, 0);
  assert.equal(result.translated, 1);
  assert.equal(result.edgeSyncFailed, 1);
  assert.equal(result.edgeRetryScheduled, 1);
  assert.equal(store.edgeRetriedAt, "2026-01-01T01:05:00.000Z");
});

Deno.test("edge retry republishes Table content without fetching source", async () => {
  const store = new ScheduledStore([
    dueRecord({
      content: "Committed translation",
      sourceHash: "source-hash",
      edgeSyncPending: true,
      edgeSyncResumeAt: "2026-01-02T00:00:00.000Z",
    }),
  ]);
  const written: TranslationEdgeValue[] = [];
  const result = await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:05:00.000Z"),
    fetcher: async () => {
      throw new Error("edge-only retry must not fetch source");
    },
    edgeCache: {
      get: () => Promise.resolve(undefined),
      put: (value) => {
        written.push(value);
        return Promise.resolve();
      },
    },
  });
  assert.equal(written[0].content, "Committed translation");
  assert.equal(store.edgeCompleted, 1);
  assert.equal(result.edgeOnly, 1);
  assert.equal(result.edgeSynced, 1);
  assert.equal(result.translated, 0);
  assert.equal(result.unchanged, 0);
});

Deno.test("edge retry renews an expired cache validity window", async () => {
  const store = new ScheduledStore([
    dueRecord({
      content: "Committed translation",
      sourceHash: "source-hash",
      edgeSyncPending: true,
      edgeSyncResumeAt: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  const times = [
    new Date("2026-01-02T01:00:00.000Z"),
    new Date("2026-01-02T01:00:00.000Z"),
  ];
  let validUntil = "";
  await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-02T01:00:00.000Z"),
    clock: () => times.shift()!,
    edgeCache: {
      get: () => Promise.resolve(undefined),
      put: (value) => {
        validUntil = value.validUntil;
        return Promise.resolve();
      },
    },
  });
  assert.equal(validUntil, "2026-01-02T01:15:00.000Z");
});

Deno.test("scheduled sweep skips translation when source hash is unchanged", async () => {
  const sourceHash = (await getHasher())("Stable source");

  const store = new ScheduledStore([
    dueRecord({ content: "Existing", sourceHash }),
  ]);
  const result = await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    fetcher: async () => Response.json({ body: "Stable source" }),
    translateSource: () => {
      throw new Error("unchanged source must not translate");
    },
  });
  assert.equal(result.unchanged, 1);
  assert.equal(store.completed, 1);
});

Deno.test("scheduled sweep anchors each lease to its claim time", async () => {
  const store = new ScheduledStore([
    dueRecord({ projectId: "first" }),
    dueRecord({ projectId: "second" }),
  ]);
  const claimTimes = [
    new Date("2026-01-01T01:00:00.000Z"),
    new Date("2026-01-01T01:01:00.000Z"),
    new Date("2026-01-01T01:05:00.000Z"),
    new Date("2026-01-01T01:06:00.000Z"),
  ];
  await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    clock: () => claimTimes.shift()!,
    fetcher: async () => Response.json({ body: "Source description" }),
    translateSource: () => Promise.resolve("Translated"),
  });
  assert.deepEqual(store.claimedUntil, [
    "2026-01-01T01:20:00.000Z",
    "2026-01-01T01:25:00.000Z",
  ]);
});

Deno.test("scheduled sweep anchors failure backoff to failure time", async () => {
  const store = new ScheduledStore([dueRecord()]);
  const times = [
    new Date("2026-01-01T01:00:00.000Z"),
    new Date("2026-01-01T02:30:00.000Z"),
  ];
  await runTranslationScheduledSweep(store, config, {
    now: new Date("2026-01-01T01:00:00.000Z"),
    clock: () => times.shift()!,
    fetcher: async () => new Response("failed", { status: 503 }),
  });
  assert.equal(store.failedUntil, "2026-01-01T03:30:00.000Z");
});
