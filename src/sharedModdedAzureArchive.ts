import {
  SharedModdedArchiveVerificationError,
  type SharedModdedArchiveStore,
} from "./sharedModdedRuntime.ts";
import { type AzureBlobSasSigner } from "./azureBlobSas.ts";
const uploadExpirySeconds = 10 * 60;
const downloadExpirySeconds = 60;
const downloadTimeoutMs = 30_000;
const maximumArchiveBytes = 512 * 1024 * 1024;

/**
 * A narrow archive adapter: browser uploads receive one exact immutable PUT,
 * while validation fetches only that exact key through a short server-side GET.
 */
export class AzureSharedModdedArchiveStore implements SharedModdedArchiveStore {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly signer: AzureBlobSasSigner,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ??
      ((input, init) => globalThis.fetch(input, init));
  }

  async createUpload(input: {
    importId: string;
    key: string;
    sourceFormat: "mrpack" | "curseforge_zip" | "xmcl_server_bundle";
    expectedSha256: string;
    expectedSizeBytes: number;
  }) {
    validateExpected(input.expectedSha256, input.expectedSizeBytes);
    const signed = await this.signer.presign(
      input.key,
      "PUT",
      uploadExpirySeconds,
    );
    if (
      signed.key !== input.key || signed.method !== "PUT" ||
      signed.headers?.["if-none-match"] !== "*" ||
      signed.headers["x-ms-blob-type"] !== "BlockBlob"
    ) {
      throw new Error("exact Azure Blob archive upload signing failed");
    }
    return {
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt,
      maxSizeBytes: input.expectedSizeBytes,
      headers: signed.headers,
    };
  }

  async readVerified(input: {
    importId: string;
    key: string;
    sourceFormat: "mrpack" | "curseforge_zip" | "xmcl_server_bundle";
    expectedSha256: string;
    expectedSizeBytes: number;
  }) {
    validateExpected(input.expectedSha256, input.expectedSizeBytes);
    const signed = await this.signer.presign(
      input.key,
      "GET",
      downloadExpirySeconds,
    ).catch(() => {
      throw new SharedModdedArchiveVerificationError("signing_failed");
    });
    if (signed.key !== input.key || signed.method !== "GET" || signed.headers) {
      throw new SharedModdedArchiveVerificationError("signing_failed");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
      const response = await this.fetchImpl(signed.url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      }).catch(() => {
        throw new SharedModdedArchiveVerificationError("download_failed");
      });
      if (
        !response.ok || response.redirected ||
        (response.url && response.url !== signed.url)
      ) {
        throw new SharedModdedArchiveVerificationError("download_failed");
      }
      const declaredSize = response.headers.get("content-length");
      if (
        declaredSize === null || !/^(?:0|[1-9]\d*)$/.test(declaredSize) ||
        Number(declaredSize) !== input.expectedSizeBytes
      ) {
        throw new SharedModdedArchiveVerificationError("size_mismatch");
      }
      const bytes = await readExact(response, input.expectedSizeBytes).catch(
        (error) => {
          if (error instanceof SharedModdedArchiveVerificationError) throw error;
          throw new SharedModdedArchiveVerificationError("body_read_failed");
        },
      );
      const digest = hex(await crypto.subtle.digest("SHA-256", bytes).catch(
        () => {
          throw new SharedModdedArchiveVerificationError("digest_failed");
        },
      ));
      if (digest !== input.expectedSha256.toLowerCase()) {
        throw new SharedModdedArchiveVerificationError("hash_mismatch");
      }
      return bytes;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function validateExpected(expectedSha256: string, expectedSizeBytes: number) {
  if (
    !/^[a-f0-9]{64}$/i.test(expectedSha256) ||
    !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1 ||
    expectedSizeBytes > maximumArchiveBytes
  ) {
    throw new SharedModdedArchiveVerificationError("invalid_expected");
  }
}

async function readExact(response: Response, expectedSize: number) {
  if (!response.body) {
    throw new SharedModdedArchiveVerificationError("body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expectedSize || total > maximumArchiveBytes) {
        throw new SharedModdedArchiveVerificationError("size_exceeded");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedSize) {
    throw new SharedModdedArchiveVerificationError("size_mismatch");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
