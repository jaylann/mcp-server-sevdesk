/**
 * Check `recurring_gaps`: suppliers with known rhythms and known gaps, and the false-positive cases
 * the rules name (amounts that change, two bills in one month, a bill that moved across a month
 * end, a supplier that stopped, too little evidence, sporadic purchases, drafts, revenue).
 */
import { describe, expect, it } from "vitest";

import { decimal } from "../../../../../src/domain/money.js";
import {
  findGaps,
  LOOKAHEAD_MONTHS,
  LOOKBACK_MONTHS,
  rangeRead,
  RECURRING_GAP_FINDING_CODES,
} from "../../../../../src/domain/reports/audit/recurring-gaps-check.js";
import {
  type AuditResult,
  auditResultSchema,
  runAudit,
} from "../../../../../src/domain/reports/audit/registry.js";
import { supplierKeysJoiningNames } from "../../../../../src/domain/reports/audit/supplier-bills.js";
import type { DocumentHeader } from "../../../../../src/domain/reports/positions-scan.js";
import { resolvePeriod } from "../../../../../src/domain/reports/vat.js";
import { FakeSevdeskClient } from "../../../../helpers/fake-client.js";
import { type ScenarioDocument, scenarioRoutes, voucherDoc } from "../builders.js";

type Raw = Record<string, unknown>;

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-06-15";

let nextId = 20_000;

interface BillSpec {
  readonly supplier: number | null;
  readonly supplierName?: string;
  readonly date: string;
  readonly gross?: string;
  readonly draft?: boolean;
  readonly kind?: "C" | "D";
}

function bill(spec: BillSpec): ScenarioDocument {
  nextId += 1;
  const gross = spec.gross ?? "11.90";
  const extra: Raw = {};
  if (spec.supplier === null) {
    extra["supplier"] = null;
    extra["supplierName"] = spec.supplierName ?? null;
    extra["supplierNameAtSave"] = spec.supplierName ?? null;
  } else if (spec.supplierName !== undefined) {
    // sevDesk keeps the supplier name next to the contact.
    extra["supplierName"] = spec.supplierName;
  }
  return {
    row: voucherDoc(
      {
        id: nextId,
        date: spec.date,
        net: gross,
        tax: "0",
        gross,
        status: spec.draft === true ? "50" : "100",
        ...(spec.kind === undefined ? {} : { kind: spec.kind }),
        ...(spec.supplier === null ? {} : { contactId: spec.supplier }),
      },
      extra,
    ),
    positions: [],
  };
}

/** `YYYY-MM` months from `from` to `to`, inclusive. */
function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [year = 0, month = 1] = from.split("-").map(Number);
  for (;;) {
    const label = `${String(year)}-${String(month).padStart(2, "0")}`;
    out.push(label);
    if (label === to) return out;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

function lastDay(month: string): string {
  const [year = 0, m = 1] = month.split("-").map(Number);
  return String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, "0");
}

