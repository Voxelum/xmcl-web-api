/**
 * WorldBackup's local contract proposal. This intentionally remains outside contracts/
 * until the shared-contract owner publishes compatible Account–Worker schemas.
 */
export const WORLD_BACKUP_WORLD_BACKUP_CONTRACT_VERSION = 1;
export const WORLD_BACKUP_SHARED_CONTRACT_VERSION = 1;
export const WORLD_BACKUP_FREE_STORAGE_BYTES = 1_073_741_824;
export const WORLD_BACKUP_STORAGE_SETTLEMENT_INTERVAL_SECONDS = 60 * 60;

export type WorldBackupSourceType =
  | "client_world"
  | "hosted_server_world";
export type WorldBackupFormat = "linear" | "layered_linear";
export type WorldBackupStatus =
  | "creating"
  | "uploading"
  | "ready"
  | "restoring"
  | "failed"
  | "deleted";

export interface WorldBackupResource {
  backupId: string;
  accountId: string;
  sourceType: WorldBackupSourceType;
  sourceId: string;
  worldId: string;
  format: WorldBackupFormat;
  formatVersion: number;
  parentBackupId?: string;
  status: WorldBackupStatus;
  sizeBytes: number;
  sha256: string;
  contentType: "application/vnd.xmcl.linear";
  /** D1/D4 immutable physical-object attribution. */
  objectId: string;
  storageOwnerAccountId: string;
  verified: boolean;
  authorizationId?: string;
  authorizationExpiresAt?: string;
  authorizationRateVersion?: number;
  uploadExpiresAt?: string;
  /** Internal-only persisted grant for idempotent upload-url retries. */
  uploadGrant?: WorldBackupUploadGrant;
  referenceCount: number;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
  createIdempotencyKey: string;
}

export interface WorldBackupAsyncTask<T = unknown> {
  taskId: string;
  requestId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  resource: { type: "world_backup"; id: string };
  result?: T;
  error?: { error: string; message: string; requestId: string };
  createdAt: string;
  updatedAt: string;
}

export interface WorldBackupUploadGrant {
  backupId: string;
  url: string;
  expiresAt: string;
  contentLength: number;
  sha256: string;
  requiredHeaders: Record<string, string>;
}

export interface WorldBackupStorageUsageEvent {
  eventType: "usage.recorded.v1";
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  authorizationId: string;
  resource: "storage_retention";
  quantity: number;
  unit: "byte_second";
  sourceId: string;
  rateVersion: number;
  sequence: number;
  intervalStart: string;
  intervalEnd: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface WorldBackupStorageBillingCursor {
  accountId: string;
  lastSettledAt: string;
  lastUsageSequence: number;
}

export interface WorldBackupPhysicalStorageObject {
  objectId: string;
  storageOwnerAccountId: string;
  physicalBytes: number;
  activeReferenceCount: number;
  verified: true;
}

export interface WorldBackupStorageUsageSnapshot {
  accountId: string;
  policy: {
    freeBytes: typeof WORLD_BACKUP_FREE_STORAGE_BYTES;
    policyVersion: 1;
  };
  usedBytes: number;
  overageBytes: number;
  lastSettledAt: string;
  settlementIntervalSeconds:
    typeof WORLD_BACKUP_STORAGE_SETTLEMENT_INTERVAL_SECONDS;
  countedObjects: WorldBackupPhysicalStorageObject[];
}
