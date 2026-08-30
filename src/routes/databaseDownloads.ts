import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

interface DatabaseSource {
  repository: string;
  assetPattern: RegExp;
}

const DATABASE_SOURCES: Record<string, DatabaseSource> = {
  "mod-metadata": {
    repository: "Voxelum/minecraft-mods-database",
    assetPattern: /^db\.sqlite(?:\.sha1)?$/,
  },
  "project-mapping": {
    repository: "Voxelum/xmcl-commuity-content-i18n",
    assetPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*\.sqlite\.(?:gz|sha256)$/,
  },
};

const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
];

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

interface CloudflareRequestInit extends RequestInit {
  cf: {
    cacheEverything: boolean;
    cacheTtlByStatus: Record<string, number>;
  };
}

export default new Hono<AppEnv>().on(
  ["GET", "HEAD"],
  "/downloads/databases/:source/:asset",
  async (c) => {
    const source = DATABASE_SOURCES[c.req.param("source")];
    const asset = c.req.param("asset");
    if (!source || !source.assetPattern.test(asset)) {
      return c.json({ error: "database_asset_not_found" }, 404);
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }

    const upstreamUrl =
      `https://github.com/${source.repository}/releases/latest/download/${asset}`;
    const requestInit: CloudflareRequestInit = {
      method: c.req.method,
      headers,
      redirect: "follow",
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: {
          "200-299": 3600,
          "404": 60,
          "500-599": 0,
        },
      },
    };
    const upstream = await fetch(upstreamUrl, requestInit as RequestInit);

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set(
      "cache-control",
      upstream.ok
        ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
        : "no-store",
    );

    return new Response(c.req.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
);
