import type { AppConfig } from "./config.ts";

export type TranslationType = "modrinth" | "curseforge";
export type TranslationContentType = "text/markdown" | "text/html";

export interface TranslationKey {
  locale: string;
  type: TranslationType;
  projectId: string;
}

export interface TranslationRecord extends TranslationKey {
  content?: string;
  contentType: TranslationContentType;
  sourceHash?: string;
  status: "pending" | "processing" | "ready" | "failed";
  accessCount: number;
  firstAccessedAt: string;
  lastAccessedAt: string;
  nextProcessAt: string;
  updatedAt: string;
  lastError?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  edgeSyncPending?: boolean;
  edgeSyncResumeAt?: string;
  etag?: string;
}

export interface TranslationStore {
  get(key: TranslationKey): Promise<TranslationRecord | undefined>;
  recordAccess(key: TranslationKey, now?: Date): Promise<TranslationRecord>;
  listDue(now: Date, limit: number): Promise<TranslationRecord[]>;
  claim(
    record: TranslationRecord,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<TranslationRecord | undefined>;
  putTranslation(
    record: TranslationRecord,
    input: {
      content: string;
      contentType: TranslationContentType;
      sourceHash: string;
      nextProcessAt: Date;
    },
  ): Promise<void>;
  complete(
    record: TranslationRecord,
    nextProcessAt: Date,
  ): Promise<void>;
  fail(
    record: TranslationRecord,
    error: string,
    nextProcessAt: Date,
  ): Promise<void>;
  stageEdgeSync(
    record: TranslationRecord,
    input: {
      content: string;
      contentType: TranslationContentType;
      sourceHash: string;
      nextProcessAt: Date;
    },
  ): Promise<void>;
  completeEdgeSync(record: TranslationRecord): Promise<void>;
  retryEdgeSync(record: TranslationRecord, retryAt: Date): Promise<void>;
}

interface AzureTableEntity {
  PartitionKey: string;
  RowKey: string;
  Locale?: string;
  Type?: string;
  ProjectId?: string;
  Content?: string;
  ContentType?: string;
  SourceHash?: string;
  Status?: string;
  AccessCount?: number;
  FirstAccessedAt?: string;
  LastAccessedAt?: string;
  NextProcessAt?: string;
  UpdatedAt?: string;
  LastError?: string;
  LeaseToken?: string;
  LeaseExpiresAt?: string;
  EdgeSyncPending?: boolean;
  EdgeSyncResumeAt?: string;
  "odata.etag"?: string;
}

const TABLE_API_VERSION = "2019-02-02";
const MAX_ACCESS_UPDATE_RETRIES = 4;
const MAX_LEASE_UPDATE_RETRIES = 4;

export class AzureTableTranslationStore implements TranslationStore {
  private readonly tableUrl: URL;

  constructor(
    tableUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.tableUrl = validateTableUrl(tableUrl);
  }

  async get(key: TranslationKey): Promise<TranslationRecord | undefined> {
    const response = await this.fetcher(this.entityUrl(key), {
      headers: tableHeaders(),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) throw await tableError("read", response);
    const entity = await response.json() as AzureTableEntity;
    return fromEntity(entity, response.headers.get("etag") ?? undefined);
  }

  async recordAccess(
    key: TranslationKey,
    now = new Date(),
  ): Promise<TranslationRecord> {
    for (let attempt = 0; attempt < MAX_ACCESS_UPDATE_RETRIES; attempt++) {
      const existing = await this.get(key);
      if (!existing) {
        const created = initialRecord(key, now);
        const response = await this.fetcher(this.tableUrl, {
          method: "POST",
          headers: tableHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(toEntity(created)),
        });
        if (response.ok) {
          await response.body?.cancel().catch(() => {});
          return created;
        }
        if (response.status === 409) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        throw await tableError("insert", response);
      }
      const updated: TranslationRecord = {
        ...existing,
        accessCount: existing.accessCount + 1,
        lastAccessedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        status: existing.status === "processing"
          ? "processing"
          : existing.content
          ? existing.status
          : "pending",
        nextProcessAt: existing.content
          ? existing.nextProcessAt
          : earlier(existing.nextProcessAt, now.toISOString()),
      };
      const response = await this.merge(updated, existing.etag);
      if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return updated;
      }
      if (response.status === 412 || response.status === 404) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      throw await tableError("update access", response);
    }
    throw new Error("Azure Table access update conflicted repeatedly");
  }

