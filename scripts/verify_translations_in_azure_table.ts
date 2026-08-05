// Compares legacy Mongo translation/request keys with the Azure Table target.
// It never prints translation content or credentials.
//
// Run:
//   deno run --allow-net --allow-env --env scripts/verify_translations_in_azure_table.ts
//
// Required:
//   MONGO_CONNECION_STRING
//   AZURE_TRANSLATION_TABLE_URL
//
// Optional:
//   MONGODB_NAME                      default: coturn
//   TRANSLATION_MIGRATION_BATCH_SIZE  default: 500
//   TRANSLATION_MIGRATION_LOCALES     comma-separated locale allowlist

import { MongoClient } from "mongo";
import {
  AzureTableMigrationClient,
  entityLookupKey,
  type LegacyTranslationDocument,
  type LegacyTranslationRequest,
  normalizeLocale,
  requestLookupKey,
  requestMetadata,
  safeProjectId,
  translationType,
} from "./lib/translation_azure_migration.ts";

interface ExpectedRecord {
  locale: string;
  type: "modrinth" | "curseforge";
  projectId: string;
  needsContent: boolean;
  minimumAccessCount: number;
  sourceHash?: string;
  pendingSourceHash?: string;
}

const mongoUrl = requiredEnv("MONGO_CONNECION_STRING");
const tableUrl = requiredEnv("AZURE_TRANSLATION_TABLE_URL");
const databaseName = Deno.env.get("MONGODB_NAME") || "coturn";
const batchSize = boundedInteger(
  Deno.env.get("TRANSLATION_MIGRATION_BATCH_SIZE"),
  500,
  1,
  1_000,
);
const localeAllowlist = parseLocaleAllowlist(
  Deno.env.get("TRANSLATION_MIGRATION_LOCALES"),
);
const sourceFallbackDate = new Date("2000-01-01T00:00:00.000Z");
const verificationStartedAt = new Date();
const mongo = new MongoClient();
const azure = new AzureTableMigrationClient(tableUrl);

