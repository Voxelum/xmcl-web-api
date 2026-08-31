import assert from "node:assert/strict";
import { createStoredZip, jsonBytes } from "./modpackTestFixtures.ts";
import { runtimeCatalog } from "./runtimeCatalog.ts";
import { validateXmclServerBundle } from "./xmclServerBundle.ts";
import type { ModpackSourceResolver } from "./modpack/types.ts";

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
  minecraftVersion?: string;
  includeScript?: boolean;
  includeEula?: boolean;
  includeLegacyServerArtifact?: boolean;
  wrongHash?: boolean;
  remoteMod?: {
    sha256: string;
    sizeBytes: number;
  };
} = {}) {
  const minecraftVersion = options.minecraftVersion ?? "26.2";
  const payload = [
    {
      path: "instance/config/server.cfg",
      bytes: jsonBytes({ dedicated: true }),
    },
    ...(options.remoteMod ? [] : [
      { path: "instance/mods/example.jar", bytes: new Uint8Array([1, 2, 3]) },
    ]),
    {
      path: "instance/kubejs/server_scripts.js",
      bytes: jsonBytes("ServerEvents.recipes(() => {})"),
    },
    { path: "instance/scripts/server.zs", bytes: jsonBytes('print("server")') },
    {
      path: "instance/resourcepacks/server-assets.zip",
      bytes: new Uint8Array([7, 8, 9]),
    },
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
        minecraftVersion,
        loader: { kind: "fabric", version: "0.19.3" },
        javaRequirement: { component: "java-runtime-epsilon", major: 25 },
        runtimeCatalog: {
          sha256: options.catalogSha256 ?? runtimeCatalog.sha256,
        },
      }),
    },
    {
      path: "resolved/mods.json",
      bytes: jsonBytes(
        options.remoteMod
          ? [{
            path: "instance/mods/example.jar",
            filename: "example.jar",
            sha256: options.remoteMod.sha256,
            sizeBytes: options.remoteMod.sizeBytes,
            source: {
              provider: "modrinth",
              projectId: "project-a",
              versionId: "version-a",
            },
          }]
          : artifacts.filter((file) => file.intent === "mod").map((
            { intent: _, ...file },
          ) => file),
      ),
    },
    {
      path: "resolved/artifacts.json",
      bytes: jsonBytes({ schemaVersion: 1, artifacts }),
    },
    {
      path: "resolved/version.json",
      bytes: jsonBytes({
        schemaVersion: 1,
        minecraftVersion,
        javaVersion: { component: "java-runtime-epsilon", majorVersion: 25 },
      }),
    },
  ];
  if (options.includeScript) {
    files.push({
      path: "instance/server.sh",
      bytes: jsonBytes("not runnable"),
    });
  }
  if (options.includeEula) {
    files.push({ path: "instance/eula.txt", bytes: jsonBytes("eula=true") });
  }
  if (options.includeLegacyServerArtifact) {
    files.push({
      path: "resolved/libraries/local-server.jar",
      bytes: new Uint8Array([10]),
    });
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
    minecraftVersion,
    loader: { kind: "fabric", version: "0.19.3" },
    javaRequirement: { component: "java-runtime-epsilon", major: 25 },
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
  assert.equal(validated.manifest?.minecraftVersion, "26.2");
  assert.equal(validated.manifest?.javaRequirement.major, 25);
  assert.equal(validated.manifest?.loader.kind, "fabric");
  assert.equal(validated.configFiles.length, 1);
  assert.equal(validated.files.length, 9);
});

Deno.test("rejects catalog, hash, generated scripts, and legacy server artifacts", async () => {
  for (
    const archive of [
      await bundle({ catalogSha256: "0".repeat(64) }),
      await bundle({ wrongHash: true }),
      await bundle({ includeScript: true }),
      await bundle({ includeEula: true }),
      await bundle({ includeLegacyServerArtifact: true }),
    ]
  ) {
    const validated = await validateXmclServerBundle({
      importId: "import_1",
      archive,
    });
    assert.equal(validated.report.status, "invalid");
  }
});

Deno.test("rejects unsafe and unreviewed Minecraft version identifiers", async () => {
  for (
    const minecraftVersion of [
      " 26.2",
      "26.2 ",
      "26.02",
      "../26.2",
      "https://example.test/26.2",
      "26.2;cmd",
      "26.2\n",
      "26.3",
    ]
  ) {
    const validated = await validateXmclServerBundle({
      importId: "import_1",
      archive: await bundle({ minecraftVersion }),
    });
    assert.equal(validated.report.status, "invalid", minecraftVersion);
  }
});

Deno.test("resolves remote mods and rejects any local declaration mismatch", async () => {
  const expectedSha = "b".repeat(64);
  const resolver: ModpackSourceResolver = {
    provider: "modrinth",
    async resolve(reference) {
      return {
        ...reference,
        sha256: expectedSha,
        sizeBytes: 321,
        downloadUrl:
          "https://cdn.modrinth.com/data/project-a/versions/version-a/example.jar",
      };
    },
  };
  const valid = await validateXmclServerBundle({
    importId: "import_remote",
    archive: await bundle({
      remoteMod: { sha256: expectedSha, sizeBytes: 321 },
    }),
    resolvers: [resolver],
  });
  assert.equal(valid.report.status, "valid");
  assert.equal(valid.resolvedMods.length, 1);
  assert.equal(
    valid.manifest?.files.some((file) =>
      file.path === "instance/mods/example.jar"
    ),
    false,
  );

  const mismatch = await validateXmclServerBundle({
    importId: "import_remote_mismatch",
    archive: await bundle({
      remoteMod: { sha256: "c".repeat(64), sizeBytes: 321 },
    }),
    resolvers: [resolver],
  });
  assert.equal(mismatch.report.status, "invalid");
  assert.ok(
    mismatch.report.rejectedFiles.some((file) =>
      file.reason === "remote_mod_source_mismatch"
    ),
  );
});
