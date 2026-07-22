import assert from "node:assert/strict";
import type { AuditEvent, AuditLog } from "./audit.ts";
import {
  type ReconciliationReport,
  type ReconciliationRepository,
  ReconciliationService,
} from "./reconciliation.ts";

class MemoryReconciliation implements ReconciliationRepository {
  reports: ReconciliationReport[] = [];
  manual: string[] = [];
  async save(report: ReconciliationReport) {
    this.reports.push(report);
  }
  async latest() {
    return this.reports.at(-1);
  }
  async enqueueManual(
    input: {
      kind: "reconciliation_mismatch" | "reconciliation_unavailable";
      referenceId: string;
      reason: string;
      occurredAt: string;
    },
  ) {
    this.manual.push(`${input.kind}:${input.reason}`);
  }
}

class MemoryAudit implements AuditLog {
  events: AuditEvent[] = [];
  append(event: AuditEvent) {
    this.events.push(event);
    return Promise.resolve();
  }
}

Deno.test("queues unavailable reconciliation providers for manual handling", async () => {
  const reports = new MemoryReconciliation();
  const audit = new MemoryAudit();
  const service = new ReconciliationService(
    [
      {
        source: "paypal",
        async check() {
          throw new Error("provider timeout");
        },
      },
      {
        source: "ledger",
        async check() {
          return {
            source: "ledger",
            status: "matched",
            checkedAt: "2026-07-22T14:00:00.000Z",
          };
        },
      },
    ],
    reports,
    audit,
    () => "2026-07-22T14:00:00.000Z",
  );

  const report = await service.run();

  assert.deepEqual(report.checks.map((check) => [check.source, check.status]), [
    ["paypal", "unavailable"],
    ["ledger", "matched"],
  ]);
  assert.deepEqual(reports.manual, [
    "reconciliation_unavailable:paypal:unavailable",
  ]);
  assert.equal(audit.events.length, 1);
});