await mongo.connect(mongoUrl);
try {
  const database = mongo.database(databaseName);
  const requests = new Map<
    string,
    NonNullable<ReturnType<typeof requestMetadata>>
  >();
  const typesByProject = new Map<string, Set<"modrinth" | "curseforge">>();
  const requestCollection = database.collection<LegacyTranslationRequest>(
    "translation_requests",
  );
  await scanCollection<LegacyTranslationRequest>(
    requestCollection,
    batchSize,
    (request) => {
      const locale = typeof request.lang === "string"
        ? normalizeLocale(request.lang)
        : undefined;
      const projectId = safeProjectId(request.projectId);
      const metadata = requestMetadata(request, sourceFallbackDate);
      if (!locale || !projectId || !metadata) return;
      if (localeAllowlist && !localeAllowlist.has(locale)) return;
      requests.set(
        entityLookupKey(locale, metadata.type, projectId),
        metadata,
      );
      const lookup = requestLookupKey(locale, projectId);
      const types = typesByProject.get(lookup) ?? new Set();
      types.add(metadata.type);
      typesByProject.set(lookup, types);
    },
  );

  const expected = new Map<string, ExpectedRecord>();
  const names = (await database.listCollectionNames())
    .filter((name) => name.endsWith("_translation"))
    .sort();
  let skippedLegacy = 0;
  for (const name of names) {
    const locale = normalizeLocale(name.slice(0, -"_translation".length));
    if (!locale || localeAllowlist && !localeAllowlist.has(locale)) continue;
    await scanCollection<LegacyTranslationDocument>(
      database.collection<LegacyTranslationDocument>(name),
      batchSize,
      (document) => {
        const projectId = safeProjectId(document._id);
        if (!projectId || typeof document.content !== "string") {
          skippedLegacy++;
          return;
        }
        const inferred = typesByProject.get(
          requestLookupKey(locale, projectId),
        );
        const type = translationType(document.type) ??
          (inferred?.size === 1 ? [...inferred][0] : undefined);
        if (!type) {
          skippedLegacy++;
          return;
        }
        const metadata = requests.get(
          entityLookupKey(locale, type, projectId),
        );
        expected.set(entityLookupKey(locale, type, projectId), {
          locale,
          type,
          projectId,
          needsContent: true,
          minimumAccessCount: metadata?.accessCount ?? 1,
          sourceHash: typeof document.bodyHash === "string"
            ? document.bodyHash
            : metadata?.sourceHash,
          pendingSourceHash: metadata?.status !== "succeeded"
            ? metadata?.sourceHash
            : undefined,
        });
      },
    );
  }

  for (const [key, metadata] of requests) {
    if (expected.has(key)) continue;
    const [locale, type, projectId] = key.split("\0") as [
      string,
      "modrinth" | "curseforge",
      string,
    ];
    expected.set(key, {
      locale,
      type,
      projectId,
      needsContent: false,
      minimumAccessCount: metadata.accessCount,
      sourceHash: metadata.sourceHash,
      pendingSourceHash: metadata.status !== "succeeded"
        ? metadata.sourceHash
        : undefined,
    });
  }

  const actual = new Map(
    (await azure.listAll()).map((entity) => [
      entityLookupKey(entity.Locale, entity.Type, entity.ProjectId),
      entity,
    ]),
  );
  let missing = 0;
  let missingContent = 0;
  let accessShortfall = 0;
  let sourceChanged = 0;
  let pendingSourceNotScheduled = 0;
  const examples: string[] = [];

  for (const [key, wanted] of expected) {
    const found = actual.get(key);
    if (!found) {
      missing++;
      remember(examples, `missing ${displayKey(wanted)}`);
      continue;
    }
    if (wanted.needsContent && !found.Content) {
      missingContent++;
      remember(examples, `missing-content ${displayKey(wanted)}`);
    }
    if (Number(found.AccessCount ?? 0) < wanted.minimumAccessCount) {
      accessShortfall++;
      remember(examples, `access-shortfall ${displayKey(wanted)}`);
    }
    if (
      wanted.sourceHash && found.SourceHash &&
      wanted.sourceHash !== found.SourceHash
    ) {
      sourceChanged++;
    }
    if (
      wanted.pendingSourceHash &&
      found.SourceHash !== wanted.pendingSourceHash &&
      (found.Status !== "pending" ||
        Date.parse(found.NextProcessAt) > verificationStartedAt.getTime())
    ) {
      pendingSourceNotScheduled++;
      remember(examples, `pending-source-not-scheduled ${displayKey(wanted)}`);
    }
  }

  const unexpected = [...actual.keys()].filter((key) => !expected.has(key))
    .length;
  console.log({
    expected: expected.size,
    azure: actual.size,
    missing,
    missingContent,
    accessShortfall,
    sourceChangedSinceMongoSnapshot: sourceChanged,
    pendingSourceNotScheduled,
    azureOnly: unexpected,
    skippedAmbiguousOrInvalidLegacyRecords: skippedLegacy,
  });
  for (const example of examples) console.log(`  ${example}`);

  if (
    missing || missingContent || accessShortfall || pendingSourceNotScheduled
  ) {
    Deno.exitCode = 1;
  }
} finally {
  await mongo.close();
}

async function scanCollection<T extends { _id: unknown }>(
  collection: {
    find(
      filter: Record<string, unknown>,
      options?: unknown,
    ): unknown;
  },
  limit: number,
  visit: (document: T) => void,
) {
  let lastId: string | undefined;
  while (true) {
    const cursor = collection.find(
      lastId ? { _id: { $gt: lastId } } : {},
      { batchSize: limit },
    ) as {
      sort(value: Record<string, number>): {
        limit(value: number): { toArray(): Promise<T[]> };
      };
    };
    const page = await cursor.sort({ _id: 1 }).limit(limit).toArray();
    if (page.length === 0) return;
    for (const document of page) visit(document);
    lastId = String(page[page.length - 1]._id);
    if (page.length < limit) return;
  }
}

function displayKey(record: ExpectedRecord) {
  return `${record.locale}/${record.type}/${record.projectId}`;
}

function remember(examples: string[], value: string) {
  if (examples.length < 100) examples.push(value);
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function parseLocaleAllowlist(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const locales = value.split(",").map((locale) =>
    normalizeLocale(locale.trim())
  )
    .filter((locale): locale is string => Boolean(locale));
  if (locales.length === 0) {
    throw new Error("TRANSLATION_MIGRATION_LOCALES has no valid locales");
  }
  return new Set(locales);
}