  async listDue(now: Date, limit: number): Promise<TranslationRecord[]> {
    const firstPage = new URL(this.tableUrl);
    firstPage.pathname = `${firstPage.pathname.replace(/\/+$/, "")}()`;
    firstPage.searchParams.set(
      "$filter",
      `NextProcessAt le datetime'${now.toISOString()}'`,
    );
    firstPage.searchParams.set("$top", "1000");
    const entities: AzureTableEntity[] = [];
    let pageUrl: URL | undefined = firstPage;
    while (pageUrl) {
      const response = await this.fetcher(pageUrl, {
        headers: tableHeaders(),
      });
      if (!response.ok) throw await tableError("query", response);
      const body = await response.json() as { value?: AzureTableEntity[] };
      entities.push(...(body.value ?? []));
      pageUrl = continuationUrl(firstPage, response.headers);
    }
    return entities
      .map((entity) => fromEntity(entity))
      .filter((record) =>
        record.status !== "processing" ||
        !record.leaseExpiresAt ||
        Date.parse(record.leaseExpiresAt) <= now.getTime()
      )
      .sort((a, b) =>
        Number(Boolean(b.edgeSyncPending)) -
          Number(Boolean(a.edgeSyncPending)) ||
        b.accessCount - a.accessCount ||
        Date.parse(a.nextProcessAt) - Date.parse(b.nextProcessAt)
      )
      .slice(0, limit);
  }