/** One bill per month on `day` (or the month's last day), leaving out `skip`. */
function monthly(
  supplier: number | null,
  day: number | "last",
  from: string,
  to: string,
  options: {
    readonly skip?: readonly string[];
    readonly gross?: (month: string) => string;
    readonly supplierName?: string;
    readonly kind?: "C" | "D";
    readonly draft?: readonly string[];
  } = {},
): ScenarioDocument[] {
  return months(from, to)
    .filter((month) => !(options.skip ?? []).includes(month))
    .map((month) =>
      bill({
        supplier,
        ...(options.supplierName === undefined ? {} : { supplierName: options.supplierName }),
        date: `${month}-${day === "last" ? lastDay(month) : String(day).padStart(2, "0")}`,
        ...(options.gross === undefined ? {} : { gross: options.gross(month) }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        draft: (options.draft ?? []).includes(month),
      }),
    );
}

const SUPPLIER = {
  telco: 4001,
  endOfMonth: 4002,
  quarterly: 4003,
  stopped: 4005,
  catchUp: 4006,
  sporadic: 4007,
  tooYoung: 4008,
  withDraft: 4009,
  customer: 4010,
} as const;

/** The scenario, by supplier. */
const BILLS = {
  // Monthly on the 15th, price up in 2026, bills missing in June 2025 and February 2026.
  telco: monthly(SUPPLIER.telco, 15, "2025-01", "2026-05", {
    skip: ["2025-06", "2026-02"],
    gross: (month) => (month < "2026-01" ? "39.99" : "44.99"),
  }),
  // Known only by name, monthly on the 1st, March 2026 missing.
  hosting: monthly(null, 1, "2025-01", "2026-05", {
    skip: ["2026-03"],
    supplierName: "Hosting Hans",
  }),
  // Quarterly on the 10th since 2024, January 2026 missing.
  quarterly: [
    "2024-01-10",
    "2024-04-10",
    "2024-07-10",
    "2024-10-10",
    "2025-01-10",
    "2025-04-10",
    "2025-07-10",
    "2025-10-10",
    "2026-04-10",
  ].map((date) => bill({ supplier: SUPPLIER.quarterly, date })),
  // Negatives. Last day of the month; January's bill came on 2 February.
  endOfMonth: [
    ...monthly(SUPPLIER.endOfMonth, "last", "2025-01", "2025-12"),
    bill({ supplier: SUPPLIER.endOfMonth, date: "2026-02-02" }),
    ...monthly(SUPPLIER.endOfMonth, "last", "2026-02", "2026-04"),
  ],
  // Stopped after January 2026.
  stopped: monthly(SUPPLIER.stopped, 20, "2025-01", "2026-01"),
  // February's bill came in March, next to March's own.
  catchUp: [
    ...monthly(SUPPLIER.catchUp, 10, "2025-01", "2026-01"),
    bill({ supplier: SUPPLIER.catchUp, date: "2026-03-08" }),
    ...monthly(SUPPLIER.catchUp, 10, "2026-03", "2026-05"),
  ],
  // Purchases now and then.
  sporadic: [
    "2025-01-03",
    "2025-01-17",
    "2025-01-29",
    "2025-03-08",
    "2025-04-22",
    "2025-04-23",
    "2025-06-02",
    "2025-06-19",
    "2025-06-27",
    "2025-06-30",
    "2025-08-11",
    "2025-09-25",
    "2025-11-05",
    "2025-11-06",
    "2026-01-14",
    "2026-03-28",
    "2026-04-02",
  ].map((date) => bill({ supplier: SUPPLIER.sporadic, date })),
  // Two months before the gap are not enough.
  tooYoung: monthly(SUPPLIER.tooYoung, 15, "2025-11", "2026-04", { skip: ["2026-01"] }),
  // February's bill is a draft: it arrived.
  withDraft: monthly(SUPPLIER.withDraft, 20, "2025-01", "2026-05", { draft: ["2026-02"] }),
  // Revenue every month with a gap: not a supplier's bill.
  customer: monthly(SUPPLIER.customer, 5, "2025-01", "2026-05", { skip: ["2026-02"], kind: "D" }),
  // No supplier at all.
  anonymous: [bill({ supplier: null, date: "2026-02-11" })],
};

const ALL = Object.values(BILLS).flat();

async function audit(
  vouchers: readonly ScenarioDocument[] = ALL,
  params: { readonly today?: string; readonly maxRows?: number } = {},
  period = Q1,
): Promise<{ client: FakeSevdeskClient; result: AuditResult }> {
  const client = new FakeSevdeskClient(scenarioRoutes({ vouchers }));
  const result = await runAudit(client, "recurring_gaps", {
    period,
    cacheOwner: {},
    today: params.today ?? TODAY,
    ...(params.maxRows === undefined ? {} : { limits: { maxRows: params.maxRows } }),
  });
  return { client, result };
}

describe("check recurring_gaps", () => {
  it("finds the missing bills of regular suppliers and nothing else", async () => {
    const { client, result } = await audit();

    expect(
      result.findings.map((finding) => [
        finding.code,
        finding.contact?.id ?? finding.contact?.name,
      ]),
    ).toEqual([
      ["monthly_bill_missing", SUPPLIER.telco],
      ["monthly_bill_missing", "Hosting Hans"],
      ["quarterly_bill_missing", SUPPLIER.quarterly],
    ]);
    expect(auditResultSchema.parse(result)).toEqual(result);
    expect(client.writes()).toEqual([]);
    expect(client.calls.every((call) => call.path === "/Voucher")).toBe(true);
  });

  it("names the missing month and lists the bills around it, without sums", async () => {
    const { result } = await audit();
    const [telco, hosting, quarterly] = result.findings;

    // June 2025 is missing too, but outside the period.
    expect(telco).toMatchObject({
      check: "recurring_gaps",
      severity: "check",
      title: "Monthly bill missing",
      titleDe: "Monatsrechnung fehlt",
      missing: ["2026-02"],
      documents: 2,
    });
    expect(telco?.records.map((record) => record.date)).toEqual(["2026-01-15", "2026-03-15"]);
    expect(telco?.records[0]?.link).toMatch(/^https:\/\/my\.sevdesk\.de\/ex\/detail\/id\/\d+$/);
    expect(telco?.net).toBeUndefined();
    expect(telco?.tax).toBeUndefined();
    expect(hosting?.missing).toEqual(["2026-03"]);
    expect(quarterly).toMatchObject({ missing: ["2026-01"], titleDe: "Quartalsrechnung fehlt" });
    expect(quarterly?.records.map((record) => record.date)).toEqual(["2025-10-10", "2026-04-10"]);
  });

  it("states the range read, the rhythms found and what it could not check", async () => {
    const { result, client } = await audit();
    const notes = result.notes.join(" ");

    expect(notes).toContain("dated 2024-01-01 to 2026-06-15");
    // Monthly: all but the quarterly, the sporadic one and the customer (revenue is not read).
    expect(notes).toContain(
      "Suppliers with a rhythm around the period: 7 monthly, 1 quarterly, 0 yearly.",
    );
    expect(notes).toContain("the supplier's bills of the 12 months before and after it");
    expect(notes).toContain("recurring voucher templates (RV)");
    expect(notes).toContain("1 expense voucher without a supplier");
    const expenses = ALL.filter((doc) => doc.row["creditDebit"] === "C").length;
    expect(result.coverage).toMatchObject({
      documentsInScope: expenses,
      documentsChecked: expenses - 1,
      documentsLeftOut: 1,
      truncated: false,
    });
    expect(client.calls[0]?.query).toMatchObject({ voucherType: "VOU", limit: 1000 });
  });

  it("reports no gaps when the listing was cut, since a voucher not read looks like one", async () => {
    const { result } = await audit(ALL, { maxRows: 50 });

    expect(result.findings).toEqual([]);
    expect(result.coverage.truncated).toBe(true);
    const notes = result.notes.join(" ");
    expect(notes).toContain("The scan was cut: listing vouchers stopped at its cap of 50 rows");
    // The range read is about three years whatever the period: no futile advice.
    expect(notes).toContain("A shorter period does not help");
    expect(notes).not.toContain("Use a shorter period");
  });

  it("counts a bill booked without the contact for the contact of the same name", async () => {
    const telco = 4200;
    const bills = [
      ...monthly(telco, 12, "2025-01", "2026-05", {
        skip: ["2026-02"],
        supplierName: "Telco GmbH",
      }),
      // February was booked by hand without the contact, under the same name.
      bill({ supplier: null, supplierName: "telco  gmbh", date: "2026-02-12" }),
    ];

    const { result } = await audit(bills);
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain(
      "Suppliers with a rhythm around the period: 1 monthly",
    );

    // Without that bill the gap is real, and the finding names the contact.
    const { result: gap } = await audit(bills.slice(0, -1));
    expect(gap.findings).toHaveLength(1);
    expect(gap.findings[0]).toMatchObject({ missing: ["2026-02"], contact: { id: telco } });
  });

  it("finds a missing yearly bill once the next one exists", async () => {
    const yearly = ["2023-02-01", "2024-02-01", "2026-02-03"].map((date) =>
      bill({ supplier: 4100, date }),
    );
    const year2025 = resolvePeriod({ year: 2025 });

    const { result } = await audit(yearly, { today: "2026-11-17" }, year2025);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: "yearly_bill_missing",
      missing: ["2025-02"],
      titleDe: "Jahresrechnung fehlt",
    });

    // Before the next bill came, the supplier may as well have stopped.
    const early = await audit(yearly.slice(0, 2), { today: "2026-01-15" }, year2025);
    expect(early.result.findings).toEqual([]);
  });

  it("documents its codes", () => {
    expect(RECURRING_GAP_FINDING_CODES).toEqual([
      "monthly_bill_missing",
      "quarterly_bill_missing",
      "yearly_bill_missing",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The rules on their own
// ---------------------------------------------------------------------------------------------

function header(id: number, date: string): DocumentHeader {
  return {
    kind: "voucher",
    id,
    date,
    statusCode: 100,
    currency: "EUR",
    direction: "expense",
    sign: 1,
    eur: { net: decimal("10"), tax: decimal("0"), gross: decimal("10") },
    gross: decimal("10"),
  };
}

const headers = (dates: readonly string[]): DocumentHeader[] =>
  dates.map((date, index) => header(index + 1, date));

describe("findGaps", () => {
  const period = { from: "2026-01-01", to: "2026-12-31" };

  it("needs three months with a bill before a monthly gap and one after it", () => {
    const three = findGaps(
      headers(["2026-01-05", "2026-02-05", "2026-03-05", "2026-05-05"]),
      period,
    );
    expect(three?.rhythms.map((rhythm) => rhythm.code)).toEqual(["monthly_bill_missing"]);
    expect(three?.gaps.map((gap) => [gap.rhythm.code, gap.month, gap.expected])).toEqual([
      ["monthly_bill_missing", "2026-04", "2026-04-05"],
    ]);

    const two = findGaps(headers(["2026-02-05", "2026-03-05", "2026-05-05", "2026-06-05"]), period);
    expect(two?.gaps).toEqual([]);
  });

  it("keeps a bill that moved a few days across a month end in its own month", () => {
    const result = findGaps(
      headers(["2026-01-30", "2026-02-27", "2026-03-31", "2026-05-02", "2026-05-30", "2026-06-29"]),
      period,
    );
    expect(result?.rhythms.map((rhythm) => rhythm.code)).toEqual(["monthly_bill_missing"]);
    expect(result?.gaps).toEqual([]);
  });

  it("expects a month-end bill in the gap's own month, on its last day when it is shorter", () => {
    // Typical day 31: June's bill is due on 30 June, not on 1 July.
    const endOfMonth = headers([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-07-31",
    ]);
    const june = findGaps(endOfMonth, { from: "2026-06-01", to: "2026-06-30" });
    expect(june?.gaps.map((gap) => [gap.month, gap.expected])).toEqual([["2026-06", "2026-06-30"]]);
    expect(findGaps(endOfMonth, { from: "2026-07-01", to: "2026-07-31" })?.gaps).toEqual([]);

    // Typical day 30: February's bill is due on 28 February, not on 2 March.
    const thirtieth = headers([
      "2025-10-30",
      "2025-11-30",
      "2025-12-30",
      "2026-01-30",
      "2026-03-30",
      "2026-04-30",
    ]);
    const february = findGaps(thirtieth, { from: "2026-02-01", to: "2026-02-28" });
    expect(february?.gaps.map((gap) => [gap.month, gap.expected])).toEqual([
      ["2026-02", "2026-02-28"],
    ]);
    expect(findGaps(thirtieth, { from: "2026-03-01", to: "2026-03-31" })?.gaps).toEqual([]);
  });

  it("judges each month by the bills around it, so a changed rhythm is not a run of gaps", () => {
    // Monthly on the 10th for two years (March 2025 missing), then quarterly from 2026.
    const monthlyThenQuarterly = headers([
      ...[...Array(24).keys()]
        .map((index) => {
          const year = 2024 + Math.floor(index / 12);
          return `${String(year)}-${String((index % 12) + 1).padStart(2, "0")}-10`;
        })
        .filter((date) => date !== "2025-03-10"),
      "2026-01-10",
      "2026-04-10",
      "2026-07-10",
      "2026-10-10",
    ]);

    // Over the whole range most months hold a bill; around 2026 they do not.
    expect(findGaps(monthlyThenQuarterly, period)?.gaps ?? []).toEqual([]);
    // The monthly era still has its real gap.
    const early = findGaps(monthlyThenQuarterly, { from: "2025-01-01", to: "2025-03-31" });
    expect(early?.gaps.map((gap) => [gap.rhythm.code, gap.month])).toEqual([
      ["monthly_bill_missing", "2025-03"],
    ]);

    // Once a year of quarterly bills exists, a missing quarter is reported as such.
    const quarterly = headers([
      ...[...Array(24).keys()].map((index) => {
        const year = 2023 + Math.floor(index / 12);
        return `${String(year)}-${String((index % 12) + 1).padStart(2, "0")}-10`;
      }),
      "2025-01-10",
      "2025-04-10",
      "2025-07-10",
      "2025-10-10",
      "2026-01-10",
      "2026-07-10",
      "2026-10-10",
    ]);
    const q2 = findGaps(quarterly, { from: "2026-04-01", to: "2026-06-30" });
    expect(q2?.rhythms.map((rhythm) => rhythm.code)).toEqual(["quarterly_bill_missing"]);
    expect(q2?.gaps.map((gap) => [gap.rhythm.code, gap.month])).toEqual([
      ["quarterly_bill_missing", "2026-04"],
    ]);
  });

  it("lets an extra bill next to a gap cover it", () => {
    const result = findGaps(
      headers(["2026-01-10", "2026-02-10", "2026-03-10", "2026-05-06", "2026-05-12", "2026-06-10"]),
      period,
    );
    expect(result?.gaps).toEqual([]);
  });

  it("finds no rhythm in too few or irregular bills", () => {
    expect(findGaps(headers(["2026-01-05", "2026-03-05"]), period)).toBeUndefined();
    expect(
      findGaps(
        headers([
          "2026-01-03",
          "2026-01-28",
          "2026-02-14",
          "2026-04-01",
          "2026-04-20",
          "2026-07-09",
        ]),
        period,
      ),
    ).toBeUndefined();
  });

  it("does not report a gap with no later bill (the supplier stopped)", () => {
    const result = findGaps(headers(["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05"]), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(result?.gaps).toEqual([]);
  });
});

describe("supplierKeysJoiningNames", () => {
  const named = (id: number, contact: { id?: number; name?: string }): DocumentHeader => ({
    ...header(id, "2026-01-05"),
    contact,
  });

  it("joins a voucher known by name to the one contact of that name, and only then", () => {
    const vouchers = [
      named(1, { id: 42, name: "Telco GmbH" }),
      named(2, { name: " telco   GMBH " }),
      named(3, { id: 7, name: "Kiosk" }),
      named(4, { id: 8, name: "Kiosk" }),
      named(5, { name: "kiosk" }),
      named(6, { name: "Bäcker" }),
      named(7, {}),
    ];
    const keyOf = supplierKeysJoiningNames(vouchers);

    expect(vouchers.map(keyOf)).toEqual([
      "id:42",
      "id:42",
      "id:7",
      "id:8",
      // Two contacts carry the name: it joins neither.
      "name:kiosk",
      "name:bäcker",
      undefined,
    ]);
  });
});

describe("rangeRead", () => {
  it(`reads ${String(LOOKBACK_MONTHS)} months back and up to ${String(LOOKAHEAD_MONTHS)} ahead, not past today`, () => {
    expect(rangeRead(Q1, TODAY)).toEqual({ from: "2024-01-01", to: "2026-06-15" });
    expect(rangeRead({ from: "2020-03-15", to: "2020-03-31" }, "2026-11-17")).toEqual({
      from: "2018-03-01",
      to: "2021-03-31",
    });
    // The current month: up to its end, even when today is earlier.
    expect(rangeRead({ from: "2026-11-01", to: "2026-11-30" }, "2026-11-17")).toEqual({
      from: "2024-11-01",
      to: "2026-11-30",
    });
  });
});
