import { describe, expect, it } from "vitest";

import { decimal } from "../../../../../src/domain/money.js";
import {
  AUDIT_CAVEAT_DE,
  buildFindings,
  type FindingDraft,
  type FindingText,
  MAX_FINDING_RECORDS,
  MAX_FINDINGS,
} from "../../../../../src/domain/reports/audit/findings.js";
import {
  AUDIT_CHECK_NAMES,
  AUDIT_CHECKS,
  type AuditResult,
  auditResultSchema,
  auditSentence,
  runAudit,
} from "../../../../../src/domain/reports/audit/registry.js";
import type { DocumentHeader } from "../../../../../src/domain/reports/positions-scan.js";
import { resolvePeriod } from "../../../../../src/domain/reports/vat.js";
import { FakeSevdeskClient } from "../../../../helpers/fake-client.js";
import { regularAccount, scenarioRoutes, voucherDoc, voucherPositions } from "../builders.js";
import { COUNTRY, directoryRoutes } from "./scenario.js";

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });

const WARNING: FindingText = {
  severity: "warning",
  title: "W",
  titleDe: "W",
  reason: "Because.",
  action: "Check.",
};
const CHECK: FindingText = { ...WARNING, severity: "check" };

function header(id: number, date: string, net = "10", kind: DocumentHeader["kind"] = "voucher") {
  return {
    kind,
    id,
    date,
    statusCode: 100,
    currency: "EUR",
    direction: "expense",
    sign: 1,
    taxRuleId: 9,
    eur: { net: decimal(net), tax: decimal(0), gross: decimal(net) },
    gross: decimal(net),
  } satisfies DocumentHeader;
}

function draft(
  code: string,
  contactId: number | undefined,
  id: number,
  text: FindingText = WARNING,
): FindingDraft {
  return {
    code,
    text,
    contact: contactId === undefined ? undefined : { id: contactId, name: `C${String(contactId)}` },
    header: header(id, `2026-01-${String((id % 28) + 1).padStart(2, "0")}`),
  };
}

describe("the check registry", () => {
  it("offers exactly the checks that exist, each with codes and texts", () => {
    expect(AUDIT_CHECK_NAMES).toEqual(["vat", "reverse_charge"]);
    expect(Object.keys(AUDIT_CHECKS).sort()).toEqual([...AUDIT_CHECK_NAMES].sort());
    for (const name of AUDIT_CHECK_NAMES) {
      const check = AUDIT_CHECKS[name];
      expect(check.codes.length).toBeGreaterThan(0);
      expect(check.label.length).toBeGreaterThan(0);
      expect(check.summary).not.toMatch(/^[A-Z]|\.$/);
    }
  });

  it("documents every finding code in the output schema", () => {
    const shape = auditResultSchema.shape.findings.element.shape.code;
    for (const name of AUDIT_CHECK_NAMES) {
      for (const code of AUDIT_CHECKS[name].codes) expect(shape.description).toContain(code);
    }
  });
});

describe("buildFindings", () => {
  it("groups by kind and contact, warnings first, then by kind and contact id", () => {
    const findings = buildFindings("vat", [
      draft("b_check", 2, 1, CHECK),
      draft("a_warning", 3, 2),
      draft("a_warning", 1, 3),
      draft("a_warning", 1, 4),
      draft("a_warning", undefined, 5),
    ]);

    expect(
      findings.map((finding) => [finding.code, finding.contact?.id, finding.documents]),
    ).toEqual([
      ["a_warning", 1, 2],
      ["a_warning", 3, 1],
      ["a_warning", undefined, 1],
      ["b_check", 2, 1],
    ]);
    expect(findings[0]?.contact).toEqual({
      id: 1,
      name: "C1",
      link: "https://my.sevdesk.de/crm/detail/id/1",
    });
  });

  it(`lists at most ${String(MAX_FINDING_RECORDS)} documents but sums all of them`, () => {
    const drafts = Array.from({ length: MAX_FINDING_RECORDS + 3 }, (_, index) =>
      draft("a", 1, index + 1),
    );
    const [finding] = buildFindings("vat", drafts);

    expect(finding?.documents).toBe(MAX_FINDING_RECORDS + 3);
    expect(finding?.records).toHaveLength(MAX_FINDING_RECORDS);
    expect(finding?.recordsOmitted).toBe(3);
    expect(finding?.net).toEqual({ amount: "230.00", currency: "EUR" });
  });

  it("leaves the sums out when no document has EUR values", () => {
    const foreign: FindingDraft = {
      ...draft("a", 1, 1),
      header: { ...header(1, "2026-01-02"), eur: undefined },
    };
    const [finding] = buildFindings("vat", [foreign]);
    expect(finding?.net).toBeUndefined();
    expect(finding?.tax).toBeUndefined();
  });
});

