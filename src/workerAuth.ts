export interface WorkerSessionRecord {
  tokenId: string;
  tokenHash: string;
  workerId: string;
  serverId: string;
  leaseId: string;
  expiresAt: string;
  invalidatedAt?: string;
}

export interface WorkerAuthRepository {
  findSession(tokenId: string): Promise<WorkerSessionRecord | undefined>;
  claimNonce(input: {
    tokenId: string;
    nonce: string;
    fingerprint: string;
    expiresAt: string;
  }): Promise<"claimed" | "replayed">;
}

export interface WorkerPrincipal {
  tokenId: string;
  workerId: string;
  serverId: string;
  leaseId: string;
}

export class WorkerAuthError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "invalid_signature"
      | "stale_request"
      | "replay_detected"
      | "lease_conflict",
  ) {
    super(code);
  }
}

export interface SignedWorkerRequest {
  method: string;
  path: string;
  body: string;
  authorization?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  serverId: string;
  leaseId: string;
}

const encoder = new TextEncoder();

export class WorkerRequestAuthenticator {
  constructor(
    private readonly repository: WorkerAuthRepository,
    private readonly now: () => number = Date.now,
    private readonly allowedClockSkewMs = 30_000,
  ) {}

  async authenticate(request: SignedWorkerRequest): Promise<WorkerPrincipal> {
    const credential = parseCredential(request.authorization);
    const timestamp = Number(request.timestamp);
    if (
      !credential || !request.timestamp || !request.nonce ||
      !request.signature ||
      !Number.isSafeInteger(timestamp)
    ) {
      throw new WorkerAuthError("unauthorized");
    }
    if (Math.abs(this.now() - timestamp) > this.allowedClockSkewMs) {
      throw new WorkerAuthError("stale_request");
    }

    const session = await this.repository.findSession(credential.tokenId);
    if (
      !session || session.invalidatedAt ||
      Date.parse(session.expiresAt) <= this.now() ||
      !constantTimeEqual(await sha256(credential.token), session.tokenHash)
    ) {
      throw new WorkerAuthError("unauthorized");
    }
    if (
      session.serverId !== request.serverId ||
      session.leaseId !== request.leaseId
    ) {
      throw new WorkerAuthError("lease_conflict");
    }

    const expected = await signWorkerRequest(credential.token, {
      method: request.method,
      path: request.path,
      body: request.body,
      timestamp: request.timestamp,
      nonce: request.nonce,
    });
    if (!constantTimeEqual(expected, request.signature)) {
      throw new WorkerAuthError("invalid_signature");
    }

    const replay = await this.repository.claimNonce({
      tokenId: session.tokenId,
      nonce: request.nonce,
      fingerprint: expected,
      expiresAt: new Date(timestamp + this.allowedClockSkewMs).toISOString(),
    });
    if (replay === "replayed") throw new WorkerAuthError("replay_detected");

    return {
      tokenId: session.tokenId,
      workerId: session.workerId,
      serverId: session.serverId,
      leaseId: session.leaseId,
    };
  }

  async authenticateBootstrap(
    credential: string,
    request: Omit<SignedWorkerRequest, "authorization">,
  ): Promise<void> {
    const timestamp = Number(request.timestamp);
    if (
      !credential || !request.timestamp || !request.nonce ||
      !request.signature ||
      !Number.isSafeInteger(timestamp)
    ) {
      throw new WorkerAuthError("unauthorized");
    }
    if (Math.abs(this.now() - timestamp) > this.allowedClockSkewMs) {
      throw new WorkerAuthError("stale_request");
    }
    const expected = await signWorkerRequest(credential, {
      method: request.method,
      path: request.path,
      body: request.body,
      timestamp: request.timestamp,
      nonce: request.nonce,
    });
    if (!constantTimeEqual(expected, request.signature)) {
      throw new WorkerAuthError("invalid_signature");
    }
    const replay = await this.repository.claimNonce({
      tokenId: `bootstrap:${request.serverId}:${request.leaseId}`,
      nonce: request.nonce,
      fingerprint: expected,
      expiresAt: new Date(timestamp + this.allowedClockSkewMs).toISOString(),
    });
    if (replay === "replayed") throw new WorkerAuthError("replay_detected");
  }
}

export async function issueWorkerToken(): Promise<{
  tokenId: string;
  token: string;
  tokenHash: string;
}> {
  const tokenId = crypto.randomUUID();
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const token = `${tokenId}.${secret}`;
  return { tokenId, token, tokenHash: await sha256(token) };
}

export async function signWorkerRequest(
  token: string,
  request: {
    method: string;
    path: string;
    body: string;
    timestamp: string;
    nonce: string;
  },
): Promise<string> {
  const bodyHash = await sha256(request.body);
  const payload = [
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    request.nonce,
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function parseCredential(value?: string) {
  const match = /^Worker ([^.]+\.[a-f0-9]+)$/i.exec(value ?? "");
  if (!match) return undefined;
  const token = match[1];
  return { token, tokenId: token.slice(0, token.indexOf(".")) };
}

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}
