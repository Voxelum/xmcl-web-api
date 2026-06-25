import {
  app as azureApp,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createApp } from "../src/app.ts";
import { geoipMiddleware } from "../src/middleware/geoip.ts";

// Azure Functions entry point. Reuses the shared Hono app and injects the
// Azure-specific platform behaviour:
//  - geo is resolved from the proxy-forwarded IP via geoip-country.
//  - there is no translation queue, so /translation translates inline.
//  - there is no realtime support, so /group/:id returns 501.
const hono = createApp((a) => {
  a.use("*", geoipMiddleware);
});

async function toRequest(req: HttpRequest): Promise<Request> {
  const method = req.method;
  const headers = new Headers();
  req.headers.forEach((value, key) => headers.set(key, value));
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;
  return new Request(req.url, { method, headers, body });
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
