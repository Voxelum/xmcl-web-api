/**
 * Minimal Web Crypto S3 SigV4 pre-signer for Vultr Object Storage.  It never
 * sends bytes or exposes the signing key to callers.
 */
const encoder = new TextEncoder();
const algorithm = "AWS4-HMAC-SHA256";
const service = "s3";

export interface S3SigV4Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  now?: () => Date;
}

export interface S3PresignedObject {
  key: string;
  method: "GET" | "PUT";
  url: string;
  expiresAt: string;
  /** Headers the recipient must send exactly as signed. */
  headers?: Record<string, string>;
}

export class S3SigV4Error extends Error {}

/**
 * A server-only signer binding.  The transfer broker receives only the URL,
 * never `accessKey` or `secretKey`.
 */
export class S3SigV4Presigner {
  private readonly endpoint: URL;
  private readonly now: () => Date;

  constructor(private readonly config: S3SigV4Config) {
    this.endpoint = validateConfig(config);
    this.now = config.now ?? (() => new Date());
  }

  async presign(
    key: string,
    method: "GET" | "PUT",
    expiresInSeconds: number,
  ): Promise<S3PresignedObject> {
    if (!validObjectKey(key)) throw new S3SigV4Error("invalid S3 object key");
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 15 * 60
    ) {
      throw new S3SigV4Error("invalid S3 URL expiry");
    }

    const now = this.now();
    const amzDate = amzTimestamp(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/${service}/aws4_request`;
    const headers = method === "PUT" ? { "if-none-match": "*" } : undefined;
    const canonicalHeaders = [
      `host:${this.endpoint.host.toLowerCase()}`,
      ...(headers ? ["if-none-match:*"] : []),
    ].join("\n") + "\n";
    const signedHeaders = headers ? "host;if-none-match" : "host";
    const query = canonicalQuery({
      "X-Amz-Algorithm": algorithm,
      "X-Amz-Credential": `${this.config.accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
    });
    const canonicalUri = `/${encodePathSegment(this.config.bucket)}/${
      key.split("/").map(encodePathSegment).join("/")
    }`;
    const canonicalRequest = [
      method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      algorithm,
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join("\n");
    const derivedKey = await deriveSigningKey(
      this.config.secretKey,
      dateStamp,
      this.config.region,
    );
    const signature = await hmacHex(derivedKey, stringToSign);
    const url = new URL(this.endpoint.toString());
    url.pathname = canonicalUri;
    url.search = `${query}&X-Amz-Signature=${signature}`;
    return {
      key,
      method,
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
      ...(headers ? { headers } : {}),
    };
  }
}

export function createS3SigV4Presigner(
  config?: Partial<S3SigV4Config>,
): S3SigV4Presigner | undefined {
  if (
    !config?.endpoint || !config.region || !config.bucket ||
    !config.accessKey || !config.secretKey
  ) {
    return undefined;
  }
  return new S3SigV4Presigner(config as S3SigV4Config);
}

function validateConfig(config: S3SigV4Config) {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new S3SigV4Error("invalid S3 endpoint");
  }
  if (
    endpoint.protocol !== "https:" || !endpoint.hostname ||
    endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash || endpoint.pathname !== "/"
  ) {
    throw new S3SigV4Error("S3 endpoint must be an HTTPS origin");
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{1,62}$/i.test(config.bucket) ||
    !/^[a-z0-9-]{1,32}$/i.test(config.region) ||
    !config.accessKey.trim() || !config.secretKey
  ) {
    throw new S3SigV4Error("invalid S3 signer configuration");
  }
  return endpoint;
}

function validObjectKey(value: string) {
  return value.length > 0 && value.length <= 1_024 &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

function canonicalQuery(values: Record<string, string>) {
  return Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join("&");
}

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodePathSegment(value: string) {
  return rfc3986(value);
}

function amzTimestamp(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function deriveSigningKey(secret: string, date: string, region: string) {
  const dateKey = await hmacBytes(`AWS4${secret}`, date);
  const regionKey = await hmacBytes(dateKey, region);
  const serviceKey = await hmacBytes(regionKey, service);
  return await hmacBytes(serviceKey, "aws4_request");
}

async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacHex(key: Uint8Array, value: string) {
  return hex(await hmacBytes(key, value));
}

async function hmacBytes(key: string | Uint8Array, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    (typeof key === "string" ? encoder.encode(key) : key) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
  );
}

function hex(value: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
