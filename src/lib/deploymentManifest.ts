import type {
  ModpackCompatibility,
  ModpackSourceFormat,
  ValidatedArchiveFile,
} from "./modpackValidator.ts";
import type { ResolvedModSource } from "./modpackSources/types.ts";

export interface DeploymentManifest {
  manifestVersion: 1;
  deploymentId: string;
  serverId: string;
  sourceFormat: ModpackSourceFormat;
  compatibility: ModpackCompatibility;
  configFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
  dataFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
  mods: Array<{
    provider: "modrinth" | "curseforge";
    projectId: string;
    fileId: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
  }>;
  rollbackSnapshotId: string;
  createdAt: string;
}

export interface FrozenDeploymentManifest {
  manifest: Readonly<DeploymentManifest>;
  manifestSha256: string;
}

export interface DeploymentPreview {
  deploymentId: string;
  manifestSha256: string;
  rollbackSnapshotId: string;
  changes: {
    config: string[];
    data: string[];
    mods: Array<{
      provider: "modrinth" | "curseforge";
      projectId: string;
      fileId: string;
      filename: string;
    }>;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function hashCanonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fileDescriptor(file: ValidatedArchiveFile) {
  return { path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export async function freezeDeploymentManifest(input: {
  deploymentId: string;
  serverId: string;
  sourceFormat: ModpackSourceFormat;
  compatibility: ModpackCompatibility;
  configFiles: ValidatedArchiveFile[];
  dataFiles: ValidatedArchiveFile[];
  mods: ResolvedModSource[];
  rollbackSnapshotId: string;
  createdAt: string;
}): Promise<FrozenDeploymentManifest> {
  if (!input.rollbackSnapshotId) throw new Error("rollback_snapshot_missing");
  const manifest: DeploymentManifest = {
    manifestVersion: 1,
    deploymentId: input.deploymentId,
    serverId: input.serverId,
    sourceFormat: input.sourceFormat,
    compatibility: structuredClone(input.compatibility),
    configFiles: input.configFiles.map(fileDescriptor).sort((a, b) =>
      a.path.localeCompare(b.path)
    ),
    dataFiles: input.dataFiles.map(fileDescriptor).sort((a, b) =>
      a.path.localeCompare(b.path)
    ),
    mods: input.mods.map((mod) => ({
      provider: mod.provider,
      projectId: mod.projectId,
      fileId: mod.fileId,
      filename: mod.filename,
      sha256: mod.sha256,
      sizeBytes: mod.sizeBytes,
    })).sort((a, b) =>
      `${a.provider}:${a.projectId}:${a.fileId}`.localeCompare(
        `${b.provider}:${b.projectId}:${b.fileId}`,
      )
    ),
    rollbackSnapshotId: input.rollbackSnapshotId,
    createdAt: input.createdAt,
  };
  const manifestSha256 = await hashCanonical(manifest);
  return { manifest: deepFreeze(manifest), manifestSha256 };
}

export function createDeploymentPreview(
  frozen: FrozenDeploymentManifest,
): DeploymentPreview {
  const manifest = frozen.manifest;
  return deepFreeze({
    deploymentId: manifest.deploymentId,
    manifestSha256: frozen.manifestSha256,
    rollbackSnapshotId: manifest.rollbackSnapshotId,
    changes: {
      config: manifest.configFiles.map((file) => file.path),
      data: manifest.dataFiles.map((file) => file.path),
      mods: manifest.mods.map(({ provider, projectId, fileId, filename }) => ({
        provider,
        projectId,
        fileId,
        filename,
      })),
    },
  });
}
