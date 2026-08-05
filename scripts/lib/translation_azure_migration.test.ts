import assert from "node:assert/strict";
import {
  AzureTableMigrationClient,
  type AzureTranslationEntity,
  mergeImportedEntity,
  pendingEntity,
  requestMetadata,
  translationEntity,
} from "./translation_azure_migration.ts";

const now = new Date("2026-08-05T00:00:00.000Z");

Deno.test("migration maps legacy translation and request demand", () => {
  const metadata = requestMetadata({
    _id: "ja:modrinth:project",
    type: "modrinth",
    status: "succeeded",
    requestCount: 42,
    firstRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastRequestedAt: new Date("2026-08-01T00:00:00.000Z"),
  }, now);
  assert.ok(metadata);
  const entity = translationEntity(
    "ja",
    {
      _id: "project",
      content: "translated",
      bodyHash: "source-hash",
    },
    metadata,
    "modrinth",
    now,
  );
  assert.ok(entity);
  assert.equal(entity.PartitionKey, "ja");
  assert.equal(entity.RowKey, "modrinth:project");
  assert.equal(entity.AccessCount, 42);
  assert.equal(entity.Status, "ready");
  assert.equal(entity.SourceHash, "source-hash");
  assert.ok(
    Date.parse(entity.NextProcessAt) >= now.getTime() &&
      Date.parse(entity.NextProcessAt) < now.getTime() + 86_400_000,
  );
});

Deno.test("migration adds content to pending entities without losing demand", () => {
  const metadata = requestMetadata({
    _id: "ja:modrinth:project",
    type: "modrinth",
    requestCount: 10,
  }, now)!;
  const existing = pendingEntity("ja", "project", metadata, now);
  existing.AccessCount = 50;
  const imported = translationEntity(
    "ja",
    {
      _id: "project",
      type: "modrinth",
      content: "translated",
    },
    metadata,
    "modrinth",
    now,
  )!;

  const merged = mergeImportedEntity(existing, imported, false);
  assert.equal(merged.Content, "translated");
  assert.equal(merged.Status, "pending");
  assert.equal(merged.AccessCount, 50);
});

Deno.test("migration keeps stale content but schedules a newer source immediately", () => {
  const metadata = requestMetadata({
    _id: "ja:modrinth:project",
    type: "modrinth",
    status: "pending",
    bodyHash: "new-source",
    requestCount: 10,
  }, now)!;
  const imported = translationEntity(
    "ja",
    {
      _id: "project",
      type: "modrinth",
      content: "stale translation",
      bodyHash: "old-source",
    },
    metadata,
    "modrinth",
    now,
  )!;
  assert.equal(imported.Content, "stale translation");
  assert.equal(imported.SourceHash, "old-source");
  assert.equal(imported.Status, "pending");
  assert.equal(imported.NextProcessAt, now.toISOString());

  const existing = entity("stale translation", "old-source", 20);
  const merged = mergeImportedEntity(existing, imported, false);
  assert.equal(merged.Status, "pending");
  assert.equal(merged.NextProcessAt, now.toISOString());
  assert.equal(merged["NextProcessAt@odata.type"], "Edm.DateTime");

  const refreshed = entity("fresh translation", "new-source", 20);
  const preserved = mergeImportedEntity(refreshed, imported, false);
  assert.equal(preserved.Status, "ready");
  assert.equal(preserved.SourceHash, "new-source");
});

Deno.test("migration does not overwrite newer Azure content by default", () => {
  const existing = entity("new translation", "new-hash", 100);
  const imported = entity("old translation", "old-hash", 200);
  const merged = mergeImportedEntity(existing, imported, false);
  assert.equal(merged.Content, "new translation");
  assert.equal(merged.SourceHash, "new-hash");
  assert.equal(merged.AccessCount, 300);
  assert.equal(merged.MigratedAccessCount, 200);
});

Deno.test("migration access merge is idempotent across reruns", () => {
  const imported = entity("translation", "hash", 42);
  imported.MigratedAccessCount = 42;
  const first = mergeImportedEntity(
    entity("translation", "hash", 10),
    imported,
    false,
  );
  assert.equal(first.AccessCount, 52);
  const second = mergeImportedEntity(first, imported, false);
  assert.equal(second.AccessCount, 52);
});

Deno.test("request-only newer source marks stale Azure content pending", () => {
  const metadata = requestMetadata({
    _id: "ja:modrinth:project",
    type: "modrinth",
    status: "pending",
    bodyHash: "new-source",
    requestCount: 42,
  }, now)!;
  const imported = pendingEntity("ja", "project", metadata, now);
  const existing = entity("stale translation", "old-source", 10);
  const merged = mergeImportedEntity(existing, imported, false);
  assert.equal(merged.Content, "stale translation");
  assert.equal(merged.SourceHash, "old-source");
  assert.equal(merged.Status, "pending");
  assert.equal(merged.NextProcessAt, now.toISOString());

  const refreshed = entity("fresh translation", "new-source", 10);
  const preserved = mergeImportedEntity(refreshed, imported, false);
  assert.equal(preserved.Status, "ready");
});

Deno.test("migration retries an insert race as a conditional merge", async () => {
  const imported = entity("translation", "hash", 42);
  imported.MigratedAccessCount = 42;
  let request = 0;
  const client = new AzureTableMigrationClient(
    "https://example.table.core.windows.net/translations?sig=test",
    async (_input, init) => {
      request++;
      if (request === 1) return new Response(null, { status: 404 });
      if (request === 2) return new Response(null, { status: 409 });
      if (request === 3) {
        return Response.json(entity("live", "live-hash", 10), {
          headers: { etag: 'W/"live"' },
        });
      }
      assert.equal(init?.method, "MERGE");
      assert.equal(new Headers(init?.headers).get("if-match"), 'W/"live"');
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(
    await client.importEntity(imported, {
      apply: true,
      overwriteContent: false,
    }),
    "merged",
  );
  assert.equal(request, 4);
});

function entity(
  content: string,
  sourceHash: string,
  accessCount: number,
): AzureTranslationEntity {
  return {
    PartitionKey: "ja",
    RowKey: "modrinth:project",
    Locale: "ja",
    Type: "modrinth",
    ProjectId: "project",
    Content: content,
    ContentType: "text/markdown",
    SourceHash: sourceHash,
    Status: "ready",
    AccessCount: accessCount,
    FirstAccessedAt: "2026-01-01T00:00:00.000Z",
    LastAccessedAt: "2026-08-01T00:00:00.000Z",
    NextProcessAt: "2026-08-06T00:00:00.000Z",
    "NextProcessAt@odata.type": "Edm.DateTime",
    UpdatedAt: "2026-08-01T00:00:00.000Z",
    LastError: "",
    LeaseToken: "",
    LeaseExpiresAt: "",
  };
}
