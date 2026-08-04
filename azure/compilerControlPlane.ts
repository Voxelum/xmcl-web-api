import type { Hono } from "hono";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import {
  HmacCompilerServiceIdentity,
  MongoCompilerNonceStore,
} from "../src/lib/compilerServiceIdentity.ts";
import { HttpSharedModdedCompiler, parseCompilerEndpoint } from "../src/lib/compilerHttpSubmission.ts";
import {
  CompilerGrantAuthority,
  MongoSharedModdedRuntimeRepository,
  MongoSharedRuntimeTerms,
  SharedModdedRuntimeService,
} from "../src/lib/sharedModdedRuntime.ts";
import { S3SharedModdedArchiveStore } from "../src/lib/sharedModdedS3Archive.ts";
import { type S3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import {
  getSharedHostingRuntime,
  hasSharedNodeSettings,
} from "../src/lib/sharedHostingRuntime.ts";
import { CurseForgeSourceResolver } from "../src/lib/modpackSources/curseforge.ts";
import { ModrinthSourceResolver } from "../src/lib/modpackSources/modrinth.ts";
import type { AppEnv } from "../src/types.ts";

const maximumCallbackBytes = 4 * 1024 * 1024;

interface CompilerControlPlaneSettings {
  endpoint: string;
  keyId: string;
  secret: string;
  timeoutMs: number;
  termsVersion: string;
  curseForgeKey: string;
}

/**
 * Azure-only composition for the private compiler callback plane. Its absence
 * means routes are not mounted, rather than exposing a partially configured
 * endpoint.
 */
export class AzureCompilerControlPlane {
  constructor(
    private readonly settings: CompilerControlPlaneSettings,
    private readonly signer: S3SigV4Presigner,
  ) {}

  register(app: Hono<AppEnv>) {
    app.use(
      "/v1/internal/shared-runtime-compiler/*",
      async (c, next) => {
        let raw: Uint8Array;
        try {
          raw = new Uint8Array(await c.req.raw.arrayBuffer());
        } catch {
          return c.json({ error: "unauthorized" }, 401);
        }
        if (raw.byteLength > maximumCallbackBytes) {
          return c.json({ error: "invalid_request" }, 400);
        }
        const getDb = c.get("getDb");
        if (!getDb) return c.json({ error: "compiler_unavailable" }, 503);
        let db: Db;
        try {
          db = await getDb();
        } catch {
          return c.json({ error: "compiler_unavailable" }, 503);
        }
        const identity = this.identity(db);
        try {
          await identity.verifyIncoming({
            method: c.req.method,
            target: callbackTarget(c),
            headers: c.req.raw.headers,
            body: raw,
          });
        } catch {
          return c.json({ error: "unauthorized" }, 401);
        }
        try {
          const shared = await getSharedHostingRuntime(c, this.signer);
          const runtime = this.runtime(db, shared.scheduler, identity);
          shared.transport.setRuntimeContentGrantAuthority(runtime);
          c.set("sharedModdedRuntime", runtime);
          c.set("sharedModdedCompilerGrants", new CompilerGrantAuthority(
            this.signer,
            5 * 60,
          ));
          c.set("sharedModdedCompilerPrincipal", {
            compilerId: this.settings.keyId,
          });
          c.set("sharedModdedCompilerRawBody", raw);
        } catch {
          return c.json({ error: "compiler_unavailable" }, 503);
        }
        await next();
      },
    );
  }

  private identity(db: Db) {
    return new HmacCompilerServiceIdentity({
      keyId: this.settings.keyId,
      secret: this.settings.secret,
      nonceStore: new MongoCompilerNonceStore(db),
    });
  }

  private runtime(
    db: Db,
    scheduler: Awaited<ReturnType<typeof getSharedHostingRuntime>>["scheduler"],
    identity: HmacCompilerServiceIdentity,
  ) {
    const repository = new MongoSharedModdedRuntimeRepository(db);
    const grants = new CompilerGrantAuthority(this.signer, 5 * 60);
    return new SharedModdedRuntimeService({
      repository,
      archives: new S3SharedModdedArchiveStore(this.signer),
      resolvers: [
        new ModrinthSourceResolver(),
        new CurseForgeSourceResolver(this.settings.curseForgeKey),
      ],
      compiler: new HttpSharedModdedCompiler({
        endpoint: this.settings.endpoint,
        repository,
        grants,
        identity,
        timeoutMs: this.settings.timeoutMs,
      }),
      scheduler,
      terms: new MongoSharedRuntimeTerms(db, this.settings.termsVersion),
    });
  }
}

export function createAzureCompilerControlPlane(
  config: AppConfig,
  signer: S3SigV4Presigner | undefined,
) {
  const settings = compilerControlPlaneSettings(config);
  if (!settings || !signer || !hasSharedNodeSettings(config)) return undefined;
  return new AzureCompilerControlPlane(settings, signer);
}

export function compilerControlPlaneSettings(
  config: AppConfig,
): CompilerControlPlaneSettings | undefined {
  const timeoutMs = positiveInteger(config.XMCL_SHARED_COMPILER_TIMEOUT_MS);
  if (
    !hasText(config.MONGO_CONNECION_STRING) ||
    !hasText(config.CURSEFORGE_KEY) ||
    !hasText(config.XMCL_SHARED_COMPILER_ENDPOINT) ||
    !validKeyId(config.XMCL_SHARED_COMPILER_KEY_ID) ||
    !hasHmacSecret(config.XMCL_SHARED_COMPILER_HMAC_SECRET) ||
    timeoutMs === undefined || timeoutMs < 1_000 || timeoutMs > 300_000 ||
    !validTermsVersion(config.XMCL_SHARED_RUNTIME_TERMS_VERSION) ||
    !validReviewedImage(config.XMCL_SHARED_COMPILER_REVIEWED_IMAGE)
  ) {
    return undefined;
  }
  try {
    parseCompilerEndpoint(config.XMCL_SHARED_COMPILER_ENDPOINT);
  } catch {
    return undefined;
  }
  return {
    endpoint: config.XMCL_SHARED_COMPILER_ENDPOINT,
    keyId: config.XMCL_SHARED_COMPILER_KEY_ID,
    secret: config.XMCL_SHARED_COMPILER_HMAC_SECRET,
    timeoutMs,
    termsVersion: config.XMCL_SHARED_RUNTIME_TERMS_VERSION,
    curseForgeKey: config.CURSEFORGE_KEY,
  };
}

function callbackTarget(c: {
  req: { url: string; header(name: string): string | undefined };
}) {
  const original = c.req.header("x-xmcl-original-target");
  if (original && original.startsWith("/") && original.length <= 2_048) {
    return original;
  }
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validKeyId(value: string | undefined): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function hasHmacSecret(value: string | undefined): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength >= 32;
}

function validTermsVersion(value: string | undefined): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validReviewedImage(value: string | undefined) {
  return typeof value === "string" &&
    /^ghcr\.io\/voxelum\/xmcl-shared-minecraft-compiler@sha256:[a-f0-9]{64}$/
      .test(value);
}

function positiveInteger(value: string | undefined) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
