import assert from "node:assert/strict";
import { S3SigV4Presigner } from "./s3SigV4.ts";
import { S3SharedModdedArchiveStore } from "./sharedModdedS3Archive.ts";

const bytes = new TextEncoder().encode("verified modpack bytes");
const sha256 = [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes),
)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("shared modded archive storage issues an exact immutable upload and verifies server downloads", async () => {
  const signer = new S3SigV4Presigner({
    endpoint: "https://tpe1.vultrobjects.com",
    region: "tpe1",
    bucket: "shared",
    accessKey: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  });
  const store = new S3SharedModdedArchiveStore(
    signer,
    async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      }),
  );
  const input = {
    importId: "import_1",
    key: "shared-hosting/account_1/service_1/compiler-inputs/import_1.xmcl-server-bundle",
    sourceFormat: "xmcl_server_bundle" as const,
    expectedSha256: sha256,
    expectedSizeBytes: bytes.byteLength,
  };
  const upload = await store.createUpload(input);
  assert.equal(upload.maxSizeBytes, bytes.byteLength);
  assert.deepEqual(upload.headers, {
    "if-none-match": "*",
    "x-amz-meta-sha256": sha256,
  });
  assert.match(upload.uploadUrl, /X-Amz-SignedHeaders=host%3Bif-none-match%3Bx-amz-meta-sha256/);
  assert.deepEqual(await store.readVerified(input), bytes);
});
