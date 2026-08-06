interface WorkerLogger {
  error(value: unknown): void;
  warn(value: unknown): void;
}

interface CloudflareRequest extends Request {
  cf?: {
    colo?: unknown;
  };
}

export async function observeWorkerRequest(
  request: Request,
  handler: () => Promise<Response>,
  logger: WorkerLogger = console,
  now: () => number = Date.now,
) {
  const startedAt = now();
  const fields = requestLogFields(request);
  try {
    const response = await handler();
    if (response.status >= 400) {
      const record = {
        event: "worker.response",
        ...fields,
        status: response.status,
        durationMs: Math.max(0, now() - startedAt),
      };
      if (response.status >= 500) logger.error(record);
      else logger.warn(record);
    }
    return response;
  } catch (error) {
    logger.error({
      event: "worker.exception",
      ...fields,
      durationMs: Math.max(0, now() - startedAt),
      ...workerErrorFields(error),
    });
    const observed = new Error(
      `Worker request failed; requestId=${fields.requestId}`,
    );
    observed.name = "ObservedWorkerError";
    throw observed;
  }
}

export function workerErrorFields(error: unknown) {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }
  return {
    errorName: error.name,
  };
}

function requestLogFields(request: Request) {
  const cf = (request as CloudflareRequest).cf;
  const requestId = validIdentifier(request.headers.get("x-request-id")) ??
    validIdentifier(request.headers.get("cf-ray")) ??
    crypto.randomUUID();
  return {
    requestId,
    method: request.method,
    path: safePath(request.url),
    cfRay: validIdentifier(request.headers.get("cf-ray")),
    colo: typeof cf?.colo === "string" ? cf.colo : undefined,
  };
}

function validIdentifier(value: string | null) {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function safePath(url: string) {
  try {
    return new URL(url).pathname.slice(0, 512);
  } catch {
    return "(invalid-url)";
  }
}
