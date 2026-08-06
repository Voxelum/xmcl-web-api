// deno-lint-ignore-file require-await

import assert from "node:assert/strict";
import { CurseForgeSourceResolver } from "./curseforge.ts";
import { ModrinthSourceResolver } from "./modrinth.ts";
import { ModpackSourceError } from "./types.ts";

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
