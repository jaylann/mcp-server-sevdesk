import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuditResult } from "../../../../src/domain/reports/audit/registry.js";
import { MAX_DESCRIPTION_LENGTH } from "../../../../src/tools/define-tool.js";
import { JSON_SCHEMA_OPTIONS } from "../../../../src/tools/json-schema.js";
import { recordsAuditTool } from "../../../../src/tools/reports/audit.js";
import { REPORT_TOOLS } from "../../../../src/tools/reports/index.js";
import { quarterRoutes } from "../../domain/reports/audit/scenario.js";
import {
  regularAccount,
  type ScenarioDocument,
  scenarioRoutes,
  voucherDoc,
} from "../../domain/reports/builders.js";
import { runTool } from "./records.js";

/** The output schema as clients receive it (JSON Schema), compiled once. */
const validateOutput = new Ajv2020({ strict: false }).compile(
  z.toJSONSchema(recordsAuditTool.output, { ...JSON_SCHEMA_OPTIONS, io: "output" }),
);

/** A booked expense voucher (gross 119) of contact `contactId` with `description` as number. */
function bill(id: number, date: string, contactId: number, description: string): ScenarioDocument {
  return {
    row: voucherDoc({ id, date, net: "100", tax: "19", gross: "119", contactId }, { description }),
    positions: [],
  };
}

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
    // What each check reads: positions for two of them, lists only for the other two.
    expect(description).toContain(
      "vat and reverse_charge read documents, contacts and positions (up to 1,500 documents",
    );
    expect(description).toContain(
      "duplicates and recurring_gaps read document lists only (up to 10,000 rows; " +
        "recurring_gaps always about three years around the period)",
    );
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

  it("returns a duplicates finding that matches the published output schema", async () => {
    const vouchers = [
      bill(1, "2026-02-03", 77, "RE-2026-1"),
      bill(2, "2026-02-04", 77, "re 2026 1"),
    ];
    const { data, result } = await runTool(
      recordsAuditTool,
      { check: "duplicates", year: 2026, quarter: 1 },
      scenarioRoutes({ vouchers }),
    );
    const report = data as AuditResult;

    expect(
      report.findings.map((finding) => [
        finding.code,
        finding.severity,
        finding.records.map((record) => record.id),
      ]),
    ).toEqual([["voucher_number_twice", "warning", [1, 2]]]);
    expect(validateOutput(data)).toBe(true);
    expect(result.summary).toBe(
      "Audit duplicates 2026-Q1: 1 finding (1 warning listed) in 2 documents in scope.",
    );
  });

  it("returns a recurring_gaps finding with its missing month that matches the schema", async () => {
    const months = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-03", "2026-04"];
    const vouchers = months.map((month, index) => bill(100 + index, `${month}-15`, 88, month));
    const { data } = await runTool(
      recordsAuditTool,
      { check: "recurring_gaps", year: 2026, quarter: 1 },
      scenarioRoutes({ vouchers }),
    );
    const report = data as AuditResult;

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      code: "monthly_bill_missing",
      missing: ["2026-02"],
      documents: 2,
      records: [{ id: 104 }, { id: 105 }],
    });
    // The bills around the gap are context: no sums.
    expect(report.findings[0]?.net).toBeUndefined();
    expect(validateOutput(data)).toBe(true);
  });

  it("refuses a malformed period before sending anything", async () => {
    await expect(
      runTool(recordsAuditTool, { check: "vat", year: 2026, from: "2026-01-01" }, []),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
