// Idempotently migrates legacy Mongo translation caches and request demand to
// the Azure Table schema used by src/lib/translationStore.ts.
//
// Dry-run is the default. Set TRANSLATION_MIGRATION_APPLY=1 to write.
//
// Required:
//   MONGO_CONNECION_STRING
//   AZURE_TRANSLATION_TABLE_URL
//
// Optional:
//   MONGODB_NAME                         default: coturn
//   TRANSLATION_MIGRATION_APPLY          default: false
//   TRANSLATION_MIGRATION_OVERWRITE      replace existing Azure content
//   TRANSLATION_MIGRATION_BATCH_SIZE     default: 200
//   TRANSLATION_MIGRATION_CONCURRENCY    default: 8
//   TRANSLATION_MIGRATION_LOCALES        comma-separated locale allowlist
//   TRANSLATION_MIGRATION_STATE_FILE     default: .translation-azure-migration-state.json
//   TRANSLATION_MIGRATION_RESET_STATE    discard the saved checkpoint

import { MongoClient } from "mongo";
import {
  AzureTableMigrationClient,
  entityLookupKey,
  type LegacyTranslationDocument,
  type LegacyTranslationRequest,
  normalizeLocale,
  pendingEntity,
  requestLookupKey,
  requestMetadata,
  safeProjectId,
  translationEntity,
  translationType,
} from "./lib/translation_azure_migration.ts";

interface MigrationState {
  translations: Record<string, { lastId?: string; done?: boolean }>;
  pendingLastKey?: string;
  pendingDone?: boolean;
}

const mongoUrl = requiredEnv("MONGO_CONNECION_STRING");
const tableUrl = requiredEnv("AZURE_TRANSLATION_TABLE_URL");
const databaseName = Deno.env.get("MONGODB_NAME") || "coturn";
const apply = booleanEnv("TRANSLATION_MIGRATION_APPLY");
const overwriteContent = booleanEnv("TRANSLATION_MIGRATION_OVERWRITE");
const resetState = booleanEnv("TRANSLATION_MIGRATION_RESET_STATE");
const batchSize = boundedInteger(
  Deno.env.get("TRANSLATION_MIGRATION_BATCH_SIZE"),
  200,
  1,
  1_000,
);
const concurrency = boundedInteger(
  Deno.env.get("TRANSLATION_MIGRATION_CONCURRENCY"),
  8,
  1,
  32,
);
const stateFile = Deno.env.get("TRANSLATION_MIGRATION_STATE_FILE") ||
  ".translation-azure-migration-state.json";
const localeAllowlist = parseLocaleAllowlist(
  Deno.env.get("TRANSLATION_MIGRATION_LOCALES"),
);
const startedAt = new Date();
const sourceFallbackDate = new Date("2000-01-01T00:00:00.000Z");
const state = resetState ? emptyState() : await loadState(stateFile);
const azure = new AzureTableMigrationClient(tableUrl);
const mongo = new MongoClient();

console.log(
  `Translation migration mode=${apply ? "APPLY" : "DRY-RUN"} ` +
    `database=${databaseName} batch=${batchSize} concurrency=${concurrency}`,
);
if (!apply) {
  console.log(
    "No Azure entities or migration checkpoints will be written in dry-run mode.",
  );
}

