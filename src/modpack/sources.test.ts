// deno-lint-ignore-file require-await

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CurseForgeSourceResolver } from "./curseforge.ts";
import { ModrinthSourceResolver } from "./modrinth.ts";
import { ModpackSourceError } from "./types.ts";

Deno.test("provider defaults preserve the runtime fetch receiver", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = function (this: typeof globalThis, input) {
    assert.equal(this, globalThis);
    const url = String(input);
    if (url.includes("modrinth")) {
      return Promise.resolve(Response.json({
        project_id: "project-a",
        id: "version-a",
        files: [{
          filename: "example.jar",
          url:
            "https://cdn.modrinth.com/data/project-a/versions/version-a/example.jar",
          size: 100,
          hashes: { sha256: "a".repeat(64) },
        }],
      }));
    }
    return Promise.resolve(Response.json({
      data: {
        id: 2,
        modId: 1,
        fileName: "example.jar",
        downloadUrl: "https://edge.forgecdn.net/files/1/2/example.jar",
        fileLength: 100,
        hashes: [{ algo: 3, value: "b".repeat(64) }],
      },
    }));
  } as typeof fetch;
  try {
    await new ModrinthSourceResolver().resolve({
      provider: "modrinth",
      projectId: "project-a",
      fileId: "version-a",
      filename: "example.jar",
    });
    await new CurseForgeSourceResolver("key").resolve({
      provider: "curseforge",
      projectId: "1",
      fileId: "2",
      filename: "example.jar",
    });
  } finally {
    globalThis.fetch = previous;
  }
});

Deno.test("Modrinth resolver binds project/file IDs and allow-listed CDN artifacts", async () => {
  const resolver = new ModrinthSourceResolver(async () =>
    Response.json({
      project_id: "project-a",
      id: "version-a",
      files: [{
        filename: "example.jar",
        url:
          "https://cdn.modrinth.com/data/project-a/versions/version-a/example.jar",
        size: 100,
        hashes: { sha256: "a".repeat(64) },
      }],
    })
  );
  const result = await resolver.resolve({
    provider: "modrinth",
    projectId: "project-a",
    fileId: "version-a",
    filename: "example.jar",
  });
  assert.equal(result.sha256, "a".repeat(64));
  assert.equal(result.sizeBytes, 100);
});

Deno.test("Modrinth resolver securely derives sha256 when real metadata only has sha1 and sha512", async () => {
  const bytes = new Uint8Array(3_160_490);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const hashes = {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  };
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const downloadUrl =
    "https://cdn.modrinth.com/data/R2OftAxM/versions/XTVZDOol/FarmersDelight.jar";
  let downloads = 0;
  const resolver = new ModrinthSourceResolver(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/version/XTVZDOol")) {
      return Response.json({
        project_id: "R2OftAxM",
        id: "XTVZDOol",
        files: [{
          filename: "FarmersDelight.jar",
          url: downloadUrl,
          size: bytes.byteLength,
          hashes,
        }],
      });
    }
    assert.equal(url, downloadUrl);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
    downloads += 1;
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-encoding": "identity",
      },
    });
  });

  const result = await resolver.resolve({
    provider: "modrinth",
    projectId: "R2OftAxM",
    fileId: "XTVZDOol",
    filename: "FarmersDelight.jar",
  });
  assert.equal(downloads, 1);
  assert.equal(result.sha256, expectedSha256);
  assert.equal(result.sizeBytes, 3_160_490);
  assert.equal(result.downloadUrl, downloadUrl);
});

Deno.test("Modrinth sha256 derivation rejects provider hash and transport mismatches", async () => {
  const bytes = new TextEncoder().encode("provider bytes");
  const downloadUrl =
    "https://cdn.modrinth.com/data/R2OftAxM/versions/XTVZDOol/FarmersDelight.jar";
  for (const response of [
    new Response(bytes, {
      headers: { "content-length": String(bytes.byteLength + 1) },
    }),
    new Response(bytes, {
      headers: {
        "content-length": String(bytes.byteLength),
        "content-encoding": "gzip",
      },
    }),
    new Response(bytes, {
      headers: { "content-length": String(bytes.byteLength) },
    }),
  ]) {
    let request = 0;
    const resolver = new ModrinthSourceResolver(async () => {
      request += 1;
      if (request === 1) {
        return Response.json({
          project_id: "R2OftAxM",
          id: "XTVZDOol",
          files: [{
            filename: "FarmersDelight.jar",
            url: downloadUrl,
            size: bytes.byteLength,
            hashes: {
              sha1: createHash("sha1").update(bytes).digest("hex"),
              sha512: "0".repeat(128),
            },
          }],
        });
      }
      return response;
    });
    await assert.rejects(
      () =>
        resolver.resolve({
          provider: "modrinth",
          projectId: "R2OftAxM",
          fileId: "XTVZDOol",
          filename: "FarmersDelight.jar",
        }),
      (error) =>
        error instanceof ModpackSourceError &&
        error.code === "source_mismatch",
    );
  }
});

Deno.test("provider adapters reject non-provider download hosts", async () => {
  const resolver = new ModrinthSourceResolver(async () =>
    Response.json({
      project_id: "project-a",
      id: "version-a",
      files: [{
        filename: "example.jar",
        url: "https://attacker.invalid/example.jar",
        size: 100,
        hashes: { sha256: "a".repeat(64) },
      }],
    })
  );
  await assert.rejects(
    () =>
      resolver.resolve({
        provider: "modrinth",
        projectId: "project-a",
        fileId: "version-a",
        filename: "example.jar",
      }),
    (error) =>
      error instanceof ModpackSourceError &&
      error.code === "unsafe_provider_url",
  );
});

Deno.test("CurseForge provider failures are normalized without exposing secrets", async () => {
  let observedKey = "";
  const resolver = new CurseForgeSourceResolver(
    "fixture-key",
    async (_input, init) => {
      observedKey = new Headers(init?.headers).get("x-api-key") ?? "";
      return new Response(null, { status: 503 });
    },
  );
  await assert.rejects(
    () =>
      resolver.resolve({
        provider: "curseforge",
        projectId: "10",
        fileId: "20",
        filename: "",
      }),
    (error) =>
      error instanceof ModpackSourceError &&
      error.code === "provider_unavailable" &&
      !error.message.includes("fixture-key"),
  );
  assert.equal(observedKey, "fixture-key");
});
