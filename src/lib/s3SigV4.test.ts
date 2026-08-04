import assert from "node:assert/strict";
import { S3SigV4Presigner } from "./s3SigV4.ts";

const signer = new S3SigV4Presigner({
  endpoint: "https://tpe1.vultrobjects.com",
  region: "tpe1",
  bucket: "workspace-bucket",
  accessKey: "AKIDEXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  now: () => new Date("2026-07-24T00:00:00.000Z"),
});

Deno.test("Vultr SigV4 signer has a deterministic exact-object GET fixture", async () => {
  const grant = await signer.presign(
    "shared-hosting/account_1/service_1/revisions/1/manifest.json",
    "GET",
    600,
  );
  assert.equal(grant.method, "GET");
  assert.equal(grant.expiresAt, "2026-07-24T00:10:00.000Z");
  assert.equal(
    grant.url,
    "https://tpe1.vultrobjects.com/workspace-bucket/shared-hosting/account_1/service_1/revisions/1/manifest.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260724%2Ftpe1%2Fs3%2Faws4_request&X-Amz-Date=20260724T000000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=c10fc1d005ae1d79b47ab3485cddb056bc2b9c69155c1e5295024b7240c6449e",
  );
});

Deno.test("Vultr SigV4 PUT signs immutable-write header and bounded expiry", async () => {
  const grant = await signer.presign(
    "shared-hosting/account_1/service_1/content/abc.tar.zst",
    "PUT",
    600,
  );
  assert.deepEqual(grant.headers, { "if-none-match": "*" });
  assert.match(grant.url, /X-Amz-SignedHeaders=host%3Bif-none-match/);
  await assert.rejects(
    () => signer.presign("shared-hosting/a", "GET", 16 * 60),
  );
});
