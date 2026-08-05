import {
  app as azureApp,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  createAzureSharedHostingHourlyTimerHandler,
  createAzureSharedHostingHourlyWorkFactory,
  SHARED_HOSTING_HOURLY_TIMER_SCHEDULE,
} from "./sharedHostingTimer.ts";
import { createAzureHttpApp } from "./httpApp.ts";

// Azure Functions entry point. Reuses the shared Hono app and injects the
// Azure-specific platform behaviour:
//  - geo is resolved from the proxy-forwarded IP via geoip-country.
//  - MongoDB is accessed through the npm MongoDB driver.
//  - translation cache misses are recorded for the external batch worker.
//  - there is no WebSocket multiplayer support.
const environment = process.env as Record<string, string | undefined>;
const hono = createAzureHttpApp(environment);
const maximumAzureRequestBytes = 4 * 1024 * 1024;

class AzureRequestBodyTooLargeError extends Error {}

async function toRequest(req: HttpRequest): Promise<Request> {
  const method = req.method;
  const headers = new Headers();
  req.headers.forEach((value, key) => headers.set(key, value));
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readRequestBody(req) : undefined;

  // Azure serves HTTP functions under the `api` route prefix, so the incoming
  // path is `/api/<route>`. The shared Hono routes are registered without that
  // prefix (they run identically on Deno/Cloudflare), so strip a leading `/api`
  // segment before matching. This keeps `https://.../api/appx` reaching the
  // `/appx` route instead of 404ing.
  const url = new URL(req.url);
  const originalTarget = `${url.pathname}${url.search}`;
  if (url.pathname === "/api" || url.pathname === "/api/") {
    url.pathname = "/";
  } else if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice("/api".length);
  }
  // Workload HMAC covers the public callback path. Preserve that exact target
  // after Azure's `/api` route prefix is stripped for Hono matching.
  headers.set("x-xmcl-original-target", originalTarget);

  return new Request(url, { method, headers, body });
}

async function readRequestBody(req: HttpRequest): Promise<ArrayBuffer> {
  const contentLength = req.headers.get("content-length");
  if (
    contentLength && /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > maximumAzureRequestBytes
  ) {
    throw new AzureRequestBodyTooLargeError();
  }
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumAzureRequestBytes) {
        await reader.cancel();
        throw new AzureRequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer as ArrayBuffer;
}

function toAzure(res: Response): HttpResponseInit {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: res.status,
    headers,
    body: res.body ?? undefined,
  };
}

azureApp.http("api", {
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  authLevel: "anonymous",
  route: "{*proxy}",
  handler: async (request: HttpRequest, ctx: InvocationContext) => {
    try {
      const webRequest = await toRequest(request);
      const response = await hono.fetch(
        webRequest,
        process.env as Record<string, string>,
      );
      return toAzure(response);
    } catch (e) {
      if (e instanceof AzureRequestBodyTooLargeError) {
        return { status: 413, jsonBody: { error: "Payload Too Large" } };
      }
      ctx.error(e);
      return { status: 500, jsonBody: { error: "Internal Server Error" } };
    }
  },
});

azureApp.timer("shared-hosting-hourly", {
  schedule: SHARED_HOSTING_HOURLY_TIMER_SCHEDULE,
  useMonitor: true,
  handler: createAzureSharedHostingHourlyTimerHandler(
    createAzureSharedHostingHourlyWorkFactory(),
  ),
});
