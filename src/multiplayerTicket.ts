export type MultiplayerRole = "master" | "member";

export interface MultiplayerTicketClaims {
  version: 2;
  roomId: string;
  accountId: string;
  peerId: string;
  displayName: string;
  role: MultiplayerRole;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signature(secret: string, payload: string): Promise<Uint8Array> {
  if (secret.length < 32) {
    throw new Error(
      "XMCL_MULTIPLAYER_TICKET_SECRET must be at least 32 characters",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

export async function signMultiplayerTicket(
  claims: MultiplayerTicketClaims,
  secret: string,
): Promise<string> {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${encodeBase64Url(await signature(secret, payload))}`;
}

export async function verifyMultiplayerTicket(
  ticket: string,
  secret: string,
  now = Date.now(),
): Promise<MultiplayerTicketClaims | undefined> {
  const [payload, supplied, extra] = ticket.split(".");
  if (!payload || !supplied || extra) return undefined;
  const expected = await signature(secret, payload);
  let actual: Uint8Array;
  try {
    actual = decodeBase64Url(supplied);
  } catch {
    return undefined;
  }
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    mismatch |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  }
  if (mismatch !== 0) return undefined;
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as MultiplayerTicketClaims;
    if (
      claims.version !== 2 ||
      !claims.roomId ||
      !claims.accountId ||
      !claims.peerId ||
      !claims.displayName ||
      !["master", "member"].includes(claims.role) ||
      !Number.isSafeInteger(claims.issuedAt) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.issuedAt > now + 30_000 ||
      claims.expiresAt <= now
    ) {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}
