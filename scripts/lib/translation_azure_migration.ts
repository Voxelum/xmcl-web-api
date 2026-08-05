export type LegacyTranslationType = "modrinth" | "curseforge";

export interface LegacyTranslationDocument {
  _id: unknown;
  bodyHash?: unknown;
  content?: unknown;
  contentType?: unknown;
  type?: unknown;
}

export interface LegacyTranslationRequest {
  _id: unknown;
  lang?: unknown;
  type?: unknown;
  projectId?: unknown;
  bodyHash?: unknown;
  contentType?: unknown;
  status?: unknown;
  requestCount?: unknown;
  createdAt?: unknown;
  firstRequestedAt?: unknown;
  lastRequestedAt?: unknown;
  updatedAt?: unknown;
  notBefore?: unknown;
}

export interface AzureTranslationEntity {
  PartitionKey: string;
  RowKey: string;
  Locale: string;
  Type: LegacyTranslationType;
  ProjectId: string;
  Content?: string;
  ContentType: "text/html" | "text/markdown";
  SourceHash?: string;
  Status: "pending" | "processing" | "ready" | "failed";
  AccessCount: number;
  FirstAccessedAt: string;
  LastAccessedAt: string;
  NextProcessAt: string;
  "NextProcessAt@odata.type": "Edm.DateTime";
  UpdatedAt: string;
  LastError: string;
  LeaseToken: string;
  LeaseExpiresAt: string;
  MigratedAccessCount?: number;
  "odata.etag"?: string;
}

export interface RequestMetadata {
  type: LegacyTranslationType;
  sourceHash?: string;
  contentType: "text/html" | "text/markdown";
  accessCount: number;
  firstAccessedAt: string;
  lastAccessedAt: string;
  updatedAt: string;
  notBefore?: string;
  status: "pending" | "succeeded" | "failed";
}

const TABLE_API_VERSION = "2019-02-02";
const MAX_STRING_BYTES = 64 * 1024;
const STABLE_FALLBACK_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const MAX_IMPORT_RETRIES = 5;

export function normalizeLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function translationType(
  value: unknown,
): LegacyTranslationType | undefined {
  return value === "modrinth" || value === "curseforge" ? value : undefined;
}

export function requestLookupKey(locale: string, projectId: string) {
  return `${locale}\0${projectId}`;
}

export function entityLookupKey(
  locale: string,
  type: LegacyTranslationType,
  projectId: string,
) {
  return `${locale}\0${type}\0${projectId}`;
}

export function requestMetadata(
  request: LegacyTranslationRequest,
  fallbackNow: Date,
): RequestMetadata | undefined {
  const type = translationType(request.type);
  if (!type) return undefined;
  const first = dateIso(
    request.firstRequestedAt ?? request.createdAt,
    fallbackNow,
  );
  const last = dateIso(
    request.lastRequestedAt ?? request.updatedAt,
    fallbackNow,
  );
  return {
    type,
    sourceHash: text(request.bodyHash),
    contentType: contentType(request.contentType, type),
    accessCount: positiveInteger(request.requestCount, 1),
    firstAccessedAt: first,
    lastAccessedAt: last,
    updatedAt: dateIso(request.updatedAt, fallbackNow),
    notBefore: optionalDateIso(request.notBefore),
    status: request.status === "succeeded"
      ? "succeeded"
      : request.status === "failed"
      ? "failed"
      : "pending",
  };
}

export function translationEntity(
  locale: string,
  document: LegacyTranslationDocument,
  metadata: RequestMetadata | undefined,
  inferredType: LegacyTranslationType | undefined,
  migrationStartedAt: Date,
): AzureTranslationEntity | undefined {
  const projectId = safeProjectId(document._id);
  const type = translationType(document.type) ?? inferredType;
  const content = text(document.content);
  if (!projectId || !type || !content) return undefined;
  // Azure Table Edm.String is UTF-16 and limited to 64 KiB.
  if (content.length * 2 > MAX_STRING_BYTES) {
    return undefined;
  }
  const first = metadata?.firstAccessedAt ?? STABLE_FALLBACK_TIMESTAMP;
  const last = metadata?.lastAccessedAt ?? first;
  const sourceHash = text(document.bodyHash);
  const needsRefresh = Boolean(
    metadata &&
      (metadata.status !== "succeeded" ||
        metadata.sourceHash && metadata.sourceHash !== sourceHash),
  );
  const nextProcessAt = needsRefresh
    ? metadata?.notBefore &&
        Date.parse(metadata.notBefore) > migrationStartedAt.getTime()
      ? metadata.notBefore
      : migrationStartedAt.toISOString()
    : deterministicRefreshAt(
      locale,
      type,
      projectId,
      migrationStartedAt,
    );
  return {
    PartitionKey: locale,
    RowKey: `${type}:${projectId}`,
    Locale: locale,
    Type: type,
    ProjectId: projectId,
    Content: content,
    ContentType: contentType(document.contentType, type),
    SourceHash: sourceHash,
    Status: needsRefresh ? "pending" : "ready",
    AccessCount: metadata?.accessCount ?? 1,
    MigratedAccessCount: metadata?.accessCount ?? 1,
    FirstAccessedAt: first,
    LastAccessedAt: last,
    NextProcessAt: nextProcessAt,
    "NextProcessAt@odata.type": "Edm.DateTime",
    UpdatedAt: metadata?.updatedAt ?? STABLE_FALLBACK_TIMESTAMP,
    LastError: "",
    LeaseToken: "",
    LeaseExpiresAt: "",
  };
}