  async claim(
    record: TranslationRecord,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<TranslationRecord | undefined> {
    const claimed: TranslationRecord = {
      ...record,
      status: "processing",
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      nextProcessAt: leaseExpiresAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const response = await this.merge(claimed, record.etag);
    if (response.status === 404 || response.status === 412) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) throw await tableError("claim", response);
    await response.body?.cancel().catch(() => {});
    claimed.etag = response.headers.get("etag") ?? claimed.etag;
    return claimed;
  }

  async putTranslation(
    record: TranslationRecord,
    input: {
      content: string;
      contentType: TranslationContentType;
      sourceHash: string;
      nextProcessAt: Date;
    },
  ): Promise<void> {
    await this.mergeLeaseOwned(record, "write translation", (current) => ({
      ...current,
      content: input.content,
      contentType: input.contentType,
      sourceHash: input.sourceHash,
      status: "ready",
      nextProcessAt: input.nextProcessAt.toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    }));
  }

  async complete(
    record: TranslationRecord,
    nextProcessAt: Date,
  ): Promise<void> {
    await this.mergeLeaseOwned(record, "complete", (current) => ({
      ...current,
      status: current.content ? "ready" : "pending",
      nextProcessAt: nextProcessAt.toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    }));
  }

  async fail(
    record: TranslationRecord,
    error: string,
    nextProcessAt: Date,
  ): Promise<void> {
    await this.mergeLeaseOwned(record, "fail", (current) => ({
      ...current,
      status: "failed",
      nextProcessAt: nextProcessAt.toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: error.slice(0, 1_000),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    }));
  }

  async stageEdgeSync(
    record: TranslationRecord,
    input: {
      content: string;
      contentType: TranslationContentType;
      sourceHash: string;
      nextProcessAt: Date;
    },
  ): Promise<void> {
    await this.mergeLeaseOwned(record, "stage edge sync", (current) => ({
      ...current,
      content: input.content,
      contentType: input.contentType,
      sourceHash: input.sourceHash,
      status: "processing",
      edgeSyncPending: true,
      edgeSyncResumeAt: input.nextProcessAt.toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    }));
  }

  async completeEdgeSync(record: TranslationRecord): Promise<void> {
    await this.mergeLeaseOwned(record, "complete edge sync", (current) => ({
      ...current,
      status: "ready",
      nextProcessAt: current.edgeSyncResumeAt || current.nextProcessAt,
      updatedAt: new Date().toISOString(),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      edgeSyncPending: false,
      edgeSyncResumeAt: undefined,
    }));
  }

  async retryEdgeSync(
    record: TranslationRecord,
    retryAt: Date,
  ): Promise<void> {
    await this.mergeLeaseOwned(record, "retry edge sync", (current) => ({
      ...current,
      status: "ready",
      nextProcessAt: retryAt.toISOString(),
      updatedAt: new Date().toISOString(),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      edgeSyncPending: true,
    }));
  }

  private merge(record: TranslationRecord, etag = "*") {
    return this.fetcher(this.entityUrl(record), {
      method: "MERGE",
      headers: tableHeaders({
        "content-type": "application/json",
        "if-match": etag || "*",
      }),
      body: JSON.stringify(toEntity(record)),
    });
  }

  private entityUrl(key: TranslationKey) {
    const url = new URL(this.tableUrl);
    const tablePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${tablePath}(PartitionKey='${
      odataString(key.locale)
    }',RowKey='${odataString(rowKey(key))}')`;
    return url;
  }

  private async mergeLeaseOwned(
    claimed: TranslationRecord,
    operation: string,
    update: (current: TranslationRecord) => TranslationRecord,
  ) {
    for (let attempt = 0; attempt < MAX_LEASE_UPDATE_RETRIES; attempt++) {
      const current = await this.get(claimed);
      if (
        !current ||
        current.status !== "processing" ||
        !claimed.leaseToken ||
        current.leaseToken !== claimed.leaseToken
      ) {
        throw new Error(`Azure Table ${operation} lost its translation lease`);
      }
      const response = await this.merge(update(current), current.etag);
      if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (response.status === 404 || response.status === 412) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      throw await tableError(operation, response);
    }
    throw new Error(`Azure Table ${operation} conflicted repeatedly`);
  }
}

const stores = new Map<string, AzureTableTranslationStore>();

export function getTranslationStore(
  config: AppConfig,
): TranslationStore | undefined {
  const url = config.AZURE_TRANSLATION_TABLE_URL?.trim();
  if (!url) return undefined;
  let store = stores.get(url);
  if (!store) {
    store = new AzureTableTranslationStore(url);
    stores.set(url, store);
  }
  return store;
}

export function rowKey(key: Pick<TranslationKey, "type" | "projectId">) {
  return `${key.type}:${key.projectId}`;
}

function initialRecord(key: TranslationKey, now: Date): TranslationRecord {
  const timestamp = now.toISOString();
  return {
    ...key,
    contentType: key.type === "modrinth" ? "text/markdown" : "text/html",
    status: "pending",
    accessCount: 1,
    firstAccessedAt: timestamp,
    lastAccessedAt: timestamp,
    nextProcessAt: timestamp,
    updatedAt: timestamp,
  };
}

function toEntity(record: TranslationRecord): AzureTableEntity {
  return {
    PartitionKey: record.locale,
    RowKey: rowKey(record),
    Locale: record.locale,
    Type: record.type,
    ProjectId: record.projectId,
    Content: record.content,
    ContentType: record.contentType,
    SourceHash: record.sourceHash,
    Status: record.status,
    AccessCount: record.accessCount,
    FirstAccessedAt: record.firstAccessedAt,
    LastAccessedAt: record.lastAccessedAt,
    NextProcessAt: record.nextProcessAt,
    "NextProcessAt@odata.type": "Edm.DateTime",
    UpdatedAt: record.updatedAt,
    LastError: record.lastError ?? "",
    LeaseToken: record.leaseToken ?? "",
    LeaseExpiresAt: record.leaseExpiresAt ?? "",
    EdgeSyncPending: record.edgeSyncPending ?? false,
    EdgeSyncResumeAt: record.edgeSyncResumeAt ?? "",
  } as AzureTableEntity;
}

function fromEntity(
  entity: AzureTableEntity,
  responseEtag?: string,
): TranslationRecord {
  const type = entity.Type === "curseforge" ? "curseforge" : "modrinth";
  const now = new Date().toISOString();
  return {
    locale: entity.Locale || entity.PartitionKey,
    type,
    projectId: entity.ProjectId ||
      entity.RowKey.slice(entity.RowKey.indexOf(":") + 1),
    content: typeof entity.Content === "string" ? entity.Content : undefined,
    contentType: entity.ContentType === "text/html"
      ? "text/html"
      : "text/markdown",
    sourceHash: typeof entity.SourceHash === "string"
      ? entity.SourceHash
      : undefined,
    status: parseStatus(entity.Status),
    accessCount: Number.isFinite(entity.AccessCount)
      ? Number(entity.AccessCount)
      : 0,
    firstAccessedAt: entity.FirstAccessedAt || now,
    lastAccessedAt: entity.LastAccessedAt || now,
    nextProcessAt: entity.NextProcessAt || now,
    updatedAt: entity.UpdatedAt || now,
    lastError: entity.LastError,
    leaseToken: entity.LeaseToken,
    leaseExpiresAt: entity.LeaseExpiresAt,
    edgeSyncPending: entity.EdgeSyncPending === true,
    edgeSyncResumeAt: entity.EdgeSyncResumeAt || undefined,
    etag: responseEtag || entity["odata.etag"],
  };
}

function parseStatus(value: string | undefined): TranslationRecord["status"] {
  return value === "processing" || value === "ready" || value === "failed"
    ? value
    : "pending";
}

function validateTableUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AZURE_TRANSLATION_TABLE_URL must be a valid URL");
  }
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

function earlier(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
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
