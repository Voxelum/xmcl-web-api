import { HmacCompilerServiceIdentity } from "./compilerServiceIdentity.ts";
import {
  CompilerPublicationUncertain,
  CompilerUploadReconciliationUncertain,
  type CompilerGrantAuthority,
  type CompilerGrantSet,
  type RuntimeDescriptor,
  type SharedRuntimeContentDescriptor,
  type SharedModdedCompiler,
  type SharedModdedDeployment,
  SharedModdedRuntimeError,
  type SharedModdedRuntimeRepository,
} from "./sharedModdedRuntime.ts";

const encoder = new TextEncoder();
const maximumEnvelopeBytes = 256 * 1024;
const maximumResponseBytes = 16 * 1024;

export interface CompilerHttpSubmissionOptions {
  endpoint: string;
  repository: Pick<SharedModdedRuntimeRepository, "getDeployment">;
  grants: Pick<CompilerGrantAuthority, "issue">;
  identity: HmacCompilerServiceIdentity;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * The only compiler submission implementation used by Azure. It constructs a
 * closed schema from durable deployment state; caller data cannot select a
 * callback, command, compiler configuration, or storage capability.
 */
export class HttpSharedModdedCompiler implements SharedModdedCompiler {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: CompilerHttpSubmissionOptions) {
    this.endpoint = parseCompilerEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ??
      ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => new Date());
    if (
      typeof options.grants?.issue !== "function" ||
      typeof options.repository?.getDeployment !== "function" ||
      !options.identity || typeof options.identity.signOutgoing !== "function" ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 ||
      options.timeoutMs > 300_000
    ) {
      throw new TypeError("invalid compiler HTTP submission configuration");
    }
  }

  async submit(input: {
    deploymentId: string;
    compilerRequestId: string;
    accountId: string;
    serviceId: string;
    frozenManifest: Readonly<SharedModdedDeployment["frozenManifest"]>;
    manifestSha256: string;
    expectedContentKey: string;
  }): Promise<void> {
    try {
      const deployment = await this.options.repository.getDeployment(
        input.deploymentId,
      );
      if (!deployment || !sameSubmission(input, deployment)) {
        throw new Error("deployment no longer matches compiler submission");
      }
      const grants = await this.options.grants.issue(deployment);
      if (!sameGrantSet(grants, deployment, issuedAtMillis(this.now))) {
        throw new Error("compiler grant set does not match deployment");
      }
      const issuedAt = this.now();
      const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
      const envelope = {
        schemaVersion: 1,
        requestId: deployment.compilerRequestId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        job: {
          accountId: deployment.accountId,
          serviceId: deployment.serviceId,
          deploymentId: deployment.deploymentId,
          manifestSha256: deployment.manifestSha256,
          compilerRequestId: deployment.compilerRequestId,
          expectedContentKey: deployment.expectedContentKey,
          frozenManifest: deployment.frozenManifest,
        },
        grants,
      };
      const body = encoder.encode(JSON.stringify(envelope));
      if (body.byteLength > maximumEnvelopeBytes) {
        throw new Error("compiler envelope exceeds worker limit");
      }
      const target = `${this.endpoint.pathname}${this.endpoint.search}`;
      const identityHeaders = await this.options.identity.signOutgoing({
        method: "POST",
        target,
        body,
      });
      const response = await this.post(body, identityHeaders);
      const result = await validateCompilerResponse(
        response,
        deployment,
      );
      if (typeof result === "string") {
        throw new SharedModdedRuntimeError(result);
      }
      if (result) {
        const uncertain = {
          compilerRequestId: deployment.compilerRequestId,
          ...result,
        };
        if (result.status === "upload_reconciliation_uncertain") {
          throw new CompilerUploadReconciliationUncertain(uncertain);
        }
        throw new CompilerPublicationUncertain(uncertain);
      }
    } catch (error) {
      if (
        error instanceof SharedModdedRuntimeError ||
        error instanceof CompilerPublicationUncertain ||
        error instanceof CompilerUploadReconciliationUncertain
      ) throw error;
      throw new SharedModdedRuntimeError("compiler_unavailable");
    }
  }

  private async post(body: Uint8Array, identityHeaders: Record<string, string>) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          ...identityHeaders,
        },
        body: body as unknown as BodyInit,
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        response.redirected ||
        (response.url && response.url !== this.endpoint.toString()) ||
        !response.ok
      ) {
        throw new Error("compiler endpoint rejected submission");
      }
      return response;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function parseCompilerEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("invalid compiler endpoint");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.hash || endpoint.search || endpoint.pathname !== "/v1/compiler-jobs"
  ) {
    throw new TypeError("compiler endpoint must be exact HTTPS /v1/compiler-jobs");
  }
  return endpoint;
}

