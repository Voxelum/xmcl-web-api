// deno-lint-ignore-file require-await

import assert from "node:assert/strict";
import { readModpackZip } from "./modpackImport.ts";
import {
  createStoredZip,
  jsonBytes,
  validMrpackManifest,
} from "./modpackTestFixtures.ts";
import { validateModpackArchive } from "./modpackValidator.ts";
import {
  ModpackSourceError,
  type ModpackSourceResolver,
} from "./modpackSources/types.ts";

const resolver: ModpackSourceResolver = {
  provider: "modrinth",
  async resolve(reference) {
    return {
      ...reference,
      sha256: "a".repeat(64),
      sizeBytes: 1234,
      downloadUrl:
        "https://cdn.modrinth.com/data/project-a/versions/version-a/example.jar",
    };
  },
};

Deno.test("accepts only manifest/config/data and resolves mods by provider IDs", async () => {
  const result = await validateModpackArchive({
    importId: "mpi_valid",
    archive: createStoredZip([
      { path: "modrinth.index.json", bytes: jsonBytes(validMrpackManifest) },
      { path: "config/server.properties", bytes: jsonBytes({ online: true }) },
      {
        path: "data/example/tags/functions/test.json",
        bytes: jsonBytes({ values: [] }),
      },
    ]),
    resolvers: [resolver],
  });

  assert.equal(result.report.status, "valid");
  assert.deepEqual(result.report.configFiles, ["config/server.properties"]);
  assert.equal(result.report.mods[0].projectId, "project-a");
  assert.equal(result.report.mods[0].fileId, "version-a");
  assert.equal(result.configFiles[0].sha256.length, 64);
  assert.equal(
    result.resolvedMods[0].downloadUrl.startsWith("https://cdn.modrinth.com/"),
    true,
  );
});

Deno.test("parses CurseForge project/file IDs without accepting uploaded mods", async () => {
  const curseResolver: ModpackSourceResolver = {
    provider: "curseforge",
    async resolve(reference) {
      return {
        ...reference,
        filename: "curse-example.jar",
        sha256: "b".repeat(64),
        sizeBytes: 4321,
        downloadUrl: "https://edge.forgecdn.net/files/1/2/curse-example.jar",
      };
    },
  };
  const result = await validateModpackArchive({
    importId: "mpi_curse",
    archive: createStoredZip([{
      path: "manifest.json",
      bytes: jsonBytes({
        minecraft: {
          version: "1.20.1",
          modLoaders: [{ id: "forge-47.3.0", primary: true }],
        },
        xmcl: { javaMajor: 17, templateId: "forge-1.20" },
        files: [{ projectID: 10, fileID: 20 }],
      }),
    }]),
    resolvers: [curseResolver],
  });
  assert.equal(result.report.status, "valid");
  assert.deepEqual(result.report.mods[0], {
    provider: "curseforge",
    projectId: "10",
    fileId: "20",
    filename: "curse-example.jar",
    sha256: "b".repeat(64),
  });
});

Deno.test("rejects executables, scripts, uploaded jars, arbitrary paths and manifest URLs", async () => {
  const withUrl = {
    ...validMrpackManifest,
    files: [{
      ...validMrpackManifest.files[0],
      downloads: ["https://attacker.invalid/example.jar"],
    }],
  };
  const result = await validateModpackArchive({
    importId: "mpi_unsafe",
    archive: createStoredZip([
      { path: "modrinth.index.json", bytes: jsonBytes(withUrl) },
      { path: "mods/uploaded.jar", bytes: Uint8Array.of(1) },
      { path: "config/start.ps1", bytes: Uint8Array.of(2) },
      { path: "data/native.dll", bytes: Uint8Array.of(3) },
      { path: "overrides/options.txt", bytes: Uint8Array.of(4) },
    ]),
    resolvers: [resolver],
  });
  assert.equal(result.report.status, "invalid");
  assert.deepEqual(
    new Set(result.report.rejectedFiles.map((item) => item.reason)),
    new Set(["arbitrary_url", "file_not_allowed", "executable_not_allowed"]),
  );
});

Deno.test("rejects traversal, absolute, duplicate case-folded and symlink ZIP entries", async () => {
  const fixtures = [
    [createStoredZip([{ path: "../config/x" }]), "path_traversal"],
    [createStoredZip([{ path: "C:/config/x" }]), "absolute_path"],
    [
      createStoredZip([{ path: "config/a.txt" }, { path: "CONFIG/A.txt" }]),
      "duplicate_path",
    ],
    [createStoredZip([{ path: "config/link", unixMode: 0o120777 }]), "symlink"],
  ] as const;
  for (const [archive, reason] of fixtures) {
    const result = await validateModpackArchive({
      importId: `mpi_${reason}`,
      archive,
      resolvers: [],
    });
    assert.equal(result.report.rejectedFiles[0].reason, reason);
  }
});

Deno.test("enforces archive, entry, total, count, and compression-ratio limits", async () => {
  const archive = createStoredZip([
    { path: "config/a", bytes: Uint8Array.of(1, 2) },
    { path: "data/b", bytes: Uint8Array.of(3, 4) },
  ]);
  const base = {
    maxArchiveBytes: 10_000,
    maxEntries: 10,
    maxEntryBytes: 10,
    maxTotalUncompressedBytes: 10,
    maxCompressionRatio: 10,
  };
  const cases = [
    [{ ...base, maxArchiveBytes: archive.length - 1 }, "archive_too_large"],
    [{ ...base, maxEntries: 1 }, "too_many_entries"],
    [{ ...base, maxEntryBytes: 1 }, "entry_too_large"],
    [{ ...base, maxTotalUncompressedBytes: 3 }, "total_size_exceeded"],
    [{ ...base, maxCompressionRatio: 0.5 }, "compression_ratio_exceeded"],
  ] as const;
  for (const [limits, code] of cases) {
    await assert.rejects(() => readModpackZip(archive, limits), (error) => {
      assert.equal((error as { code: string }).code, code);
      return true;
    });
  }
});

Deno.test("rejects unsupported ZIP compression before reading entry content", async () => {
  const result = await validateModpackArchive({
    importId: "mpi_bad_compression",
    archive: createStoredZip([{
      path: "config/value.txt",
      bytes: Uint8Array.of(1),
      compressionMethod: 99,
    }]),
    resolvers: [],
  });
  assert.equal(
    result.report.rejectedFiles[0].reason,
    "unsupported_compression",
  );
});

Deno.test("fails the whole report for unresolved and unavailable providers", async () => {
  for (const code of ["source_not_found", "provider_unavailable"] as const) {
    const failing: ModpackSourceResolver = {
      provider: "modrinth",
      resolve: () => Promise.reject(new ModpackSourceError(code, "modrinth")),
    };
    const result = await validateModpackArchive({
      importId: `mpi_${code}`,
      archive: createStoredZip([{
        path: "modrinth.index.json",
        bytes: jsonBytes(validMrpackManifest),
      }]),
      resolvers: [failing],
    });
    assert.equal(result.report.status, "invalid");
    assert.equal(result.report.rejectedFiles[0].reason, code);
    assert.equal(result.resolvedMods.length, 0);
  }
});