export function pendingEntity(
  locale: string,
  projectId: string,
  metadata: RequestMetadata,
  migrationStartedAt: Date,
): AzureTranslationEntity {
  const nextProcessAt = metadata.notBefore &&
      Date.parse(metadata.notBefore) > migrationStartedAt.getTime()
    ? metadata.notBefore
    : migrationStartedAt.toISOString();
  return {
    PartitionKey: locale,
    RowKey: `${metadata.type}:${projectId}`,
    Locale: locale,
    Type: metadata.type,
    ProjectId: projectId,
    ContentType: metadata.contentType,
    SourceHash: metadata.sourceHash,
    Status: "pending",
    AccessCount: metadata.accessCount,
    MigratedAccessCount: metadata.accessCount,
    FirstAccessedAt: metadata.firstAccessedAt,
    LastAccessedAt: metadata.lastAccessedAt,
    NextProcessAt: nextProcessAt,
    "NextProcessAt@odata.type": "Edm.DateTime",
    UpdatedAt: metadata.updatedAt,
    LastError: "",
    LeaseToken: "",
    LeaseExpiresAt: "",
  };
}

export function mergeImportedEntity(
  existing: AzureTranslationEntity,
  imported: AzureTranslationEntity,
  overwriteContent: boolean,
): AzureTranslationEntity {
  const useImportedContent = Boolean(imported.Content) &&
    (overwriteContent || !existing.Content);
  const pendingSourceNeedsProcessing = imported.Content
    ? existing.SourceHash === imported.SourceHash
    : !imported.SourceHash || existing.SourceHash !== imported.SourceHash;
  const applyPendingState = imported.Status === "pending" &&
    existing.Status !== "processing" &&
    (!existing.Content || pendingSourceNeedsProcessing);
  const previousMigratedCount = positiveInteger(
    existing.MigratedAccessCount,
    0,
  );
  const importedCount = positiveInteger(
    imported.MigratedAccessCount ?? imported.AccessCount,
    0,
  );
  const liveAccessCount = Math.max(
    0,
    positiveInteger(existing.AccessCount, 0) - previousMigratedCount,
  );
  const merged = {
    ...existing,
    "NextProcessAt@odata.type": "Edm.DateTime" as const,
    AccessCount: liveAccessCount + importedCount,
    MigratedAccessCount: importedCount,
    FirstAccessedAt: earlierIso(
      existing.FirstAccessedAt,
      imported.FirstAccessedAt,
    ),
    LastAccessedAt: laterIso(
      existing.LastAccessedAt,
      imported.LastAccessedAt,
    ),
    UpdatedAt: laterIso(existing.UpdatedAt, imported.UpdatedAt),
  };
  if (useImportedContent) {
    return {
      ...merged,
      Content: imported.Content,
      ContentType: imported.ContentType,
      SourceHash: imported.SourceHash,
      Status: imported.Status,
      NextProcessAt: imported.NextProcessAt,
      "NextProcessAt@odata.type": "Edm.DateTime",
      LastError: "",
      LeaseToken: "",
      LeaseExpiresAt: "",
    };
  }
  if (!existing.Content && !imported.Content) {
    merged.NextProcessAt = earlierIso(
      existing.NextProcessAt,
      imported.NextProcessAt,
    );
  }
  if (applyPendingState) {
    merged.Status = "pending";
    merged.NextProcessAt = earlierIso(
      existing.NextProcessAt,
      imported.NextProcessAt,
    );
  }
  return merged;
}

export class AzureTableMigrationClient {
  private readonly tableUrl: URL;

  constructor(
    tableUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.tableUrl = validateTableUrl(tableUrl);
  }

