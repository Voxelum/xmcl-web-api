import assert from "node:assert/strict";
import {
  AzureTableTranslationStore,
  type TranslationRecord,
} from "./translationStore.ts";

const tableUrl =
  "https://example.table.core.windows.net/translations?sv=test&sig=secret";

function record(overrides: Partial<TranslationRecord> = {}): TranslationRecord {
  return {
    locale: "zh-CN",
    type: "modrinth",
    projectId: "project-id",
    contentType: "text/markdown",
    status: "pending",
    accessCount: 1,
    firstAccessedAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T00:00:00.000Z",
    nextProcessAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    etag: 'W/"initial"',
    ...overrides,
  };
}

Deno.test("Azure translation store inserts locale-partitioned composite keys", async () => {
  const requests: Request[] = [];
  const store = new AzureTableTranslationStore(
    tableUrl,
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") return new Response(null, { status: 404 });
      return new Response(null, { status: 204 });
    },
  );

  await store.recordAccess({
    locale: "zh-CN",
    type: "curseforge",
    projectId: "1234",
  }, new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.get("dataserviceversion"), "3.0");
    assert.equal(request.headers.get("maxdataserviceversion"), "3.0");
    assert.equal(request.headers.get("x-ms-version"), "2019-02-02");
  }
  assert.match(
    requests[0].url,
    /translations\(PartitionKey='zh-CN',RowKey='curseforge:1234'\)/,
  );
  const inserted = await requests[1].json();
  assert.equal(inserted.PartitionKey, "zh-CN");
  assert.equal(inserted.RowKey, "curseforge:1234");
  assert.equal(inserted.NextProcessAt, "2026-01-01T00:00:00.000Z");
  assert.equal(inserted["NextProcessAt@odata.type"], "Edm.DateTime");
});

Deno.test("Azure translation store carries claim ETag into completion", async () => {
  const ifMatches: string[] = [];
  const current = record({
    status: "processing",
    leaseToken: "lease-token",
    leaseExpiresAt: "2099-01-01T00:20:00.000Z",
    etag: 'W/"claimed"',
  });
  const store = new AzureTableTranslationStore(
    tableUrl,
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json(toAzureEntity(current), {
          headers: { etag: current.etag! },
        });
      }
      ifMatches.push(request.headers.get("if-match") ?? "");
      return new Response(null, {
        status: 204,
        headers: ifMatches.length === 1 ? { etag: current.etag! } : undefined,
      });
    },
  );

  const claimed = await store.claim(
    record(),
    "lease-token",
    new Date("2026-01-01T00:20:00.000Z"),
  );
  assert.ok(claimed);
  await store.putTranslation(claimed, {
    content: "translated",
    contentType: "text/markdown",
    sourceHash: "source-hash",
    nextProcessAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  assert.deepEqual(ifMatches, ['W/"initial"', 'W/"claimed"']);
});

Deno.test("Azure translation store does not invalidate an active worker lease", async () => {
  let requests = 0;
  const active = record({
    status: "processing",
    leaseToken: "lease-token",
    leaseExpiresAt: "2099-01-01T00:20:00.000Z",
  });
  const store = new AzureTableTranslationStore(
    tableUrl,
    async (input, init) => {
      requests++;
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json(toAzureEntity(active), {
          headers: { etag: active.etag! },
        });
      }
      const body = await request.json();
      assert.equal(body.LeaseToken, "lease-token");
      assert.equal(body.Status, "processing");
      return new Response(null, { status: 204 });
    },
  );

  const result = await store.recordAccess(
    active,
    new Date(
      "2026-01-01T00:10:00.000Z",
    ),
  );
  assert.equal(requests, 2);
  assert.equal(result.accessCount, 2);
  assert.equal(result.leaseToken, "lease-token");
});

Deno.test("Azure translation store pages all due rows before prioritizing", async () => {
  const cold = record({
    locale: "de",
    projectId: "cold",
    accessCount: 1,
  });
  const hot = record({
    locale: "zh-CN",
    projectId: "hot",
    accessCount: 500,
  });
  let requests = 0;
  const store = new AzureTableTranslationStore(
    tableUrl,
    (input) => {
      requests++;
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.pathname, "/translations()");
      if (!url.searchParams.has("NextPartitionKey")) {
        return Promise.resolve(Response.json(
          { value: [toAzureEntity(cold)] },
          {
            headers: {
              "x-ms-continuation-NextPartitionKey": "next-locale",
              "x-ms-continuation-NextRowKey": "next-row",
            },
          },
        ));
      }
      assert.equal(url.searchParams.get("NextPartitionKey"), "next-locale");
      return Promise.resolve(Response.json({
        value: [toAzureEntity(hot)],
      }));
    },
  );

  const due = await store.listDue(
    new Date("2099-01-01T00:00:00.000Z"),
    1,
  );
  assert.equal(requests, 2);
  assert.equal(due[0].projectId, "hot");
});

Deno.test("Azure translation store stages content with edge sync state", async () => {
  const current = record({
    status: "processing",
    nextProcessAt: "2026-01-02T00:00:00.000Z",
    leaseToken: "lease-token",
    leaseExpiresAt: "2099-01-01T00:20:00.000Z",
  });
  let mergedBody: Record<string, unknown> | undefined;
  const store = new AzureTableTranslationStore(
    tableUrl,
    async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return Response.json(toAzureEntity(current), {
          headers: { etag: current.etag! },
        });
      }
      mergedBody = await request.json();
      return new Response(null, { status: 204 });
    },
  );
  await store.stageEdgeSync(
    current,
    {
      content: "translation",
      contentType: "text/markdown",
      sourceHash: "source-hash",
      nextProcessAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  );
  assert.equal(
    mergedBody?.NextProcessAt,
    "2026-01-02T00:00:00.000Z",
  );
  assert.equal(mergedBody?.Content, "translation");
  assert.equal(mergedBody?.EdgeSyncPending, true);
  assert.equal(
    mergedBody?.EdgeSyncResumeAt,
    "2026-01-02T00:00:00.000Z",
  );
});

Deno.test("Azure translation store prioritizes edge retries over hot refreshes", async () => {
  const hot = record({ projectId: "hot", accessCount: 500 });
  const edgeRetry = record({
    projectId: "edge-retry",
    accessCount: 1,
    edgeSyncPending: true,
  });
  const store = new AzureTableTranslationStore(
    tableUrl,
    () =>
      Promise.resolve(Response.json({
        value: [toAzureEntity(hot), toAzureEntity(edgeRetry)],
      })),
  );
  const due = await store.listDue(
    new Date("2099-01-01T00:00:00.000Z"),
    1,
  );
  assert.equal(due[0].projectId, "edge-retry");
});

function toAzureEntity(value: TranslationRecord) {
  return {
    PartitionKey: value.locale,
    RowKey: `${value.type}:${value.projectId}`,
    Locale: value.locale,
    Type: value.type,
    ProjectId: value.projectId,
    Content: value.content,
    ContentType: value.contentType,
    SourceHash: value.sourceHash,
    Status: value.status,
    AccessCount: value.accessCount,
    FirstAccessedAt: value.firstAccessedAt,
    LastAccessedAt: value.lastAccessedAt,
    NextProcessAt: value.nextProcessAt,
    UpdatedAt: value.updatedAt,
    LeaseToken: value.leaseToken,
    LeaseExpiresAt: value.leaseExpiresAt,
    EdgeSyncPending: value.edgeSyncPending,
    EdgeSyncResumeAt: value.edgeSyncResumeAt,
  };
}
