import assert from "node:assert/strict";
import { AzureBlobSasSigner } from "./azureBlobSas.ts";
import { AzureSharedModdedArchiveStore } from "./sharedModdedAzureArchive.ts";

const bytes = new TextEncoder().encode("verified modpack bytes");
const sha256 = [
  ...new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  ),
].map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("shared modded archive storage issues an exact immutable upload and verifies server downloads", async () => {
  const signer = new AzureBlobSasSigner({
    endpoint: "https://xmclcampstaging.blob.core.windows.net",
    container: "shared",
    accountName: "xmclcampstaging",
    accountKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  });
  const store = new AzureSharedModdedArchiveStore(
    signer,
    async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      }),
  );
  const input = {
    importId: "import_1",
    key:
      "shared-hosting/account_1/service_1/compiler-inputs/import_1.xmcl-server-bundle",
    sourceFormat: "xmcl_server_bundle" as const,
    expectedSha256: sha256,
    expectedSizeBytes: bytes.byteLength,
  };
  const upload = await store.createUpload(input);
  assert.equal(upload.maxSizeBytes, bytes.byteLength);
  assert.deepEqual(upload.headers, {
    "if-none-match": "*",
    "x-ms-blob-type": "BlockBlob",
  });
  assert.match(upload.uploadUrl, /[?&]sig=/);
  assert.deepEqual(await store.readVerified(input), bytes);
});
