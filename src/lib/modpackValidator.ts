import {
  DEFAULT_MODPACK_ZIP_LIMITS,
  ModpackZipError,
  type ModpackZipLimits,
  readModpackZip,
} from "./modpackImport.ts";
import {
  type ModpackProvider,
  ModpackSourceError,
  type ModpackSourceResolver,
  type ModSourceReference,
  type ResolvedModSource,
} from "./modpackSources/types.ts";

export type ModpackSourceFormat = "mrpack" | "curseforge_zip";
export type ModLoader = "vanilla" | "forge" | "fabric" | "quilt" | "neoforge";

export interface ModpackCompatibility {
  minecraftVersion: string;
  loader: ModLoader;
  loaderVersion?: string;
  javaMajor: number;
  templateId: string;
}

export interface ValidatedArchiveFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  bytes: Uint8Array;
}

export interface ModpackValidationReport {
  importId: string;
  sourceFormat: ModpackSourceFormat;
  status: "pending" | "valid" | "invalid";
  configFiles: string[];
  dataFiles: string[];
  mods: Array<{
    provider: ModpackProvider;
    projectId: string;
    fileId: string;
    filename: string;
    sha256?: string;
  }>;
  rejectedFiles: Array<{ path: string; reason: string }>;
  compatibility?: ModpackCompatibility;
}

export interface ValidatedModpack {
  report: ModpackValidationReport;
  configFiles: ValidatedArchiveFile[];
  dataFiles: ValidatedArchiveFile[];
  resolvedMods: ResolvedModSource[];
}

const forbiddenExtensions = new Set([
  ".jar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".com",
  ".scr",
  ".msi",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".php",
]);

function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("");
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_manifest");
  }
}

function containsUrl(value: unknown): boolean {
  if (typeof value === "string") return /(?:https?|ftp):\/\//i.test(value);
  if (Array.isArray(value)) return value.some(containsUrl);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsUrl);
  }
  return false;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid_manifest");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("invalid_manifest");
  }
  return value as number;
}

function parseLoader(
  value: string,
): { loader: ModLoader; loaderVersion?: string } {
  const match =
    /^(vanilla|forge|fabric|fabric-loader|quilt|quilt-loader|neoforge)(?:[-:](.+))?$/
      .exec(value.toLowerCase());
  if (!match) throw new Error("invalid_manifest");
  const loader = match[1] === "fabric-loader"
    ? "fabric"
    : match[1] === "quilt-loader"
    ? "quilt"
    : match[1] as ModLoader;
  return { loader, loaderVersion: match[2] };
}

interface ParsedManifest {
  format: ModpackSourceFormat;
  compatibility: ModpackCompatibility;
  mods: ModSourceReference[];
}

function parseMrpack(manifest: Record<string, unknown>): ParsedManifest {
  const dependencies = manifest.dependencies as
    | Record<string, unknown>
    | undefined;
  const xmcl = manifest.xmcl as Record<string, unknown> | undefined;
  if (!dependencies || !xmcl) throw new Error("invalid_manifest");
  const minecraftVersion = requiredString(dependencies.minecraft);
  const loaderKeys = [
    ["fabric-loader", "fabric"],
    ["quilt-loader", "quilt"],
    ["forge", "forge"],
    ["neoforge", "neoforge"],
  ] as const;
  const selected = loaderKeys.find(([key]) =>
    typeof dependencies[key] === "string"
  );
  const loader = selected?.[1] ?? "vanilla";
  const loaderVersion = selected
    ? requiredString(dependencies[selected[0]])
    : undefined;
  const files = manifest.files;
  if (!Array.isArray(files)) throw new Error("invalid_manifest");
  const mods = files.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid_manifest");
    const file = raw as Record<string, unknown>;
    return {
      provider: (file.provider ?? "modrinth") as ModpackProvider,
      projectId: requiredString(file.projectId ?? file.project_id),
      fileId: requiredString(file.fileId ?? file.file_id),
      filename: typeof file.filename === "string"
        ? file.filename
        : typeof file.path === "string"
        ? file.path.slice(file.path.lastIndexOf("/") + 1)
        : "",
    };
  });
  return {
    format: "mrpack",
    compatibility: {
      minecraftVersion,
      loader,
      loaderVersion,
      javaMajor: requiredPositiveInteger(xmcl.javaMajor),
      templateId: requiredString(xmcl.templateId),
    },
    mods,
  };
}