describe("runAudit", () => {
  it(`returns at most ${String(MAX_FINDINGS)} findings and counts the rest`, async () => {
    // One German supplier per voucher under rule 14: one finding each.
    const count = MAX_FINDINGS + 2;
    const contacts = Array.from({ length: count }, (_, index) => ({
      id: 8000 + index,
      name: `Lieferant ${String(index)}`,
      vatNumber: `DE${String(100000000 + index)}`,
      countries: [COUNTRY.DE],
    }));
    const vouchers = contacts.map((contact, index) => ({
      row: voucherDoc({
        id: 9000 + index,
        date: "2026-02-01",
        rule: 14,
        net: "10",
        tax: "0",
        contactId: contact.id,
      }),
      positions: voucherPositions(9000 + index, [{ rate: "0", net: "10", tax: "0" }]),
    }));
    const client = new FakeSevdeskClient([
      regularAccount,
      ...scenarioRoutes({ vouchers }),
      ...directoryRoutes(contacts),
    ]);
    const result = await runAudit(client, "vat", { period: Q1, cacheOwner: {} });

    expect(result.findings).toHaveLength(MAX_FINDINGS);
    expect(result.findingsOmitted).toBe(2);
    expect(result.notes.join(" ")).toContain("2 further findings not listed");
    expect(auditResultSchema.parse(result)).toEqual(result);
    expect(result.caveatDe).toBe(AUDIT_CAVEAT_DE);
  });
});

describe("auditSentence", () => {
  const base: AuditResult = {
    check: "vat",
    period: { from: "2026-01-01", to: "2026-03-31", label: "2026-Q1" },
    source: "s",
    caveat: "c",
    caveatDe: "c",
    findings: [],
    coverage: {
      rowsRead: 3,
      documentsInScope: 3,
      documentsChecked: 3,
      documentsLeftOut: 0,
      truncated: false,
      excluded: { drafts: 0, recurringTemplates: 0, reminders: 0, unknownDirection: 0 },
    },
    notes: [],
  };

  it("counts findings and warnings", () => {
    expect(auditSentence(base)).toBe("Audit vat 2026-Q1: no findings in 3 documents in scope.");
    const findings = buildFindings("vat", [draft("a", 1, 1), draft("b", 1, 2, CHECK)]);
    expect(auditSentence({ ...base, findings, findingsOmitted: 1 })).toBe(
      "Audit vat 2026-Q1: 3 findings (1 warning listed) in 3 documents in scope.",
    );
  });

  it("adds the § 13b totals and says when reading was incomplete", () => {
    const euro = (amount: string) => ({ amount, currency: "EUR" });
    const reverseCharge = {
      received: [],
      issued: [],
      totals: { base: euro("100.00"), tax: euro("19.00"), inputTax: euro("19.00") },
    };
    expect(
      auditSentence({
        ...base,
        check: "reverse_charge",
        reverseCharge,
        coverage: { ...base.coverage, truncated: true, timeBudgetReached: true },
      }),
    ).toBe(
      "Audit reverse_charge 2026-Q1: no findings in 3 documents in scope. § 13b received: base " +
        "100.00 EUR, tax owed 19.00 EUR, deductible 19.00 EUR. Incomplete: the time budget " +
        "stopped reading; use a shorter period.",
    );
    expect(auditSentence({ ...base, coverage: { ...base.coverage, truncated: true } })).toContain(
      "Incomplete: not everything could be read",
    );
  });
});
