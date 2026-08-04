import {
  type AuditActor,
  type AuditLog,
  newAuditEvent,
  safeAuditMetadata,
} from "./audit.ts";

export type ReconciliationStatus = "matched" | "mismatch" | "unavailable";

export interface ReconciliationCheck {
  source: "paypal" | "ledger" | "usage" | "vultr";
  status: ReconciliationStatus;
  checkedAt: string;
  details?: Record<string, string | number | boolean>;
}

export interface ReconciliationReport {
  reportId: string;
  generatedAt: string;
  checks: ReconciliationCheck[];
}

export interface ReconciliationSource {
  source: ReconciliationCheck["source"];
  check(): Promise<ReconciliationCheck>;
}

export interface ReconciliationRepository {
  save(report: ReconciliationReport): Promise<void>;
  latest(): Promise<ReconciliationReport | undefined>;
  enqueueManual(input: {
    kind: "reconciliation_mismatch" | "reconciliation_unavailable";
    referenceId: string;
    reason: string;
    occurredAt: string;
  }): Promise<void>;
}

export class ReconciliationService {
  constructor(
    private readonly sources: ReconciliationSource[],
    private readonly reports: ReconciliationRepository,
    private readonly audit: AuditLog,
    private readonly now: () => string,
  ) {}

  async run(
    actor: AuditActor = { type: "system", id: "m7-reconciliation" },
  ): Promise<ReconciliationReport> {
    const generatedAt = this.now();
    const checks = await Promise.all(this.sources.map(async (source) => {
      try {
        return await source.check();
      } catch {
        return {
          source: source.source,
          status: "unavailable" as const,
          checkedAt: generatedAt,
        };
      }
    }));
    const report: ReconciliationReport = {
      reportId: `recon:${generatedAt}`,
      generatedAt,
      checks,
    };
    await this.reports.save(report);

    await Promise.all(checks.flatMap((check) => {
      if (check.status === "matched") return [];
      const kind = check.status === "mismatch"
        ? "reconciliation_mismatch" as const
        : "reconciliation_unavailable" as const;
      return [
        this.reports.enqueueManual({
          kind,
          referenceId: report.reportId,
          reason: `${check.source}:${check.status}`,
          occurredAt: generatedAt,
        }),
        this.audit.append(newAuditEvent({
          eventId: `audit:${report.reportId}:${check.source}`,
          actor,
          action: "reconciliation.flagged",
          resourceType: "reconciliation_report",
          resourceId: report.reportId,
          correlationId: report.reportId,
          occurredAt: generatedAt,
          metadata: safeAuditMetadata({
            source: check.source,
            status: check.status,
          }),
        })),
      ];
    }));
    return report;
  }
}

/**
 * Kept separate from Cloudflare's entry point so the same durable job can be
 * wired by Deno/Azure after their queue adapters are available.
 */
export async function runM7ScheduledWork(input: {
  reconciliation: ReconciliationService;
  operations: { retryPendingDispatches(): Promise<void> };
}): Promise<void> {
  await input.operations.retryPendingDispatches();
  await input.reconciliation.run();
}