await mongo.connect(mongoUrl);
try {
  const database = mongo.database(databaseName);
  const requestCollection = database.collection<LegacyTranslationRequest>(
    "translation_requests",
  );
  const requestByEntity = new Map<
    string,
    ReturnType<typeof requestMetadata>
  >();
  const typesByProject = new Map<string, Set<"modrinth" | "curseforge">>();

  console.log("Loading translation request metadata...");
  let requestLastId: string | undefined;
  let requestCount = 0;
  while (true) {
    const page = await fetchPage<LegacyTranslationRequest>(
      requestCollection,
      requestLastId,
      batchSize,
    );
    if (page.length === 0) break;
    for (const request of page) {
      const locale = typeof request.lang === "string"
        ? normalizeLocale(request.lang)
        : undefined;
      const projectId = safeProjectId(request.projectId);
      const metadata = requestMetadata(request, sourceFallbackDate);
      if (!locale || !projectId || !metadata) continue;
      if (localeAllowlist && !localeAllowlist.has(locale)) continue;
      requestByEntity.set(
        entityLookupKey(locale, metadata.type, projectId),
        metadata,
      );
      const projectKey = requestLookupKey(locale, projectId);
      const types = typesByProject.get(projectKey) ?? new Set();
      types.add(metadata.type);
      typesByProject.set(projectKey, types);
      requestCount++;
    }
    requestLastId = String(page[page.length - 1]._id);
    if (page.length < batchSize) break;
  }
  console.log(`Loaded ${requestCount} valid request record(s).`);

  const collectionNames = (await database.listCollectionNames())
    .filter((name) => name.endsWith("_translation"))
    .sort();
  const counters = newCounters();

  for (const collectionName of collectionNames) {
    const rawLocale = collectionName.slice(0, -"_translation".length);
    const locale = normalizeLocale(rawLocale);
    if (!locale) {
      console.warn(`Skipping invalid locale collection ${collectionName}`);
      counters.skipped++;
      continue;
    }
    if (localeAllowlist && !localeAllowlist.has(locale)) continue;
    const checkpoint = state.translations[collectionName] ?? {};
    if (checkpoint.done) {
      console.log(`[${locale}] already completed; reset state to rescan`);
      continue;
    }

    const collection = database.collection<LegacyTranslationDocument>(
      collectionName,
    );
    let lastId = checkpoint.lastId;
    while (true) {
      const page = await fetchPage<LegacyTranslationDocument>(
        collection,
        lastId,
        batchSize,
      );
      if (page.length === 0) {
        state.translations[collectionName] = { lastId, done: true };
        if (apply) await saveState(stateFile, state);
        break;
      }

      const entities = page.flatMap((document) => {
        const projectId = safeProjectId(document._id);
        if (!projectId) {
          counters.skipped++;
          return [];
        }
        const explicitType = translationType(document.type);
        const inferredTypes = typesByProject.get(
          requestLookupKey(locale, projectId),
        );
        const inferredType = inferredTypes?.size === 1
          ? [...inferredTypes][0]
          : undefined;
        const type = explicitType ?? inferredType;
        const metadata = type
          ? requestByEntity.get(entityLookupKey(locale, type, projectId))
          : undefined;
        const entity = translationEntity(
          locale,
          document,
          metadata,
          inferredType,
          startedAt,
        );
        if (!entity) {
          console.warn(
            `[${locale}] skipping translation ${JSON.stringify(projectId)}: ` +
              "missing/ambiguous type, content, or oversized content",
          );
          counters.skipped++;
          return [];
        }
        return [entity];
      });
      const outcomes = await mapConcurrent(
        entities,
        concurrency,
        (entity) =>
          azure.importEntity(entity, {
            apply,
            overwriteContent,
          }),
      );
      addOutcomes(counters, outcomes);
      lastId = String(page[page.length - 1]._id);
      state.translations[collectionName] = { lastId };
      if (apply) await saveState(stateFile, state);
      console.log(
        `[${locale}] scanned through ${JSON.stringify(lastId)}; ` +
          summary(counters),
      );
      if (page.length < batchSize) {
        state.translations[collectionName] = { lastId, done: true };
        if (apply) await saveState(stateFile, state);
        break;
      }
    }
  }

  const pendingEntries = [...requestByEntity.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  if (!state.pendingDone) {
    for (let offset = 0; offset < pendingEntries.length; offset += batchSize) {
      const page = pendingEntries.slice(offset, offset + batchSize)
        .filter(([key]) =>
          !state.pendingLastKey || key.localeCompare(state.pendingLastKey) > 0
        );
      if (page.length === 0) continue;
      const entities = page.flatMap(([key, metadata]) => {
        if (!metadata) return [];
        const [locale, type, projectId] = key.split("\0") as [
          string,
          "modrinth" | "curseforge",
          string,
        ];
        return [
          pendingEntity(locale, projectId, { ...metadata, type }, startedAt),
        ];
      });
      const outcomes = await mapConcurrent(
        entities,
        concurrency,
        (entity) =>
          azure.importEntity(entity, {
            apply,
            overwriteContent: false,
          }),
      );
      addOutcomes(counters, outcomes);
      state.pendingLastKey = page[page.length - 1][0];
      if (apply) await saveState(stateFile, state);
    }
    state.pendingDone = true;
    if (apply) await saveState(stateFile, state);
  }

  console.log(`Migration complete: ${summary(counters)}.`);
  if (!apply) {
    console.log(
      "Re-run with TRANSLATION_MIGRATION_APPLY=1 to apply this plan.",
    );
  }
} finally {
  await mongo.close();
}

function emptyState(): MigrationState {
  return { translations: {} };
}

async function loadState(path: string): Promise<MigrationState> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as MigrationState;
    return {
      translations: parsed.translations ?? {},
      pendingLastKey: parsed.pendingLastKey,
      pendingDone: parsed.pendingDone,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyState();
    throw error;
  }
}

async function saveState(path: string, state: MigrationState) {
  await Deno.writeTextFile(path, JSON.stringify(state, null, 2) + "\n");
}

async function fetchPage<T extends { _id: unknown }>(
  collection: {
    find(
      filter: Record<string, unknown>,
      options?: unknown,
    ): {
      sort(value: Record<string, number>): unknown;
    };
  },
  lastId: string | undefined,
  limit: number,
): Promise<T[]> {
  const cursor = collection.find(
    lastId ? { _id: { $gt: lastId } } : {},
    { batchSize: limit },
  ) as {
    sort(value: Record<string, number>): {
      limit(value: number): { toArray(): Promise<T[]> };
    };
  };
  return await cursor.sort({ _id: 1 }).limit(limit).toArray();
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await operation(values[index]);
      }
    }),
  );
  return output;
}

function newCounters() {
  return {
    inserted: 0,
    merged: 0,
    unchanged: 0,
    planned: 0,
    skipped: 0,
  };
}

function addOutcomes(
  counters: ReturnType<typeof newCounters>,
  outcomes: Array<"inserted" | "merged" | "unchanged" | "planned">,
) {
  for (const outcome of outcomes) counters[outcome]++;
}

function summary(counters: ReturnType<typeof newCounters>) {
  return Object.entries(counters)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function booleanEnv(name: string) {
  return /^(1|true|yes)$/i.test(Deno.env.get(name) ?? "");
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
