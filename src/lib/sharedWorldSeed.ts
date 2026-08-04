import type { Db } from "../db.ts";
import { AccountError } from "./account.ts";
import {
  DEFAULT_MODPACK_ZIP_LIMITS,
  ModpackZipError,
  readModpackZip,
} from "./modpackImport.ts";
import {
  type SharedInitialWorld,
  SharedHostingScheduler,
} from "./sharedHostingScheduler.ts";
import type { SharedNodeWorkspaceSigner } from "./sharedNodeTransport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_WORLD_SEED_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_WORLD_SEED_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_WORLD_SEED_ENTRIES = 4096;

export interface WorldSeedFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface SharedWorldSeed {
  seedId: string;
  accountId: string;
  serviceId: string;
  archiveKey: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  status: "awaiting_upload" | "validating" | "valid" | "invalid" | "selected";
  worldName?: string;
  files?: WorldSeedFile[];
  validation?: { code: string };
  uploadIssuedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface Claim {
  accountId: string;
  scope: string;
  key: string;
  fingerprint: string;
  resourceId: string;
}

export interface SharedWorldSeedRepository {
  claim(input: Claim): Promise<"claimed" | "duplicate" | "conflict">;
  getClaim(input: Pick<Claim, "accountId" | "scope" | "key">): Promise<Claim | undefined>;
  put(value: SharedWorldSeed): Promise<void>;
  get(seedId: string): Promise<SharedWorldSeed | undefined>;
  list(serviceId: string): Promise<SharedWorldSeed[]>;
}

export interface SharedWorldSeedArchiveStore {
  createUpload(input: {
    seedId: string;
    key: string;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<{ uploadUrl: string; expiresAt: string; maxSizeBytes: number }>;
  readVerified(input: {
    seedId: string;
    key: string;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<Uint8Array>;
}

export interface WorldSeedCompilerGrant {
  key: string;
  method: "GET";
  url: string;
  expiresAt: string;
}

export interface WorldSeedCompilerGrantSet {
  accountId: string;
  serviceId: string;
  seedId: string;
  grants: readonly WorldSeedCompilerGrant[];
}

/**
 * Separate from node workspace grants: it issues one read for exactly one
 * selected seed and never grants list, delete, write, or a service prefix.
 */
export class WorldSeedCompilerGrantAuthority {
  constructor(
    private readonly signer: SharedNodeWorkspaceSigner,
    private readonly expiresInSeconds = 10 * 60,
  ) {}

  async issue(seed: SharedWorldSeed): Promise<WorldSeedCompilerGrantSet> {
    if (seed.status !== "selected") throw new SharedWorldSeedError("state_conflict");
    const signed = await this.signer.presign(seed.archiveKey, "GET", this.expiresInSeconds);
    if (
      signed.key !== seed.archiveKey || signed.method !== "GET" ||
      typeof signed.url !== "string" || !signed.url.startsWith("https://") ||
      signed.headers && Object.keys(signed.headers).length !== 0
    ) throw new SharedWorldSeedError("state_conflict");
    return {
      accountId: seed.accountId,
      serviceId: seed.serviceId,
      seedId: seed.seedId,
      grants: [{ key: signed.key, method: "GET", url: signed.url, expiresAt: signed.expiresAt }],
    };
  }
}

export class SharedWorldSeedError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "state_conflict" | "idempotency_conflict") {
    super(code);
    this.name = "SharedWorldSeedError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function claimKey(input: Pick<Claim, "accountId" | "scope" | "key">) {
  return `${input.accountId}:${input.scope}:${input.key}`;
}

export class MemorySharedWorldSeedRepository implements SharedWorldSeedRepository {
  private readonly seeds = new Map<string, SharedWorldSeed>();
  private readonly claims = new Map<string, Claim>();
  private tail = Promise.resolve();

  async claim(input: Claim) {
    return await this.transact(() => {
      const prior = this.claims.get(claimKey(input));
      if (!prior) {
        this.claims.set(claimKey(input), clone(input));
        return "claimed" as const;
      }
      return prior.fingerprint === input.fingerprint ? "duplicate" as const : "conflict" as const;
    });
  }
  async getClaim(input: Pick<Claim, "accountId" | "scope" | "key">) {
    await this.tail;
    const value = this.claims.get(claimKey(input));
    return value && clone(value);
  }
  async put(value: SharedWorldSeed) {
    await this.transact(() => this.seeds.set(value.seedId, clone(value)));
  }
  async get(seedId: string) {
    await this.tail;
    const value = this.seeds.get(seedId);
    return value && clone(value);
  }
  async list(serviceId: string) {
    await this.tail;
    return [...this.seeds.values()].filter((seed) => seed.serviceId === serviceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }
  private async transact<T>(operation: () => T) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

/** Durable seed records and idempotency claims are intentionally service-owned. */
export class MongoSharedWorldSeedRepository implements SharedWorldSeedRepository {
  constructor(private readonly db: Db) {}
  async claim(input: Claim) {
    const key = claimKey(input);
    await this.claims().updateOne({ _id: key }, { $setOnInsert: { ...clone(input), _id: key } }, { upsert: true });
    const value = await this.claims().findOne({ _id: key }) as Claim | undefined;
    return value?.fingerprint === input.fingerprint
      ? value.resourceId === input.resourceId ? "claimed" : "duplicate"
      : "conflict";
  }
  async getClaim(input: Pick<Claim, "accountId" | "scope" | "key">) {
    const value = await this.claims().findOne({ _id: claimKey(input) }) as Claim | undefined;
    return value && clone(value);
  }
  async put(value: SharedWorldSeed) {
    await this.seeds().updateOne({ _id: value.seedId }, { $set: { ...clone(value), _id: value.seedId } }, { upsert: true });
  }
  async get(seedId: string) {
    const value = await this.seeds().findOne({ _id: seedId }) as SharedWorldSeed | undefined;
    return value && clone(value);
  }
  async list(serviceId: string) {
    const collection = this.seeds() as unknown as { find(filter: Record<string, unknown>): { toArray(): Promise<SharedWorldSeed[]> } };
    return (await collection.find({ serviceId }).toArray())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }
  private seeds() { return this.db.collection("shared_world_seeds"); }
  private claims() { return this.db.collection("shared_world_seed_claims"); }
}

export interface SharedWorldSeedServiceOptions {
  repository: SharedWorldSeedRepository;
  archives: SharedWorldSeedArchiveStore;
  scheduler: SharedHostingScheduler;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export class SharedWorldSeedService {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  constructor(private readonly options: SharedWorldSeedServiceOptions) {
    if (!options.repository || !options.archives || !options.scheduler) {
      throw new Error("shared world seeds require durable repository, archive store, and scheduler");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  }

  async create(input: {
    accountId: string; serviceId: string; expectedSha256: string; expectedSizeBytes: number; idempotencyKey: string;
  }) {
    await this.assertEligible(input.accountId, input.serviceId);
    if (!validSha256(input.expectedSha256) || !validSize(input.expectedSizeBytes) || !validKey(input.idempotencyKey)) {
      throw new SharedWorldSeedError("invalid_request");
    }
    const seedId = this.createId("shared_wseed");
    const fingerprint = JSON.stringify({ expectedSha256: input.expectedSha256.toLowerCase(), expectedSizeBytes: input.expectedSizeBytes });
    const claim = await this.options.repository.claim({
      accountId: input.accountId, scope: `world-seed:${input.serviceId}`, key: input.idempotencyKey, fingerprint, resourceId: seedId,
    });
    if (claim === "conflict") throw new SharedWorldSeedError("idempotency_conflict");
    if (claim === "duplicate") {
      const prior = await this.options.repository.getClaim({ accountId: input.accountId, scope: `world-seed:${input.serviceId}`, key: input.idempotencyKey });
      const existing = prior && await this.options.repository.get(prior.resourceId);
      if (!existing || existing.accountId !== input.accountId) throw new SharedWorldSeedError("state_conflict");
      return existing;
    }
    const timestamp = this.now();
    const seed: SharedWorldSeed = {
      seedId, accountId: input.accountId, serviceId: input.serviceId,
      archiveKey: `shared-hosting/${input.accountId}/${input.serviceId}/world-seeds/${seedId}.xmcl-world-seed`,
      expectedSha256: input.expectedSha256.toLowerCase(), expectedSizeBytes: input.expectedSizeBytes,
      status: "awaiting_upload", createdAt: timestamp, updatedAt: timestamp,
    };
    await this.options.repository.put(seed);
    return seed;
  }

  async uploadUrl(accountId: string, seedId: string) {
    const seed = await this.require(accountId, seedId);
    await this.assertEligible(accountId, seed.serviceId);
    if (seed.status !== "awaiting_upload" || seed.uploadIssuedAt) throw new SharedWorldSeedError("state_conflict");
    seed.uploadIssuedAt = this.now();
    seed.updatedAt = seed.uploadIssuedAt;
    await this.options.repository.put(seed);
    return await this.options.archives.createUpload({
      seedId, key: seed.archiveKey, expectedSha256: seed.expectedSha256, expectedSizeBytes: seed.expectedSizeBytes,
    });
  }

  async complete(accountId: string, seedId: string, idempotencyKey: string) {
    const seed = await this.require(accountId, seedId);
    if (!validKey(idempotencyKey)) throw new SharedWorldSeedError("invalid_request");
    if (seed.status === "selected" || seed.status === "valid" || seed.status === "invalid") return seed;
    if (seed.status !== "awaiting_upload" || !seed.uploadIssuedAt) throw new SharedWorldSeedError("state_conflict");
    seed.status = "validating";
    seed.updatedAt = this.now();
    await this.options.repository.put(seed);
    try {
      const archive = await this.options.archives.readVerified({
        seedId, key: seed.archiveKey, expectedSha256: seed.expectedSha256, expectedSizeBytes: seed.expectedSizeBytes,
      });
      if (archive.byteLength !== seed.expectedSizeBytes || await sha256(archive) !== seed.expectedSha256) {
        throw new Error("archive_hash_mismatch");
      }
      const validated = await validateWorldSeed(archive);
      seed.worldName = validated.worldName;
      seed.files = validated.files;
      seed.status = "valid";
      seed.validation = undefined;
      seed.updatedAt = this.now();
      await this.options.repository.put(seed);
      await this.options.scheduler.selectInitialWorld({
        accountId, serviceId: seed.serviceId,
        world: { seedId, sha256: seed.expectedSha256, sizeBytes: seed.expectedSizeBytes, worldName: seed.worldName } satisfies SharedInitialWorld,
        idempotencyKey: `seed:${seedId}:${idempotencyKey}`,
      });
      seed.status = "selected";
      seed.updatedAt = this.now();
      await this.options.repository.put(seed);
      return seed;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      seed.status = "invalid";
      seed.validation = { code: error instanceof Error ? error.message : "archive_verification_failed" };
      seed.updatedAt = this.now();
      await this.options.repository.put(seed);
      return seed;
    }
  }

  async list(accountId: string, serviceId: string) {
    await this.options.scheduler.getService(accountId, serviceId);
    return await this.options.repository.list(serviceId);
  }
  async compilerGrants(seedId: string, authority: WorldSeedCompilerGrantAuthority) {
    const seed = await this.options.repository.get(seedId);
    if (!seed) throw new SharedWorldSeedError("not_found");
    return await authority.issue(seed);
  }
  private async require(accountId: string, seedId: string) {
    const seed = await this.options.repository.get(seedId);
    if (!seed || seed.accountId !== accountId) throw new SharedWorldSeedError("not_found");
    return seed;
  }
  private async assertEligible(accountId: string, serviceId: string) {
    try {
      await this.options.scheduler.assertInitialWorldEligible(accountId, serviceId);
    } catch (error) {
      if (error instanceof AccountError && error.status === 409) {
        throw new SharedWorldSeedError("state_conflict");
      }
      throw error;
    }
  }
}

export async function validateWorldSeed(archive: Uint8Array): Promise<{ worldName: string; files: WorldSeedFile[] }> {
  let entries;
  try {
    entries = await readModpackZip(archive, {
      ...DEFAULT_MODPACK_ZIP_LIMITS,
      maxArchiveBytes: MAX_WORLD_SEED_ARCHIVE_BYTES,
      maxEntries: MAX_WORLD_SEED_ENTRIES,
      maxEntryBytes: 64 * 1024 * 1024,
      maxTotalUncompressedBytes: MAX_WORLD_SEED_LOGICAL_BYTES,
    });
  } catch (error) {
    throw new Error(error instanceof ModpackZipError ? error.code : "invalid_world_seed");
  }
  const manifestEntries = entries.filter((entry) => entry.path === "world.json");
  if (manifestEntries.length !== 1) throw new Error("world_manifest_count_invalid");
  const manifest = parseManifest(manifestEntries[0].bytes);
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  if (entries.length !== manifest.files.length + 1 || !entries.some((entry) => entry.path === "world/level.dat")) {
    throw new Error("world_manifest_mismatch");
  }
  for (const entry of entries) {
    if (entry.path === "world.json") continue;
    const expected = listed.get(entry.path);
    if (!expected || entry.uncompressedSize !== expected.sizeBytes ||
      await sha256(entry.bytes) !== expected.sha256 || rejectedWorldPath(entry.path)) {
      throw new Error("world_hash_or_path_mismatch");
    }
  }
  return { worldName: manifest.worldName, files: manifest.files };
}

function parseManifest(bytes: Uint8Array): { worldName: string; files: WorldSeedFile[] } {
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(bytes)); } catch { throw new Error("invalid_world_manifest"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_world_manifest");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schemaVersion", "worldName", "source", "files"].includes(key)) ||
    value.schemaVersion !== 1 || value.source !== "local_instance" ||
    typeof value.worldName !== "string" || !value.worldName.trim() || value.worldName.length > 255 ||
    !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_WORLD_SEED_ENTRIES) {
    throw new Error("invalid_world_manifest");
  }
  let previous = "";
  const files: WorldSeedFile[] = [];
  for (const rawFile of value.files) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error("invalid_world_manifest");
    const file = rawFile as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["path", "sha256", "sizeBytes"].includes(key)) ||
      typeof file.path !== "string" || rejectedWorldPath(file.path) ||
      typeof file.sha256 !== "string" || !validSha256(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 0 ||
      (previous && previous >= file.path)) {
      throw new Error("invalid_world_manifest");
    }
    previous = file.path;
    files.push({ path: file.path, sha256: file.sha256.toLowerCase(), sizeBytes: file.sizeBytes as number });
  }
  return { worldName: value.worldName, files };
}

function rejectedWorldPath(path: string) {
  return !path.startsWith("world/") || path.length > 1024 ||
    /(?:^|\/)(?:server\.properties|eula\.txt|usercache\.json|ops\.json|whitelist\.json|banned-(?:ips|players)\.json|auth(?:entication)?|credentials?)(?:$|[/.])/i.test(path) ||
    /\.(?:sh|bat|cmd|ps1)$/i.test(path);
}
function validSha256(value: string) { return /^[a-f0-9]{64}$/i.test(value); }
function validSize(value: number) { return Number.isSafeInteger(value) && value > 0 && value <= MAX_WORLD_SEED_ARCHIVE_BYTES; }
function validKey(value: string) { return Boolean(value && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value)); }
async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
