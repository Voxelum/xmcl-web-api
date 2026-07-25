import assert from "node:assert/strict";
import { createStoredZip, jsonBytes } from "./modpackTestFixtures.ts";
import { runtimeCatalog } from "./runtimeCatalog.ts";
import { validateXmclServerBundle } from "./xmclServerBundle.ts";

async function sha(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function artifactIntent(path: string) {
  if (path.startsWith("instance/mods/")) return "mod";
  if (path.startsWith("instance/config/")) return "config";
  if (path.startsWith("instance/kubejs/")) return "kubejs";
  if (path.startsWith("instance/scripts/")) return "script";
  return "resourcepack";
}

async function bundle(options: {
  catalogSha256?: string;
  includeScript?: boolean;
  includeEula?: boolean;
  includeLegacyServerArtifact?: boolean;
  wrongHash?: boolean;
} = {}) {
  const payload = [
    { path: "instance/config/server.cfg", bytes: jsonBytes({ dedicated: true }) },
    { path: "instance/mods/example.jar", bytes: new Uint8Array([1, 2, 3]) },
    { path: "instance/kubejs/server_scripts.js", bytes: jsonBytes("ServerEvents.recipes(() => {})") },
    { path: "instance/scripts/server.zs", bytes: jsonBytes('print("server")') },
    { path: "instance/resourcepacks/server-assets.zip", bytes: new Uint8Array([7, 8, 9]) },
  ];
  const artifacts = await Promise.all(payload.map(async (file) => ({
    path: file.path,
    sha256: await sha(file.bytes),
    sizeBytes: file.bytes.byteLength,
    intent: artifactIntent(file.path),
  })));
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const files = [
    ...payload,
    {
      path: "resolved/loader.json",
      bytes: jsonBytes({
        schemaVersion: 1,
        minecraftVersion: "1.21.1",
        loader: { kind: "fabric", version: "0.16.10" },
        javaRequirement: { component: "java-runtime-delta", major: 21 },
        runtimeCatalog: { sha256: options.catalogSha256 ?? runtimeCatalog.sha256 },
      }),
    },
    {
      path: "resolved/mods.json",
      bytes: jsonBytes(artifacts.filter((file) => file.intent === "mod").map(({ intent: _, ...file }) => file)),
    },
    {
      path: "resolved/artifacts.json",
      bytes: jsonBytes({ schemaVersion: 1, artifacts }),
    },
    {
      path: "resolved/version.json",
      bytes: jsonBytes({
        schemaVersion: 1,
        minecraftVersion: "1.21.1",
        javaVersion: { component: "java-runtime-delta", majorVersion: 21 },
      }),
    },
  ];
  if (options.includeScript) {
    files.push({ path: "instance/server.sh", bytes: jsonBytes("not runnable") });
  }
  if (options.includeEula) {
    files.push({ path: "instance/eula.txt", bytes: jsonBytes("eula=true") });
  }
  if (options.includeLegacyServerArtifact) {
    files.push({ path: "resolved/libraries/local-server.jar", bytes: new Uint8Array([10]) });
  }
  const manifestFiles = await Promise.all(files.map(async (file) => ({
    path: file.path,
    sha256: options.wrongHash && file.path === "instance/mods/example.jar"
      ? "0".repeat(64)
      : await sha(file.bytes),
    sizeBytes: file.bytes.byteLength,
  })));
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    instanceName: "Local pack",
    minecraftVersion: "1.21.1",
    loader: { kind: "fabric", version: "0.16.10" },
    javaRequirement: { component: "java-runtime-delta", major: 21 },
    runtimeCatalog: { sha256: options.catalogSha256 ?? runtimeCatalog.sha256 },
    files: manifestFiles,
  };
  return createStoredZip([
    { path: "bundle.json", bytes: jsonBytes(manifest) },
    ...files,
  ]);
}

Deno.test("validates a manifest-complete local server bundle", async () => {
  const validated = await validateXmclServerBundle({
    importId: "import_1",
    archive: await bundle(),
  });
  assert.equal(validated.report.status, "valid");
  assert.equal(validated.manifest?.loader.kind, "fabric");
  assert.equal(validated.configFiles.length, 1);
  assert.equal(validated.files.length, 9);
});

Deno.test("rejects catalog, hash, generated scripts, and legacy server artifacts", async () => {
  for (const archive of [
    await bundle({ catalogSha256: "0".repeat(64) }),
    await bundle({ wrongHash: true }),
    await bundle({ includeScript: true }),
    await bundle({ includeEula: true }),
    await bundle({ includeLegacyServerArtifact: true }),
  ]) {
    const validated = await validateXmclServerBundle({
      importId: "import_1",
      archive,
    });
    assert.equal(validated.report.status, "invalid");
  }
});
