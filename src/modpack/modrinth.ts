import { createHash } from "node:crypto";
import {
  assertProviderDownloadUrl,
  assertProviderFilename,
  ModpackSourceError,
  type ModpackSourceResolver,
  type ModSourceReference,
  type ResolvedModSource,
} from "./types.ts";

const maximumModBytes = 512 * 1024 * 1024;
const userAgent =
  "XMCL-Together-Camp/1.0 (https://github.com/Voxelum/xmcl-web-api)";

interface ModrinthFileHashes {
  sha1?: string;
  sha256?: string;
  sha512?: string;
}

interface ModrinthVersion {
  project_id?: string;
  id?: string;
  files?: Array<{
    filename?: string;
    url?: string;
    size?: number;
    hashes?: ModrinthFileHashes;
  }>;
}

export class ModrinthSourceResolver implements ModpackSourceResolver {
  readonly provider = "modrinth" as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiBase = "https://api.modrinth.com/v2",
  ) {}

  async resolve(reference: ModSourceReference): Promise<ResolvedModSource> {
    if (
      reference.provider !== this.provider || !reference.projectId ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(reference.projectId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(reference.fileId)
    ) {
      throw new ModpackSourceError("invalid_source", this.provider);
    }

    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBase}/version/${encodeURIComponent(reference.fileId)}`,
        {
          headers: {
            accept: "application/json",
            "user-agent": userAgent,
          },
        },
      );
    } catch {
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        "metadata_fetch_failed",
      );
    }
    if (response.status === 404) {
      throw new ModpackSourceError("source_not_found", this.provider);
    }
    if (!response.ok) {
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        `metadata_status_${response.status}`,
      );
    }

    let version: ModrinthVersion;
    try {
      version = await response.json() as ModrinthVersion;
    } catch {
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        "metadata_json_invalid",
      );
    }
    if (
      version.project_id !== reference.projectId ||
      version.id !== reference.fileId
    ) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    const file = reference.filename
      ? version.files?.find((candidate) =>
        candidate.filename === reference.filename
      )
      : version.files?.find((candidate) => candidate.filename && candidate.url);
    if (!file?.url || !Number.isSafeInteger(file.size) ||
      (file.size ?? 0) <= 0 || (file.size ?? 0) > maximumModBytes) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    const filename = assertProviderFilename(file.filename!, this.provider);
    const downloadUrl = assertProviderDownloadUrl(
      file.url,
      this.provider,
      ["cdn.modrinth.com"],
    );
    const sha256 = file.hashes?.sha256;
    const exactSha256 = sha256 && /^[a-f0-9]{64}$/i.test(sha256)
      ? sha256.toLowerCase()
      : await this.deriveSha256(downloadUrl, file.size!, file.hashes);
    return {
      ...reference,
      filename,
      sha256: exactSha256,
      sizeBytes: file.size!,
      downloadUrl,
    };
  }

  private async deriveSha256(
    downloadUrl: string,
    sizeBytes: number,
    hashes: ModrinthFileHashes | undefined,
  ) {
    const sha1 = hashes?.sha1;
    const sha512 = hashes?.sha512;
    if (
      (sha1 !== undefined && !/^[a-f0-9]{40}$/i.test(sha1)) ||
      (sha512 !== undefined && !/^[a-f0-9]{128}$/i.test(sha512)) ||
      (!sha1 && !sha512)
    ) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    let response: Response;
    try {
      response = await this.fetcher(downloadUrl, {
        method: "GET",
        headers: {
          accept: "application/octet-stream",
          "accept-encoding": "identity",
          "user-agent": userAgent,
        },
        redirect: "error",
      });
    } catch {
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        "artifact_fetch_failed",
      );
    }
    if (response.status === 404) {
      throw new ModpackSourceError("source_not_found", this.provider);
    }
    if (!response.ok || response.redirected ||
      (response.url && response.url !== downloadUrl)) {
      void response.body?.cancel("unsafe Modrinth response").catch(() => undefined);
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        `artifact_response_${response.status}`,
      );
    }
    const encoding = response.headers.get("content-encoding");
    const length = response.headers.get("content-length");
    if (
      (encoding && encoding.toLowerCase() !== "identity") ||
      !/^(?:0|[1-9]\d*)$/.test(length ?? "") ||
      Number(length) !== sizeBytes
    ) {
      void response.body?.cancel("Modrinth response metadata mismatch").catch(
        () => undefined,
      );
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ModpackSourceError(
        "provider_unavailable",
        this.provider,
        "artifact_body_missing",
      );
    }
    const digests = {
      sha1: sha1 ? createHash("sha1") : undefined,
      sha256: createHash("sha256"),
      sha512: sha512 ? createHash("sha512") : undefined,
    };
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new ModpackSourceError("provider_unavailable", this.provider);
        }
        total += next.value.byteLength;
        if (total > sizeBytes || total > maximumModBytes) {
          throw new ModpackSourceError("source_mismatch", this.provider);
        }
        digests.sha1?.update(next.value);
        digests.sha256.update(next.value);
        digests.sha512?.update(next.value);
      }
    } catch (error) {
      void reader.cancel("Modrinth response exceeded exact bounds").catch(
        () => undefined,
      );
      if (error instanceof ModpackSourceError) throw error;
      throw new ModpackSourceError("provider_unavailable", this.provider);
    } finally {
      reader.releaseLock();
    }
    if (
      total !== sizeBytes ||
      (sha1 && digests.sha1!.digest("hex") !== sha1.toLowerCase()) ||
      (sha512 && digests.sha512!.digest("hex") !== sha512.toLowerCase())
    ) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    return digests.sha256.digest("hex");
  }
}
