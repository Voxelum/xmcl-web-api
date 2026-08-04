import {
  DEFAULT_MODPACK_ZIP_LIMITS,
  ModpackZipError,
  type ModpackZipLimits,
  readModpackZip,
} from "./modpackImport.ts";
import { isReviewedRuntimeToolchain, runtimeCatalog } from "./runtimeCatalog.ts";

export interface XmclServerBundleFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface XmclServerBundleManifest {
  schemaVersion: 1;
  instanceName: string;
  minecraftVersion: string;
  loader: { kind: "forge" | "fabric" | "neoforge" | "quilt"; version: string };
  javaRequirement: { component: string; major: number };
  runtimeCatalog: { sha256: string };
  files: XmclServerBundleFile[];
}

export interface XmclServerBundleValidationReport {
  importId: string;
  sourceFormat: "xmcl_server_bundle";
  status: "pending" | "valid" | "invalid";
  configFiles: string[];
  dataFiles: string[];
  mods: Array<{ path: string; sha256: string }>;
  rejectedFiles: Array<{ path: string; reason: string }>;
  compatibility?: {
    minecraftVersion: string;
    loader: "forge" | "fabric" | "neoforge" | "quilt";
    loaderVersion: string;
    java: { component: string; major: number };
    runtimeCatalog: { sha256: string };
  };
}

export interface ValidatedXmclServerBundle {
  report: XmclServerBundleValidationReport;
  manifest?: XmclServerBundleManifest;
  files: XmclServerBundleFile[];
  configFiles: XmclServerBundleFile[];
  dataFiles: XmclServerBundleFile[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const supportedInstanceRoots = [
  "instance/mods/",
  "instance/config/",
  "instance/defaultconfigs/",
  "instance/kubejs/",
  "instance/scripts/",
  "instance/datapacks/",
  "instance/global_packs/",
  "instance/openloader/",
  "instance/paxi/",
  "instance/resourcepacks/",
] as const;
const supportedRootFiles = new Set([
  "instance/server.properties",
  "instance/pack.toml",
  "instance/pack.mcmeta",
  "instance/server-icon.png",
]);
const resolvedFiles = new Set([
  "resolved/version.json",
  "resolved/loader.json",
  "resolved/artifacts.json",
  "resolved/mods.json",
]);

function reject(
  report: XmclServerBundleValidationReport,
  path: string,
  reason: string,
) {
  report.rejectedFiles.push({ path, reason });
}

export async function validateXmclServerBundle(input: {
  importId: string;
  archive: Uint8Array;
  limits?: ModpackZipLimits;
}): Promise<ValidatedXmclServerBundle> {
  const report: XmclServerBundleValidationReport = {
    importId: input.importId,
    sourceFormat: "xmcl_server_bundle",
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
      return { report, files: [], configFiles: [], dataFiles: [] };
    }
    throw error;
  }

  const bundleJson = entries.filter((entry) => entry.path === "bundle.json");
  if (bundleJson.length !== 1) {
    reject(report, "$archive", "bundle_manifest_count_invalid");
    return { report, files: [], configFiles: [], dataFiles: [] };
  }
  let manifest: XmclServerBundleManifest;
  try {
    manifest = parseManifest(bundleJson[0].bytes);
  } catch (error) {
    reject(
      report,
      "bundle.json",
      error instanceof Error ? error.message : "invalid_bundle_manifest",
    );
    return { report, files: [], configFiles: [], dataFiles: [] };
  }
  validateCompatibility(manifest, report);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const entry of entries) {
    if (entry.path === "bundle.json") continue;
    const file = listed.get(entry.path);
    if (!file) {
      reject(report, entry.path, "unmanifested_file");
      continue;
    }
    if (!isAllowedBundlePath(entry.path)) {
      reject(report, entry.path, "file_not_allowed");
      continue;
    }
    if (
      file.sizeBytes !== entry.uncompressedSize ||
      file.sha256 !== await sha256(entry.bytes)
    ) {
      reject(report, entry.path, "file_hash_mismatch");
      continue;
    }
    if (entry.path.startsWith("instance/mods/")) {
      report.mods.push({ path: entry.path, sha256: file.sha256 });
    } else if (
      entry.path.startsWith("instance/config/") ||
      entry.path.startsWith("instance/defaultconfigs/")
    ) {
      report.configFiles.push(entry.path);
    } else if (entry.path.startsWith("instance/")) {
      report.dataFiles.push(entry.path);
    }
  }
  for (const file of manifest.files) {
    if (!byPath.has(file.path)) reject(report, file.path, "manifest_file_missing");
  }
  for (const required of resolvedFiles) {
    if (!byPath.has(required)) reject(report, required, "required_resolved_metadata_missing");
  }
  validateResolvedMetadata(byPath, manifest, report);
  report.mods.sort((left, right) => left.path.localeCompare(right.path));
  report.configFiles.sort();
  report.dataFiles.sort();
  if (report.rejectedFiles.length === 0) report.status = "valid";
  const files = manifest.files.slice().sort((left, right) => comparePath(left.path, right.path));
  return {
    report,
    ...(report.status === "valid" ? { manifest } : {}),
    files,
    configFiles: files.filter((file) =>
      file.path.startsWith("instance/config/") ||
      file.path.startsWith("instance/defaultconfigs/")
    ),
    dataFiles: files.filter((file) =>
      file.path.startsWith("instance/") &&
      !file.path.startsWith("instance/mods/") &&
      !file.path.startsWith("instance/config/") &&
      !file.path.startsWith("instance/defaultconfigs/")
    ),
  };
}

