import {
  assertProviderDownloadUrl,
  assertProviderFilename,
  ModpackSourceError,
  type ModpackSourceResolver,
  type ModSourceReference,
  type ResolvedModSource,
} from "./types.ts";

interface CurseForgeFileResponse {
  data?: {
    id?: number;
    modId?: number;
    fileName?: string;
    downloadUrl?: string;
    fileLength?: number;
    hashes?: Array<{ algo?: number; value?: string }>;
  };
}

export class CurseForgeSourceResolver implements ModpackSourceResolver {
  readonly provider = "curseforge" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiBase = "https://api.curseforge.com/v1",
  ) {}

  async resolve(reference: ModSourceReference): Promise<ResolvedModSource> {
    if (
      reference.provider !== this.provider ||
      !/^\d+$/.test(reference.projectId) ||
      !/^\d+$/.test(reference.fileId) || !this.apiKey
    ) {
      throw new ModpackSourceError("invalid_source", this.provider);
    }

    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBase}/mods/${reference.projectId}/files/${reference.fileId}`,
        {
          headers: {
            accept: "application/json",
            "x-api-key": this.apiKey,
          },
        },
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

    let payload: CurseForgeFileResponse;
    try {
      payload = await response.json() as CurseForgeFileResponse;
    } catch {
      throw new ModpackSourceError("provider_unavailable", this.provider);
    }
    const file = payload.data;
    const sha256 = file?.hashes?.find((hash) => hash.algo === 3)?.value;
    if (
      String(file?.modId) !== reference.projectId ||
      String(file?.id) !== reference.fileId ||
      (reference.filename && file?.fileName !== reference.filename) ||
      !file?.fileName || !file.downloadUrl ||
      !sha256 || !/^[a-f0-9]{64}$/i.test(sha256) ||
      !Number.isSafeInteger(file.fileLength) || (file.fileLength ?? 0) <= 0
    ) {
      throw new ModpackSourceError("source_mismatch", this.provider);
    }
    return {
      ...reference,
      filename: assertProviderFilename(file.fileName, this.provider),
      sha256: sha256.toLowerCase(),
      sizeBytes: file.fileLength!,
      downloadUrl: assertProviderDownloadUrl(
        file.downloadUrl,
        this.provider,
        ["forgecdn.net"],
      ),
    };
  }
}
