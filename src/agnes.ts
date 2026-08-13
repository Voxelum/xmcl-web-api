export const AGNES_CHAT_COMPLETIONS_URL =
  "https://apihub.agnes-ai.com/v1/chat/completions";
export const DEFAULT_AGNES_MODEL = "agnes-2.5-flash";
export const DEEPSEEK_CHAT_COMPLETIONS_URL =
  "https://api.deepseek.com/v1/chat/completions";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const MAX_KEYS = 64;

export type AgnesFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const defaultAgnesFetch: AgnesFetch = (input, init) =>
  fetch(input, init);

interface KeyState {
  key: string;
  cooldownUntil: number;
}

export class AgnesConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgnesConfigurationError";
  }
}

export class AgnesUpstreamError extends Error {
  constructor(
    readonly provider: "agnes" | "deepseek",
    readonly causeName: string,
    readonly causeMessage: string,
  ) {
    super("Agnes upstream request failed");
    this.name = "AgnesUpstreamError";
  }
}

function parseApiKeys(
  value: string | undefined,
  variableName: string,
  required: boolean,
): string[] {
  if (!value) {
    if (!required) return [];
    throw new AgnesConfigurationError("AGNES_API_KEYS is not configured");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AgnesConfigurationError(
      `${variableName} must be a JSON array of strings`,
    );
  }
  if (
    !Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_KEYS ||
    parsed.some((key) =>
      typeof key !== "string" || key.trim().length === 0 ||
      key.length > 2_048
    )
  ) {
    throw new AgnesConfigurationError(
      `${variableName} must contain between 1 and ${MAX_KEYS} non-empty strings`,
    );
  }

  const keys = [...new Set(parsed.map((key) => key.trim()))];
  if (keys.length !== parsed.length) {
    throw new AgnesConfigurationError(
      `${variableName} must not contain duplicate keys`,
    );
  }
  return keys;
}

export function parseAgnesApiKeys(value: string | undefined): string[] {
  return parseApiKeys(value, "AGNES_API_KEYS", true);
}

export function parseDeepSeekApiKeys(value: string | undefined): string[] {
  return parseApiKeys(value, "DEEPSEEK_API_KEYS", false);
}

export class AgnesClient {
  private readonly keys: KeyState[];
  private cursor = 0;

  constructor(
    keys: readonly string[],
    private readonly fetcher: AgnesFetch = defaultAgnesFetch,
    private readonly now: () => number = Date.now,
    private readonly endpoint = AGNES_CHAT_COMPLETIONS_URL,
    private readonly model?: string,
  ) {
    if (keys.length === 0) {
      throw new AgnesConfigurationError("At least one Agnes key is required");
    }
    this.keys = keys.map((key) => ({ key, cooldownUntil: 0 }));
  }

  async chatCompletions(
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const attempted = new Set<number>();
    let latestRateLimited: Response | undefined;
    let latestNetworkError:
      | {
        provider: "agnes" | "deepseek";
        causeName: string;
        causeMessage: string;
      }
      | undefined;

    while (attempted.size < this.keys.length) {
      const index = this.acquire(attempted);
      if (index === undefined) break;
      attempted.add(index);

      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.keys[index].key}`,
            "content-type": "application/json",
          },
          body: this.model ? replaceRequestModel(body, this.model) : body,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        latestNetworkError = {
          provider: this.endpoint === DEEPSEEK_CHAT_COMPLETIONS_URL
            ? "deepseek"
            : "agnes",
          causeName: error instanceof Error ? error.name : "UnknownError",
          causeMessage: error instanceof Error
            ? error.message.slice(0, 200)
            : String(error).slice(0, 200),
        };
        continue;
      }

      if (response.status !== 429) {
        await latestRateLimited?.body?.cancel().catch(() => {});
        return response;
      }

      this.keys[index].cooldownUntil = this.now() +
        rateLimitCooldownMs(response.headers, this.now());
      await latestRateLimited?.body?.cancel().catch(() => {});
      latestRateLimited = response;
    }

    if (latestRateLimited) return latestRateLimited;
    if (latestNetworkError) {
      throw new AgnesUpstreamError(
        latestNetworkError.provider,
        latestNetworkError.causeName,
        latestNetworkError.causeMessage,
      );
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (Math.min(...this.keys.map((state) => state.cooldownUntil)) -
          this.now()) / 1_000,
      ),
    );
    return new Response(
      JSON.stringify({
        error: {
          message: "All Agnes API keys are temporarily rate limited",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSeconds),
        },
      },
    );
  }

  private acquire(attempted: ReadonlySet<number>): number | undefined {
    const now = this.now();
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      if (
        !attempted.has(index) &&
        this.keys[index].cooldownUntil <= now
      ) {
        this.cursor = (index + 1) % this.keys.length;
        return index;
      }
    }
    return undefined;
  }
}

function replaceRequestModel(body: string, model: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, model });
}

export class AiProviderClient {
  private readonly agnes: AgnesClient;
  private readonly deepSeek?: AgnesClient;

  constructor(
    agnesKeys: readonly string[],
    deepSeekKeys: readonly string[],
    deepSeekModel = DEFAULT_DEEPSEEK_MODEL,
    fetcher: AgnesFetch = defaultAgnesFetch,
    now: () => number = Date.now,
  ) {
    this.agnes = new AgnesClient(agnesKeys, fetcher, now);
    this.deepSeek = deepSeekKeys.length > 0
      ? new AgnesClient(
        deepSeekKeys,
        fetcher,
        now,
        DEEPSEEK_CHAT_COMPLETIONS_URL,
        deepSeekModel,
      )
      : undefined;
  }

  async chatCompletions(
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let agnesResponse: Response | undefined;
    try {
      agnesResponse = await this.agnes.chatCompletions(body, signal);
      if (agnesResponse.status !== 429 && agnesResponse.status < 500) {
        return agnesResponse;
      }
    } catch (error) {
      if (!(error instanceof AgnesUpstreamError) || !this.deepSeek) throw error;
    }
    if (!this.deepSeek) return agnesResponse!;
    await agnesResponse?.body?.cancel().catch(() => {});
    return await this.deepSeek.chatCompletions(body, signal);
  }
}

function rateLimitCooldownMs(headers: Headers, now: number): number {
  const retryAfter = headers.get("retry-after");
  let milliseconds: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      milliseconds = seconds * 1_000;
    } else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) milliseconds = date - now;
    }
  }

  if (milliseconds === undefined) {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      milliseconds = reset * 1_000 - now;
    }
  }

  return Math.min(
    MAX_RATE_LIMIT_COOLDOWN_MS,
    Math.max(1_000, milliseconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS),
  );
}