function parseManifest(bytes: Uint8Array): XmclServerBundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("invalid_bundle_manifest");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid_bundle_manifest");
  }
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      ![
        "schemaVersion",
        "instanceName",
        "minecraftVersion",
        "loader",
        "javaRequirement",
        "runtimeCatalog",
        "files",
      ].includes(key)
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.instanceName !== "string" ||
    value.instanceName.length < 1 ||
    value.instanceName.length > 255 ||
    !validMinecraftVersion(value.minecraftVersion) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("invalid_bundle_manifest");
  }
  const loader = plainObject(value.loader);
  const java = plainObject(value.javaRequirement);
  const catalog = plainObject(value.runtimeCatalog);
  if (
    !loader ||
    !java ||
    !catalog ||
    Object.keys(loader).some((key) => key !== "kind" && key !== "version") ||
    Object.keys(java).some((key) => key !== "component" && key !== "major") ||
    Object.keys(catalog).some((key) => key !== "sha256") ||
    !["forge", "fabric", "neoforge", "quilt"].includes(loader.kind as string) ||
    !validLoaderVersion(loader.version) ||
    typeof java.component !== "string" ||
    !Number.isSafeInteger(java.major) ||
    typeof catalog.sha256 !== "string" ||
    !validSha256(catalog.sha256)
  ) {
    throw new Error("invalid_bundle_manifest");
  }
  const files: XmclServerBundleFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value.files) {
    const file = plainObject(candidate);
    if (
      !file ||
      Object.keys(file).some((key) =>
        key !== "path" && key !== "sha256" && key !== "sizeBytes"
      ) ||
      typeof file.path !== "string" ||
      !isAllowedBundlePath(file.path) ||
      typeof file.sha256 !== "string" ||
      !validSha256(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      (file.sizeBytes as number) < 0 ||
      seen.has(file.path.normalize("NFKC").toLocaleLowerCase("en-US"))
    ) {
      throw new Error("invalid_bundle_manifest");
    }
    seen.add(file.path.normalize("NFKC").toLocaleLowerCase("en-US"));
    files.push({
      path: file.path,
      sha256: file.sha256.toLowerCase(),
      sizeBytes: file.sizeBytes as number,
    });
  }
  if (
    files.length === 0 ||
    files.length > DEFAULT_MODPACK_ZIP_LIMITS.maxEntries ||
    !files.every((file, index) =>
      index === 0 || comparePath(files[index - 1].path, file.path) < 0
    )
  ) {
    throw new Error("invalid_bundle_manifest");
  }
  return {
    schemaVersion: 1,
    instanceName: value.instanceName,
    minecraftVersion: value.minecraftVersion as string,
    loader: {
      kind: loader.kind as XmclServerBundleManifest["loader"]["kind"],
      version: loader.version as string,
    },
    javaRequirement: {
      component: java.component as string,
      major: java.major as number,
    },
    runtimeCatalog: { sha256: catalog.sha256 as string },
    files,
  };
}

function validateCompatibility(
  manifest: XmclServerBundleManifest,
  report: XmclServerBundleValidationReport,
) {
  if (
    manifest.runtimeCatalog.sha256 !== runtimeCatalog.sha256 ||
    !isReviewedRuntimeToolchain({
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader,
      java: manifest.javaRequirement,
    }) ||
    (manifest.loader.kind === "neoforge" &&
      !minecraftAtLeast(manifest.minecraftVersion, 20, 2))
  ) {
    reject(report, "bundle.json", "unsupported_compatibility");
    return;
  }
  report.compatibility = {
    minecraftVersion: manifest.minecraftVersion,
    loader: manifest.loader.kind,
    loaderVersion: manifest.loader.version,
    java: { ...manifest.javaRequirement },
    runtimeCatalog: { ...manifest.runtimeCatalog },
  };
}

