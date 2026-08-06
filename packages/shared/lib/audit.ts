export type AuditActor = {
  type: "account" | "admin" | "worker" | "system";
  id: string;
};

export type AuditMetadata = Record<string, string | number | boolean>;

export interface AuditEvent {
  eventId: string;
  schemaVersion: 1;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  metadata?: AuditMetadata;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

const sensitiveKey =
  /(token|secret|oauth|paypal|authorization|card|pan|world|content)/i;

/**
 * Audit metadata is intentionally a small, scalar allow-list. Keeping the
 * sanitisation at the write boundary prevents provider credentials, payment
 * payloads, and player-world content from reaching the audit store.
 */
export function safeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): AuditMetadata | undefined {
  if (!metadata) return undefined;

  const safe = Object.entries(metadata).reduce<AuditMetadata>(
    (result, [key, value]) => {
      if (
        !sensitiveKey.test(key) &&
        (typeof value === "string" || typeof value === "number" ||
          typeof value === "boolean")
      ) {
        result[key] = value;
      }
      return result;
    },
    {},
  );

  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function newAuditEvent(
  input: Omit<AuditEvent, "schemaVersion">,
): AuditEvent {
  return { ...input, schemaVersion: 1 };
}
