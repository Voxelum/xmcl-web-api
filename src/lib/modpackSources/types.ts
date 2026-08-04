export type ModpackProvider = "modrinth" | "curseforge";

export interface ModSourceReference {
  provider: ModpackProvider;
  projectId: string;
  fileId: string;
  filename: string;
}

export interface ResolvedModSource extends ModSourceReference {
  sha256: string;
  sizeBytes: number;
  /**
   * Provider-controlled download URL. It is never accepted from an uploaded
   * manifest and must be allow-listed by the provider adapter.
   */
  downloadUrl: string;
}

export interface ModpackSourceResolver {
  readonly provider: ModpackProvider;
  resolve(reference: ModSourceReference): Promise<ResolvedModSource>;
}

export class ModpackSourceError extends Error {
  constructor(
    readonly code:
      | "invalid_source"
      | "source_not_found"
      | "source_mismatch"
      | "provider_unavailable"
      | "unsafe_provider_url",
    readonly provider: ModpackProvider,
    message = code,
  ) {
    super(message);
    this.name = "ModpackSourceError";
  }
}

export function assertProviderDownloadUrl(
  value: string,
  provider: ModpackProvider,
  allowedHosts: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModpackSourceError("unsafe_provider_url", provider);
  }
  if (
    url.protocol !== "https:" ||
    !allowedHosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  ) {
    throw new ModpackSourceError("unsafe_provider_url", provider);
  }
  return url.toString();
}

export function assertProviderFilename(
  value: string,
  provider: ModpackProvider,
): string {
  if (
    !value || value.length > 255 || value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") || !value.toLowerCase().endsWith(".jar")
  ) {
    throw new ModpackSourceError("source_mismatch", provider);
  }
  return value;
}
