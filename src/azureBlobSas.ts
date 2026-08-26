const encoder = new TextEncoder();
const serviceVersion = "2023-11-03";

export interface AzureBlobSasConfig {
  endpoint: string;
  container: string;
  accountName: string;
  accountKey: string;
  now?: () => Date;
}

export interface AzureBlobSignedObject {
  key: string;
  method: "GET" | "PUT";
  url: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export class AzureBlobSasError extends Error {}

export class AzureBlobSasSigner {
  private readonly endpoint: URL;
  private readonly signingKey: Uint8Array;
  private readonly now: () => Date;

  constructor(private readonly config: AzureBlobSasConfig) {
    this.endpoint = validateConfig(config);
    this.signingKey = decodeBase64(config.accountKey);
    this.now = config.now ?? (() => new Date());
  }

  async presign(
    key: string,
    method: "GET" | "PUT",
    expiresInSeconds: number,
  ): Promise<AzureBlobSignedObject> {
    const signed = await this.presignObject(key, method, expiresInSeconds);
    return {
      key,
      method,
      url: signed.url,
      expiresAt: signed.expiresAt,
      ...(method === "PUT"
        ? {
          headers: {
            "if-none-match": "*",
            "x-ms-blob-type": "BlockBlob",
          },
        }
        : {}),
    };
  }

  async deleteExact(keys: readonly string[]) {
    for (const key of keys) {
      const signed = await this.presignObject(key, "DELETE", 60);
      const response = await fetch(signed.url, {
        method: "DELETE",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!response.ok && response.status !== 404) {
        throw new AzureBlobSasError("exact Azure Blob deletion failed");
      }
    }
  }

  private async presignObject(
    key: string,
    method: "GET" | "PUT" | "DELETE",
    expiresInSeconds: number,
  ) {
    if (!validObjectKey(key)) {
      throw new AzureBlobSasError("invalid Azure Blob object key");
    }
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 15 * 60
    ) {
      throw new AzureBlobSasError("invalid Azure Blob SAS expiry");
    }
    const now = this.now();
    const startsAt = azureTimestamp(new Date(now.getTime() - 5 * 60_000));
    const expiresAt = azureTimestamp(
      new Date(now.getTime() + expiresInSeconds * 1_000),
    );
    const permissions = method === "GET" ? "r" : method === "PUT" ? "cw" : "d";
    const canonicalResource =
      `/blob/${this.config.accountName}/${this.config.container}/${key}`;
    const stringToSign = [
      permissions,
      startsAt,
      expiresAt,
      canonicalResource,
      "",
      "",
      "https",
      serviceVersion,
      "b",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].join("\n");
    const signature = await hmacBase64(this.signingKey, stringToSign);
    const url = new URL(this.endpoint);
    url.pathname = `/${encodeURIComponent(this.config.container)}/${
      key.split("/").map(encodeURIComponent).join("/")
    }`;
    url.search = new URLSearchParams({
      sp: permissions,
      st: startsAt,
      se: expiresAt,
      spr: "https",
      sv: serviceVersion,
      sr: "b",
      sig: signature,
    }).toString();
    return { url: url.toString(), expiresAt };
  }
}

function azureTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createAzureBlobSasSigner(
  config?: Partial<AzureBlobSasConfig>,
): AzureBlobSasSigner | undefined {
  if (
    !config?.endpoint || !config.container || !config.accountName ||
    !config.accountKey
  ) {
    return undefined;
  }
  return new AzureBlobSasSigner(config as AzureBlobSasConfig);
}

function validateConfig(config: AzureBlobSasConfig) {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new AzureBlobSasError("invalid Azure Blob endpoint");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
    endpoint.hostname !== `${config.accountName}.blob.core.windows.net` ||
    !/^[a-z0-9]{3,24}$/.test(config.accountName) ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(config.container) ||
    config.container.includes("--")
  ) {
    throw new AzureBlobSasError("invalid Azure Blob signer configuration");
  }
  const keyBytes = decodeBase64(config.accountKey).length;
  if (keyBytes < 32 || keyBytes > 128) {
    throw new AzureBlobSasError("invalid Azure Blob account key");
  }
  return endpoint;
}

function validObjectKey(value: string) {
  return value.length > 0 && value.length <= 1_024 &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

async function hmacBase64(key: Uint8Array, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
  );
  return encodeBase64(signature);
}

function decodeBase64(value: string) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AzureBlobSasError("invalid Azure Blob account key");
  }
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