function sameSubmission(
  input: Parameters<SharedModdedCompiler["submit"]>[0],
  deployment: SharedModdedDeployment,
) {
  return input.deploymentId === deployment.deploymentId &&
    input.compilerRequestId === deployment.compilerRequestId &&
    input.accountId === deployment.accountId &&
    input.serviceId === deployment.serviceId &&
    input.manifestSha256 === deployment.manifestSha256 &&
    input.expectedContentKey === deployment.expectedContentKey &&
    JSON.stringify(input.frozenManifest) === JSON.stringify(deployment.frozenManifest);
}

function sameGrantSet(
  grants: CompilerGrantSet,
  deployment: SharedModdedDeployment,
  now: number,
) {
  const input = grants.grants.find((grant) => grant.method === "GET");
  const output = grants.grants.find((grant) => grant.method === "PUT");
  return grants.compilerRequestId === deployment.compilerRequestId &&
    grants.accountId === deployment.accountId &&
    grants.serviceId === deployment.serviceId &&
    grants.deploymentId === deployment.deploymentId &&
    grants.manifestSha256 === deployment.manifestSha256 &&
    grants.grants.length === 2 && !!input && !!output &&
    input.key === deployment.frozenManifest.archive.key &&
    (!input.headers || Object.keys(input.headers).length === 0) &&
    output.key === deployment.expectedContentKey &&
    JSON.stringify(output.headers) === JSON.stringify({
      "if-none-match": "*",
      "x-ms-blob-type": "BlockBlob",
    }) &&
    exactGrant(input, now) && exactGrant(output, now);
}

function exactGrant(
  grant: CompilerGrantSet["grants"][number],
  now: number,
) {
  try {
    const url = new URL(grant.url);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.hash && Number.isSafeInteger(Date.parse(grant.expiresAt)) &&
      Date.parse(grant.expiresAt) > now;
  } catch {
    return false;
  }
}

function issuedAtMillis(now: () => Date) {
  const value = now().getTime();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid compiler clock");
  }
  return value;
}

async function validateCompilerResponse(
  response: Response,
  deployment: SharedModdedDeployment,
): Promise<
  | "unsupported_compatibility"
  | "compiler_unavailable"
  | "compiler_failed"
  | {
    status: "published_callback_uncertain" | "upload_reconciliation_uncertain";
    deploymentId: string;
    manifestSha256: string;
    content: SharedRuntimeContentDescriptor;
    descriptor: RuntimeDescriptor;
  }
  | undefined
> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > maximumResponseBytes)
  ) {
    throw new Error("compiler response too large");
  }
  const raw = await response.text();
  if (encoder.encode(raw).byteLength > maximumResponseBytes) {
    throw new Error("compiler response too large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("invalid compiler response");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid compiler response");
  }
  const value = payload as Record<string, unknown>;
  if (
    response.status === 202 &&
    value.status === "accepted" &&
    value.deploymentId === deployment.deploymentId &&
    Object.keys(value).length === 2
  ) return undefined;
  if (
    response.status === 200 &&
    value.status === "published" &&
    value.deploymentId === deployment.deploymentId &&
    Object.keys(value).length === 2
  ) return undefined;
  if (
    response.status === 200 &&
    value.status === "failed" &&
    ["unsupported_compatibility", "compiler_unavailable", "compiler_failed"]
      .includes(value.code as string) &&
    Object.keys(value).length === 2
  ) return value.code as
    | "unsupported_compatibility"
    | "compiler_unavailable"
    | "compiler_failed";
  if (
    response.status === 200 &&
    ["published_callback_uncertain", "upload_reconciliation_uncertain"]
      .includes(value.status as string) &&
    value.deploymentId === deployment.deploymentId &&
    value.manifestSha256 === deployment.manifestSha256 &&
    plainObject(value.content) && plainObject(value.descriptor) &&
    sameKeys(value, [
      "status",
      "deploymentId",
      "manifestSha256",
      "content",
      "descriptor",
    ])
  ) {
    return {
      status: value.status as
        | "published_callback_uncertain"
        | "upload_reconciliation_uncertain",
      deploymentId: value.deploymentId,
      manifestSha256: value.manifestSha256,
      content: value.content as unknown as SharedRuntimeContentDescriptor,
      descriptor: value.descriptor as unknown as RuntimeDescriptor,
    };
  }
  throw new Error("invalid compiler response");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index]);
}