  async importEntity(
    imported: AzureTranslationEntity,
    options: { apply: boolean; overwriteContent: boolean },
  ): Promise<"inserted" | "merged" | "unchanged" | "planned"> {
    for (let attempt = 0; attempt < MAX_IMPORT_RETRIES; attempt++) {
      const existing = await this.get(imported.PartitionKey, imported.RowKey);
      if (!existing) {
        if (!options.apply) return "planned";
        const response = await this.fetcher(this.tableUrl, {
          method: "POST",
          headers: tableHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(imported),
        });
        if (response.ok) {
          await response.body?.cancel().catch(() => {});
          return "inserted";
        }
        if (response.status === 409) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        throw await tableError("insert", response);
      }
      const merged = mergeImportedEntity(
        existing,
        imported,
        options.overwriteContent,
      );
      if (equivalentEntity(existing, merged)) return "unchanged";
      if (!options.apply) return "planned";
      const response = await this.fetcher(
        this.entityUrl(imported.PartitionKey, imported.RowKey),
        {
          method: "MERGE",
          headers: tableHeaders({
            "content-type": "application/json",
            "if-match": existing["odata.etag"] || "*",
          }),
          body: JSON.stringify(merged),
        },
      );
      if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return "merged";
      }
      if (response.status === 404 || response.status === 412) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      throw await tableError("merge", response);
    }
    throw new Error("Azure Table import conflicted repeatedly");
  }

  async get(
    partitionKey: string,
    rowKey: string,
  ): Promise<AzureTranslationEntity | undefined> {
    const response = await this.fetcher(this.entityUrl(partitionKey, rowKey), {
      headers: tableHeaders(),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) throw await tableError("read", response);
    const entity = await response.json() as AzureTranslationEntity;
    entity["odata.etag"] = response.headers.get("etag") ??
      entity["odata.etag"];
    return entity;
  }

  async listAll(): Promise<AzureTranslationEntity[]> {
    const first = new URL(this.tableUrl);
    first.pathname = `${first.pathname.replace(/\/+$/, "")}()`;
    first.searchParams.set("$top", "1000");
    const result: AzureTranslationEntity[] = [];
    let page: URL | undefined = first;
    while (page) {
      const response = await this.fetcher(page, { headers: tableHeaders() });
      if (!response.ok) throw await tableError("list", response);
      const body = await response.json() as {
        value?: AzureTranslationEntity[];
      };
      result.push(...(body.value ?? []));
      page = continuationUrl(first, response.headers);
    }
    return result;
  }

  private entityUrl(partitionKey: string, rowKey: string) {
    const url = new URL(this.tableUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}(PartitionKey='${
      odataString(partitionKey)
    }',RowKey='${odataString(rowKey)}')`;
    return url;
  }
}

export function safeProjectId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function contentType(
  value: unknown,
  type: LegacyTranslationType,
): "text/html" | "text/markdown" {
  if (value === "text/html" || value === "text/markdown") return value;
  return type === "curseforge" ? "text/html" : "text/markdown";
}

function optionalDateIso(value: unknown): string | undefined {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
    ? Date.parse(value)
    : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function dateIso(value: unknown, fallback: Date) {
  return optionalDateIso(value) ?? fallback.toISOString();
}

function deterministicRefreshAt(
  locale: string,
  type: LegacyTranslationType,
  projectId: string,
  start: Date,
) {
  let hash = 2166136261;
  for (const character of `${locale}:${type}:${projectId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const offset = (hash >>> 0) % (24 * 60 * 60_000);
  return new Date(start.getTime() + offset).toISOString();
}

function earlierIso(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function equivalentEntity(
  left: AzureTranslationEntity,
  right: AzureTranslationEntity,
) {
  const comparable = (entity: AzureTranslationEntity) => {
    const { ["odata.etag"]: _etag, ...value } = entity;
    return JSON.stringify(value);
  };
  return comparable(left) === comparable(right);
}

function validateTableUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || !url.hostname || url.username ||
    url.password || !url.pathname || url.pathname === "/"
  ) {
    throw new Error("AZURE_TRANSLATION_TABLE_URL is invalid");
  }
  return url;
}

function tableHeaders(extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("accept", "application/json;odata=nometadata");
  headers.set("dataserviceversion", "3.0");
  headers.set("maxdataserviceversion", "3.0");
  headers.set("x-ms-version", TABLE_API_VERSION);
  return headers;
}

function odataString(value: string) {
  return value.replaceAll("'", "''");
}

function continuationUrl(
  query: URL,
  headers: Headers,
): URL | undefined {
  const nextPartitionKey = headers.get("x-ms-continuation-nextpartitionkey");
  const nextRowKey = headers.get("x-ms-continuation-nextrowkey");
  if (!nextPartitionKey && !nextRowKey) return undefined;
  const next = new URL(query);
  next.searchParams.delete("NextPartitionKey");
  next.searchParams.delete("NextRowKey");
  if (nextPartitionKey) {
    next.searchParams.set("NextPartitionKey", nextPartitionKey);
  }
  if (nextRowKey) next.searchParams.set("NextRowKey", nextRowKey);
  return next;
}

async function tableError(operation: string, response: Response) {
  const body = await response.text().catch(() => "");
  return new Error(
    `Azure Table ${operation} failed with HTTP ${response.status}${
      body ? `: ${body.slice(0, 300)}` : ""
    }`,
  );
}
