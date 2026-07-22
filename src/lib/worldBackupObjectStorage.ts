import type {
  WorldBackupFormat,
  WorldBackupUploadGrant,
} from "./worldBackupContracts.ts";

export interface WorldBackupObjectMetadata {
  objectKey: string;
  contentLength: number;
  sha256: string;
  contentType: "application/vnd.xmcl.linear";
  backupId: string;
  format: WorldBackupFormat;
  formatVersion: number;
  /**
   * Set only by the storage adapter after inspecting the compressed object
   * header. Client-controlled MIME metadata is never sufficient verification.
   */
  formatVerified: boolean;
}

export interface WorldBackupObjectStorage {
  /** The adapter must produce a one-time URL and enforce every supplied binding. */
  issueSingleUseUpload(
    input: Omit<WorldBackupObjectMetadata, "formatVerified"> & {
      expiresAt: string;
    },
  ): Promise<WorldBackupUploadGrant>;
  head(objectKey: string): Promise<WorldBackupObjectMetadata | undefined>;
  delete(objectKey: string): Promise<void>;
}

export function worldBackupObjectKey(accountId: string, backupId: string) {
  return `world-backups/${accountId}/${backupId}.linear`;
}
