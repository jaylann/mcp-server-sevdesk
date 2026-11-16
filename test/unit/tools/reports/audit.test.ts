import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuditResult } from "../../../../src/domain/reports/audit/registry.js";
import { MAX_DESCRIPTION_LENGTH } from "../../../../src/tools/define-tool.js";
import { JSON_SCHEMA_OPTIONS } from "../../../../src/tools/json-schema.js";
import { recordsAuditTool } from "../../../../src/tools/reports/audit.js";
import { REPORT_TOOLS } from "../../../../src/tools/reports/index.js";
import { quarterRoutes } from "../../domain/reports/audit/scenario.js";
import { regularAccount } from "../../domain/reports/builders.js";
import { runTool } from "./records.js";

describe("sevdesk_records_audit: metadata", () => {
  it("is a read tool of the reports toolset that changes nothing", () => {
    expect(recordsAuditTool).toMatchObject({
      name: "sevdesk_records_audit",
      toolset: "reports",
      tier: "read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(recordsAuditTool.localEffects).toBeUndefined();
    expect(REPORT_TOOLS).toContain(recordsAuditTool);
  });

  it("advertises only the checks that exist, in the description and the enum", () => {
    const json = z.toJSONSchema(recordsAuditTool.input, { ...JSON_SCHEMA_OPTIONS, io: "input" });
    expect(json.required).toEqual(["check"]);
    expect(json.properties?.["check"]).toMatchObject({
      enum: ["vat", "reverse_charge", "duplicates", "recurring_gaps"],
    });
    expect(recordsAuditTool.description).not.toContain("receipt_folder");
    expect(() => recordsAuditTool.input.parse({ check: "receipt_folder", year: 2026 })).toThrow();
    const { description } = recordsAuditTool;
    for (const check of ["vat", "reverse_charge", "duplicates", "recurring_gaps"]) {
      expect(description).toContain(`${check}:`);
    }
    expect(description).toContain("Hinweise, keine Steuerberatung");
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(Object.keys(recordsAuditTool.input.shape)).toEqual([
      "check",
      "year",
      "month",
      "quarter",
      "from",
      "to",
    ]);
  });
});

describe("sevdesk_records_audit", () => {
  it("runs the vat check for a quarter with schema-valid output and a trusted summary", async () => {
    const { client, data, result } = await runTool(
      recordsAuditTool,
      { check: "vat", year: 2026, quarter: 1 },
      [regularAccount, ...quarterRoutes()],
    );
    const report = data as AuditResult;

    expect(report.check).toBe("vat");
    expect(report.period.label).toBe("2026-Q1");
    expect(report.findings.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(
      /^Audit vat 2026-Q1: \d+ findings \(\d+ warnings? listed\) in 27 documents in scope\.$/,
    );
    expect(result.summary).not.toContain("SaaS Inc");
    expect(client.writes()).toEqual([]);
  });

  it("runs the reverse_charge check with its section", async () => {
    const { data, result } = await runTool(
      recordsAuditTool,
      { check: "reverse_charge", from: "2026-01-01", to: "2026-03-31" },
      [regularAccount, ...quarterRoutes()],
    );
    const report = data as AuditResult;

    expect(report.reverseCharge?.received.map((rule) => rule.taxRule.id)).toEqual([12, 14]);
    expect(result.summary).toContain("§ 13b received: base");
  });

  it.each(["duplicates", "recurring_gaps"] as const)(
    "runs the %s check on voucher lists only, changing nothing",
    async (check) => {
      const { client, data, result } = await runTool(
        recordsAuditTool,
        { check, year: 2026, quarter: 1 },
        [regularAccount, ...quarterRoutes()],
      );
      const report = data as AuditResult;

      expect(report.check).toBe(check);
      expect(report.caveatDe).toContain("keine Steuerberatung");
      expect(result.summary).toMatch(new RegExp(`^Audit ${check} 2026-Q1: `));
      expect(client.writes()).toEqual([]);
      expect(
        client.calls.every((call) => ["/Voucher", "/Invoice", "/CreditNote"].includes(call.path)),
      ).toBe(true);
      for (const call of client.calls) expect(call.query["limit"]).toBeDefined();
    },
  );

  it("refuses a malformed period before sending anything", async () => {
    await expect(
      runTool(recordsAuditTool, { check: "vat", year: 2026, from: "2026-01-01" }, []),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
