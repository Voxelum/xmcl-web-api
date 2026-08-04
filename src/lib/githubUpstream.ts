export type GitHubResource =
  | "release_changelog"
  | "releases"
  | "notifications"
  | "workflow_artifacts"
  | "workflow_runs";

export interface GitHubFetchOptions {
  resource: GitHubResource;
  token?: string;
  freshForMs: number;
  staleForMs: number;
  cacheNotFoundForMs?: number;
  api?: boolean;
}

interface CachedResponse {
  status: number;
  body: string;
  contentType?: string;
  etag?: string;
}

interface CacheEntry {
  response?: CachedResponse;
  freshUntil: number;
  staleUntil: number;
  blockedUntil: number;
  failureStatus?: number;
  inFlight?: Promise<CachedResponse>;
}

interface SafeLogger {
  warn(value: unknown): void;
}

const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 256;

export class GitHubUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number,
  ) {
    super("GitHub upstream is temporarily unavailable");
    this.name = "GitHubUpstreamError";
  }

  retryAfterSeconds(now = Date.now()) {
    return Math.max(1, Math.ceil((this.retryAt - now) / 1000));
  }
}

/**
 * A small isolate-local cache protects GitHub from launcher fan-out. Successful
 * responses are conditionally revalidated, concurrent misses share one fetch,
 * and stale data remains available while GitHub is rate limited.
 */
export class GitHubUpstreamClient {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly hostCooldowns = new Map<
    string,
    { status: number; until: number }
  >();

  constructor(
    private readonly fetchImpl: typeof fetch | undefined = undefined,
    private readonly now: () => number = Date.now,
    private readonly logger: SafeLogger = console,
  ) {}

  async fetch(url: string, options: GitHubFetchOptions): Promise<Response> {
    const key = url;
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry?.response && now < entry.freshUntil) {
      return toResponse(entry.response);
    }

    const host = new URL(url).hostname;
    const hostCooldown = this.hostCooldowns.get(host);
    if (hostCooldown && now < hostCooldown.until) {
      if (entry?.response && now < entry.staleUntil) {
        return toResponse(entry.response);
      }
      throw new GitHubUpstreamError(hostCooldown.status, hostCooldown.until);
    }
    if (hostCooldown) this.hostCooldowns.delete(host);

    if (!entry) {
      if (!this.evictIfNeeded()) {
        throw new GitHubUpstreamError(
          503,
          now + DEFAULT_FAILURE_COOLDOWN_MS,
        );
      }
      entry = {
        freshUntil: 0,
        staleUntil: 0,
        blockedUntil: 0,
      };
      this.entries.set(key, entry);
    }

    if (now < entry.blockedUntil) {
      if (entry.response && now < entry.staleUntil) {
        return toResponse(entry.response);
      }
      throw new GitHubUpstreamError(
        entry.failureStatus ?? 503,
        entry.blockedUntil,
      );
    }

    if (!entry.inFlight) {
      entry.inFlight = this.load(url, options, entry)
        .finally(() => {
          entry.inFlight = undefined;
        });
    }
    return toResponse(await entry.inFlight);
  }

  private async load(
    url: string,
    options: GitHubFetchOptions,
    entry: CacheEntry,
  ): Promise<CachedResponse> {
    const headers = new Headers({
      "Accept": "application/vnd.github+json",
      "User-Agent": "xmcl-web-api",
    });
    if (options.api !== false) {
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    }
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }
    if (entry.response?.etag) {
      headers.set("If-None-Match", entry.response.etag);
    }

    let response: Response;
    try {
      response = await (this.fetchImpl ?? fetch)(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return this.failOrUseStale(entry, options.resource, url, 503);
    }

    const now = this.now();
    if (response.status === 304 && entry.response) {
      entry.freshUntil = now + options.freshForMs;
      entry.staleUntil = Math.max(
        entry.staleUntil,
        now + options.staleForMs,
      );
      entry.blockedUntil = 0;
      entry.failureStatus = undefined;
      await response.body?.cancel().catch(() => {});
      return entry.response;
    }

    if (response.ok) {
      let cached: CachedResponse;
      try {
        cached = await snapshot(response);
      } catch {
        return this.failOrUseStale(entry, options.resource, url, 503);
      }
      entry.response = cached;
      entry.freshUntil = now + options.freshForMs;
      entry.staleUntil = now + options.staleForMs;
      entry.blockedUntil = 0;
      entry.failureStatus = undefined;
      return cached;
    }

    if (response.status === 404) {
      let cached: CachedResponse;
      try {
        cached = await snapshot(response);
      } catch {
        return this.failOrUseStale(entry, options.resource, url, 503);
      }
      const freshFor = Math.max(0, options.cacheNotFoundForMs ?? 0);
      entry.response = cached;
      entry.freshUntil = now + freshFor;
      entry.staleUntil = now + Math.max(freshFor, options.staleForMs);
      entry.blockedUntil = 0;
      entry.failureStatus = undefined;
      return cached;
    }

    const status = response.status;
    const blockedUntil = githubRetryAt(response, now);
    await response.body?.cancel().catch(() => {});
    entry.blockedUntil = blockedUntil;
    entry.failureStatus = status;
    if (status === 403 || status === 429) {
      const host = new URL(url).hostname;
      const existing = this.hostCooldowns.get(host);
      if (!existing || blockedUntil > existing.until) {
        this.hostCooldowns.set(host, {
          status,
          until: blockedUntil,
        });
      }
    }
    this.logger.warn({
      event: status === 403 || status === 429
        ? "github.upstream.rate_limited"
        : "github.upstream.unavailable",
      resource: options.resource,
      host: new URL(url).hostname,
      status,
      retryAt: new Date(blockedUntil).toISOString(),
    });
    return this.staleOrThrow(entry, status, blockedUntil);
  }

  private failOrUseStale(
    entry: CacheEntry,
    resource: GitHubResource,
    url: string,
    status: number,
  ) {
    const blockedUntil = this.now() + DEFAULT_FAILURE_COOLDOWN_MS;
    entry.blockedUntil = blockedUntil;
    entry.failureStatus = status;
    this.logger.warn({
      event: "github.upstream.unavailable",
      resource,
      host: new URL(url).hostname,
      status,
      retryAt: new Date(blockedUntil).toISOString(),
    });
    return this.staleOrThrow(entry, status, blockedUntil);
  }

  private staleOrThrow(
    entry: CacheEntry,
    status: number,
    blockedUntil: number,
  ) {
    if (entry.response && this.now() < entry.staleUntil) {
      return entry.response;
    }
    throw new GitHubUpstreamError(status, blockedUntil);
  }

  private evictIfNeeded() {
    if (this.entries.size < MAX_CACHE_ENTRIES) return true;
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}

function githubRetryAt(response: Response, now: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  let retryAt = now + DEFAULT_FAILURE_COOLDOWN_MS;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    retryAt = now + retryAfter * 1000;
  } else if (
    Number.isFinite(reset) && reset > 0 && reset * 1000 > now
  ) {
    retryAt = reset * 1000;
  }
  return Math.min(retryAt, now + MAX_RATE_LIMIT_COOLDOWN_MS);
}

async function snapshot(response: Response): Promise<CachedResponse> {
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? undefined,
    etag: response.headers.get("etag") ?? undefined,
  };
}

function toResponse(cached: CachedResponse) {
  const headers = new Headers();
  if (cached.contentType) headers.set("content-type", cached.contentType);
  if (cached.etag) headers.set("etag", cached.etag);
  return new Response(cached.body, {
    status: cached.status,
    headers,
  });
}

export const githubUpstream = new GitHubUpstreamClient();
