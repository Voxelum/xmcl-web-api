import assert from "node:assert/strict";
import type { AppConfig } from "../config.ts";
import { getHasher } from "./hasher.ts";
import {
  fetchTranslationSource,
  runTranslationScheduledSweep,
} from "./translationScheduling.ts";
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
  complete() {
    this.completed++;
    return Promise.resolve();
  }
  fail(_record: TranslationRecord, _error: string, nextProcessAt: Date) {
    this.failed++;
    this.failedUntil = nextProcessAt.toISOString();
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
  });
  assert.equal(store.translated, "Translated description");
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