function validateResolvedMetadata(
  entries: Map<string, { bytes: Uint8Array }>,
  manifest: XmclServerBundleManifest,
  report: XmclServerBundleValidationReport,
) {
  const loader = entries.get("resolved/loader.json");
  const version = entries.get("resolved/version.json");
  const artifacts = entries.get("resolved/artifacts.json");
  if (!loader || !version || !artifacts) return;
  try {
    const loaderMetadata = JSON.parse(decoder.decode(loader.bytes)) as Record<string, unknown>;
    const versionMetadata = JSON.parse(decoder.decode(version.bytes)) as Record<string, unknown>;
    const metadataLoader = plainObject(loaderMetadata.loader);
    const metadataJava = plainObject(loaderMetadata.javaRequirement);
    const metadataVersionJava = plainObject(versionMetadata.javaVersion);
    if (
      loaderMetadata.minecraftVersion !== manifest.minecraftVersion ||
      metadataLoader?.kind !== manifest.loader.kind ||
      metadataLoader.version !== manifest.loader.version ||
      metadataJava?.component !== manifest.javaRequirement.component ||
      metadataJava.major !== manifest.javaRequirement.major ||
      metadataVersionJava?.component !== manifest.javaRequirement.component ||
      metadataVersionJava.majorVersion !== manifest.javaRequirement.major
    ) {
      reject(report, "resolved", "resolved_metadata_mismatch");
    }
    validateArtifactMetadata(artifacts.bytes, manifest);
  } catch {
    reject(report, "resolved", "invalid_resolved_metadata");
  }
}

function isAllowedBundlePath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /(?:^|\/)(?:server|start)\.(?:sh|bat|cmd)$/i.test(path)
  ) return false;
  return supportedRootFiles.has(path) ||
    supportedInstanceRoots.some((root) => path.startsWith(root)) ||
    resolvedFiles.has(path);
}

function validateArtifactMetadata(
  bytes: Uint8Array,
  manifest: XmclServerBundleManifest,
) {
  const raw = JSON.parse(decoder.decode(bytes)) as unknown;
  const metadata = plainObject(raw);
  if (!metadata ||
    Object.keys(metadata).some((key) => key !== "schemaVersion" && key !== "artifacts") ||
    metadata.schemaVersion !== 1 ||
    !Array.isArray(metadata.artifacts)
  ) throw new Error("invalid_artifact_metadata");
  const expected = manifest.files.filter((file) => file.path.startsWith("instance/"));
  if (metadata.artifacts.length !== expected.length) throw new Error("invalid_artifact_metadata");
  for (let index = 0; index < expected.length; index += 1) {
    const value = plainObject(metadata.artifacts[index]);
    const file = expected[index];
    if (
      !value ||
      Object.keys(value).some((key) =>
        key !== "intent" && key !== "path" && key !== "sha256" && key !== "sizeBytes"
      ) ||
      value.path !== file.path ||
      value.sha256 !== file.sha256 ||
      value.sizeBytes !== file.sizeBytes ||
      value.intent !== artifactIntent(file.path)
    ) throw new Error("invalid_artifact_metadata");
  }
}

function artifactIntent(path: string) {
  if (path.startsWith("instance/mods/")) return "mod";
  if (path.startsWith("instance/config/") || path.startsWith("instance/defaultconfigs/")) return "config";
  if (path.startsWith("instance/kubejs/")) return "kubejs";
  if (path.startsWith("instance/scripts/")) return "script";
  if (path.startsWith("instance/datapacks/")) return "datapack";
  if (path.startsWith("instance/global_packs/")) return "global-pack";
  if (path.startsWith("instance/openloader/")) return "openloader";
  if (path.startsWith("instance/paxi/")) return "paxi";
  if (path.startsWith("instance/resourcepacks/")) return "resourcepack";
  return "data";
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validLoaderVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value);
}

function validMinecraftVersion(value: unknown): value is string {
  return typeof value === "string" &&
    /^(?:1\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})|[1-9]\d{1,3}\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2}))?)$/.test(value);
}

function minecraftAtLeast(value: string, minor: number, patch: number) {
  const match = /^1\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
  return !!match && (
    Number(match[1]) > minor ||
    (Number(match[1]) === minor && Number(match[2]) >= patch)
  );
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function comparePath(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
