import {
  app as azureApp,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createProductionApp } from "../src/lib/productionComposition.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { geoipMiddleware } from "../src/middleware/geoip.ts";
import { getDb } from "../src/platform/db_npm.ts";

// Azure Functions entry point. Reuses the shared Hono app and injects the
// Azure-specific platform behaviour:
//  - geo is resolved from the proxy-forwarded IP via geoip-country.
//  - MongoDB is accessed via the npm driver (MikroORM).
//  - translation cache misses are recorded for the external batch worker.
//  - there is no realtime support, so /group/:id returns 501.
const hono = createProductionApp((a) => {
  a.use("*", geoipMiddleware);
  a.use("*", createDbMiddleware(getDb));
}, process.env as Record<string, string | undefined>);

async function toRequest(req: HttpRequest): Promise<Request> {
  const method = req.method;
  const headers = new Headers();
  req.headers.forEach((value, key) => headers.set(key, value));
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  // Azure serves HTTP functions under the `api` route prefix, so the incoming
  // path is `/api/<route>`. The shared Hono routes are registered without that
  // prefix (they run identically on Deno/Cloudflare), so strip a leading `/api`
  // segment before matching. This keeps `https://.../api/appx` reaching the
  // `/appx` route instead of 404ing.
  const url = new URL(req.url);
  if (url.pathname === "/api" || url.pathname === "/api/") {
    url.pathname = "/";
  } else if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice("/api".length);
  }

  return new Request(url, { method, headers, body });
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
      ctx.error(e);
      return { status: 500, jsonBody: { error: "Internal Server Error" } };
    }
  },
});
