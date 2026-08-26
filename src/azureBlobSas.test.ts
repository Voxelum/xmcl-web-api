import { AzureBlobSasError, AzureBlobSasSigner } from "./azureBlobSas.ts";

const accountKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const now = new Date("2026-08-26T12:00:00.000Z");

Deno.test("Azure Blob signer issues bounded immutable grants", async () => {
  const signer = new AzureBlobSasSigner({
    endpoint: "https://xmclcampstaging.blob.core.windows.net",
    container: "camp-staging",
    accountName: "xmclcampstaging",
    accountKey,
    now: () => now,
  });
  const grant = await signer.presign(
    "shared-hosting/account/service/revisions/1/manifest.json",
    "PUT",
    600,
  );
  const url = new URL(grant.url);
  if (
    url.hostname !== "xmclcampstaging.blob.core.windows.net" ||
    url.searchParams.get("sp") !== "cw" ||
    url.searchParams.get("spr") !== "https" ||
    url.searchParams.get("sr") !== "b" ||
    !url.searchParams.get("sig") ||
    grant.headers?.["if-none-match"] !== "*" ||
    grant.headers?.["x-ms-blob-type"] !== "BlockBlob"
  ) {
    throw new Error(`invalid immutable Azure grant: ${JSON.stringify(grant)}`);
  }
});

Deno.test("Azure Blob signer rejects foreign endpoint and excessive expiry", async () => {
  try {
    new AzureBlobSasSigner({
      endpoint: "https://objects.example.com",
      container: "camp-staging",
      accountName: "xmclcampstaging",
      accountKey,
    });
    throw new Error("foreign endpoint accepted");
  } catch (error) {
    if (!(error instanceof AzureBlobSasError)) throw error;
  }
  const signer = new AzureBlobSasSigner({
    endpoint: "https://xmclcampstaging.blob.core.windows.net",
    container: "camp-staging",
    accountName: "xmclcampstaging",
    accountKey,
  });
  try {
    await signer.presign("shared-hosting/a", "GET", 901);
    throw new Error("excessive expiry accepted");
  } catch (error) {
    if (!(error instanceof AzureBlobSasError)) throw error;
  }
});