function parseCurseForge(manifest: Record<string, unknown>): ParsedManifest {
  const minecraft = manifest.minecraft as Record<string, unknown> | undefined;
  const xmcl = manifest.xmcl as Record<string, unknown> | undefined;
  const files = manifest.files;
  if (!minecraft || !xmcl || !Array.isArray(files)) {
    throw new Error("invalid_manifest");
  }
  const loaders = minecraft.modLoaders;
  const parsedLoader = Array.isArray(loaders) && loaders.length > 0
    ? parseLoader(requiredString((loaders[0] as Record<string, unknown>)?.id))
    : { loader: "vanilla" as const };
  const mods = files.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid_manifest");
    const file = raw as Record<string, unknown>;
    return {
      provider: "curseforge" as const,
      projectId: String(
        requiredPositiveInteger(file.projectID ?? file.projectId),
      ),
      fileId: String(requiredPositiveInteger(file.fileID ?? file.fileId)),
      filename: typeof file.fileName === "string" ? file.fileName : "",
    };
  });
  return {
    format: "curseforge_zip",
    compatibility: {
      minecraftVersion: requiredString(minecraft.version),
      ...parsedLoader,
      javaMajor: requiredPositiveInteger(xmcl.javaMajor),
      templateId: requiredString(xmcl.templateId),
    },
    mods,
  };
}

function reject(
  report: ModpackValidationReport,
  path: string,
  reason: string,
) {
  report.rejectedFiles.push({ path, reason });
}

export async function validateModpackArchive(input: {
  importId: string;
  archive: Uint8Array;
  resolvers: readonly ModpackSourceResolver[];
  limits?: ModpackZipLimits;
}): Promise<ValidatedModpack> {
  const report: ModpackValidationReport = {
    importId: input.importId,
    sourceFormat: "mrpack",
    status: "invalid",
    configFiles: [],
    dataFiles: [],
    mods: [],
    rejectedFiles: [],
  };
  let entries;
  try {
    entries = await readModpackZip(
      input.archive,
      input.limits ?? DEFAULT_MODPACK_ZIP_LIMITS,
    );
  } catch (error) {
    if (error instanceof ModpackZipError) {
      reject(report, error.path ?? "$archive", error.code);
      return { report, configFiles: [], dataFiles: [], resolvedMods: [] };
    }
    throw error;
  }

  const manifests = entries.filter((entry) =>
    entry.path === "modrinth.index.json" || entry.path === "manifest.json"
  );
  if (manifests.length !== 1) {
    reject(report, "$archive", "manifest_count_invalid");
  }
  const configFiles: ValidatedArchiveFile[] = [];
  const dataFiles: ValidatedArchiveFile[] = [];
  for (const entry of entries) {
    const isManifest = entry.path === "modrinth.index.json" ||
      entry.path === "manifest.json";
    const isConfig = entry.path.startsWith("config/");
    const isData = entry.path.startsWith("data/");
    if (!isManifest && !isConfig && !isData) {
      reject(report, entry.path, "file_not_allowed");
      continue;
    }
    if (forbiddenExtensions.has(extension(entry.path))) {
      reject(report, entry.path, "executable_not_allowed");
      continue;
    }
    if (isConfig || isData) {
      const file = {
        path: entry.path,
        sha256: await sha256(entry.bytes),
        sizeBytes: entry.uncompressedSize,
        bytes: entry.bytes,
      };
      (isConfig ? configFiles : dataFiles).push(file);
      (isConfig ? report.configFiles : report.dataFiles).push(entry.path);
    }
  }

  let parsed: ParsedManifest | undefined;
  if (manifests.length === 1) {
    try {
      const json = parseJson(manifests[0].bytes);
      if (containsUrl(json)) reject(report, manifests[0].path, "arbitrary_url");
      parsed = manifests[0].path === "modrinth.index.json"
        ? parseMrpack(json)
        : parseCurseForge(json);
      report.sourceFormat = parsed.format;
      report.compatibility = parsed.compatibility;
    } catch (error) {
      reject(
        report,
        manifests[0].path,
        error instanceof Error ? error.message : "invalid_manifest",
      );
    }
  }

  const resolvedMods: ResolvedModSource[] = [];
  if (parsed) {
    for (const reference of parsed.mods) {
      const sourcePath =
        `mods/${reference.provider}/${reference.projectId}/${reference.fileId}`;
      if (
        (reference.provider !== "modrinth" &&
          reference.provider !== "curseforge") ||
        !reference.projectId || !reference.fileId
      ) {
        reject(report, sourcePath, "invalid_source");
        continue;
      }
      const resolver = input.resolvers.find((candidate) =>
        candidate.provider === reference.provider
      );
      if (!resolver) {
        reject(report, sourcePath, "provider_unavailable");
        continue;
      }
      try {
        const resolved = await resolver.resolve(reference);
        resolvedMods.push(resolved);
        report.mods.push({
          provider: resolved.provider,
          projectId: resolved.projectId,
          fileId: resolved.fileId,
          filename: resolved.filename,
          sha256: resolved.sha256,
        });
      } catch (error) {
        reject(
          report,
          sourcePath,
          error instanceof ModpackSourceError
            ? error.code
            : "provider_unavailable",
        );
      }
    }
  }

  report.configFiles.sort();
  report.dataFiles.sort();
  report.mods.sort((a, b) =>
    `${a.provider}:${a.projectId}:${a.fileId}`.localeCompare(
      `${b.provider}:${b.projectId}:${b.fileId}`,
    )
  );
  if (report.rejectedFiles.length === 0 && parsed) report.status = "valid";
  return { report, configFiles, dataFiles, resolvedMods };
}
