import {
  assertProviderDownloadUrl,
  assertProviderFilename,
  ModpackSourceError,
  type ModpackSourceResolver,
  type ModSourceReference,
  type ResolvedModSource,
} from "./types.ts";

interface ModrinthVersion {
  project_id?: string;
  id?: string;
  files?: Array<{
    filename?: string;
    url?: string;
    size?: number;
    hashes?: { sha256?: string };
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
        { headers: { accept: "application/json" } },
      );
    } catch {
      throw new ModpackSourceError("provider_unavailable", this.provider);
    }
    if (response.status === 404) {
      throw new ModpackSourceError("source_not_found", this.provider);
    }
    if (!response.ok) {
      throw new ModpackSourceError("provider_unavailable", this.provider);
    }

    let version: ModrinthVersion;
    try {
      version = await response.json() as ModrinthVersion;
    } catch {
      throw new ModpackSourceError("provider_unavailable", this.provider);
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
    if (
      !file?.url || !file.hashes?.sha256 ||
      !/^[a-f0-9]{64}$/i.test(file.hashes.sha256) ||
      !Number.isSafeInteger(file.size) || (file.size ?? 0) <= 0
    ) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    return {
      ...reference,
      filename: assertProviderFilename(file.filename!, this.provider),
      sha256: file.hashes.sha256.toLowerCase(),
      sizeBytes: file.size!,
      downloadUrl: assertProviderDownloadUrl(
        file.url,
        this.provider,
        ["cdn.modrinth.com"],
      ),
    };
  }
}
