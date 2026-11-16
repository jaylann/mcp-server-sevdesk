/**
 * Check `duplicates`: a quarter (2026-Q1) of vouchers and sales drafts with known positives and
 * known negatives, among them the false-positive cases the rules name (weekly purchases of the
 * same amount, two receipts told apart by their numbers, "Miete" typed as the description, a
 * reversal, another supplier or direction, two drafts, a recent draft, a zero amount).
 */
import { describe, expect, it } from "vitest";

import {
  AMOUNT_WINDOW_DAYS,
  DUPLICATE_FINDING_CODES,
  MAX_RECEIPT_HASH_VOUCHERS,
  numberKey,
  STUCK_DRAFT_DAYS,
} from "../../../../../src/domain/reports/audit/duplicates-check.js";
import {
  type AuditResult,
  auditResultSchema,
  runAudit,
} from "../../../../../src/domain/reports/audit/registry.js";
import { resolvePeriod } from "../../../../../src/domain/reports/vat.js";
import { SevdeskError } from "../../../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../../helpers/fake-client.js";
import {
  creditNoteDoc,
  invoiceDoc,
  type ScenarioDocument,
  scenarioRoutes,
  voucherDoc,
} from "../builders.js";

type Raw = Record<string, unknown>;

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-04-20";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** sevDesk's ISO date-time at 10:00 Berlin (winter time is fine for these days). */
function created(date: string): string {
  return `${date}T10:00:00+01:00`;
}

interface VoucherSpec {
  readonly id: number;
  readonly date: string;
  readonly gross: string;
  /** Contact id; `null` for a voucher known only by its supplier name. */
  readonly supplier: number | null;
  readonly supplierName?: string | null;
  /** The description sevDesk shows as the number; `null` for none. */
  readonly number?: string | null;
  readonly draft?: boolean;
  readonly createdOn?: string;
  readonly kind?: "C" | "D";
}

/** A voucher: gross at 19 %, created on its date unless said otherwise. */
function voucher(spec: VoucherSpec): ScenarioDocument {
  const gross = Number(spec.gross);
  const net = (Math.round((gross / 1.19) * 100) / 100).toFixed(2);
  const tax = (Math.round((gross - Number(net)) * 100) / 100).toFixed(2);
  const extra: Raw = {
    description: spec.number === undefined ? `B-${String(spec.id)}` : spec.number,
    create: created(spec.createdOn ?? spec.date),
  };
  if (spec.supplier === null) {
    extra["supplier"] = null;
    extra["supplierName"] = spec.supplierName ?? null;
    extra["supplierNameAtSave"] = spec.supplierName ?? null;
  }
  return {
    row: voucherDoc(
      {
        id: spec.id,
        date: spec.date,
        net,
        tax,
        gross: spec.gross,
        status: spec.draft === true ? "50" : "100",
        ...(spec.kind === undefined ? {} : { kind: spec.kind }),
        ...(spec.supplier === null ? {} : { contactId: spec.supplier }),
      },
      extra,
    ),
    positions: [],
  };
}

/** What the check must make of each voucher: a finding code or `none`. */
const VOUCHERS: readonly (VoucherSpec & { readonly expect: string })[] = [
  // Same number, spelled differently, different amounts: booked twice.
  {
    id: 101,
    date: "2026-02-03",
    gross: "100.00",
    supplier: 3001,
    number: "RE-2026-0042",
    expect: "voucher_number_twice",
  },
  {
    id: 102,
    date: "2026-03-10",
    gross: "120.00",
    supplier: 3001,
    number: "re 2026 0042",
    expect: "voucher_number_twice",
  },
  // The earlier one in December (read through the lookback), the later one in the period.
  {
    id: 104,
    date: "2025-12-20",
    gross: "50.00",
    supplier: 3009,
    number: "INV-7",
    expect: "voucher_number_twice",
  },
  {
    id: 105,
    date: "2026-01-15",
    gross: "50.00",
    supplier: 3009,
    number: "INV-7",
    expect: "voucher_number_twice",
  },
  // Same amount three days apart, descriptions without a number.
  {
    id: 106,
    date: "2026-02-10",
    gross: "119.00",
    supplier: 3002,
    number: "Tankstelle",
    expect: "voucher_amount_twice",
  },
  {
    id: 107,
    date: "2026-02-13",
    gross: "119.00",
    supplier: 3002,
    number: "Tankstelle",
    expect: "voucher_amount_twice",
  },
  // Same amount, one without a number, the same receipt file: confirmed.
  {
    id: 108,
    date: "2026-03-01",
    gross: "59.50",
    supplier: 3003,
    number: null,
    expect: "voucher_receipt_twice",
  },
  {
    id: 109,
    date: "2026-03-04",
    gross: "59.50",
    supplier: 3003,
    number: "R-77",
    expect: "voucher_receipt_twice",
  },
  // Same amount, different receipt files: stays a possible duplicate.
  {
    id: 132,
    date: "2026-03-05",
    gross: "80.00",
    supplier: 3005,
    number: null,
    expect: "voucher_amount_twice",
  },
  {
    id: 133,
    date: "2026-03-06",
    gross: "80.00",
    supplier: 3005,
    number: null,
    expect: "voucher_amount_twice",
  },
  // A draft that repeats a booked voucher (created recently, so not stuck).
  {
    id: 110,
    date: "2026-01-20",
    gross: "33.00",
    supplier: 3004,
    number: "Q-33",
    expect: "draft_repeats_voucher",
  },
  {
    id: 111,
    date: "2026-03-21",
    gross: "33.00",
    supplier: 3004,
    number: "Q 33",
    draft: true,
    createdOn: "2026-04-15",
    expect: "draft_repeats_voucher",
  },
  // The same by amount: a booked voucher and a draft two days later, neither with a number.
  {
    id: 140,
    date: "2026-03-12",
    gross: "44.00",
    supplier: 3019,
    number: null,
    expect: "draft_repeats_voucher",
  },
  {
    id: 141,
    date: "2026-03-14",
    gross: "44.00",
    supplier: 3019,
    number: null,
    draft: true,
    createdOn: "2026-04-18",
    expect: "draft_repeats_voucher",
  },
  // A draft created on 2026-02-01: stuck.
  {
    id: 112,
    date: "2026-02-01",
    gross: "12.00",
    supplier: 3006,
    draft: true,
    expect: "voucher_draft_stuck",
  },
  // Known only by the supplier name (two spellings): matched by the normalized name.
  {
    id: 113,
    date: "2026-02-20",
    gross: "7.50",
    supplier: null,
    supplierName: "Kiosk Müller",
    number: null,
    expect: "voucher_amount_twice",
  },
  {
    id: 114,
    date: "2026-02-22",
    gross: "7.50",
    supplier: null,
    supplierName: "kiosk  müller",
    number: null,
    expect: "voucher_amount_twice",
  },

  // Negatives. Weekly purchases of the same amount (7 days apart).
  { id: 115, date: "2026-01-05", gross: "25.00", supplier: 3007, number: null, expect: "none" },
  { id: 116, date: "2026-01-12", gross: "25.00", supplier: 3007, number: null, expect: "none" },
  // Same amount two days apart, but two different receipt numbers.
  { id: 117, date: "2026-01-07", gross: "40.00", supplier: 3008, number: "R-1", expect: "none" },
  { id: 118, date: "2026-01-09", gross: "40.00", supplier: 3008, number: "R-2", expect: "none" },
  // "Miete" every month: a text, not a number.
  { id: 119, date: "2026-01-01", gross: "900.00", supplier: 3010, number: "Miete", expect: "none" },
  { id: 120, date: "2026-02-01", gross: "900.00", supplier: 3010, number: "Miete", expect: "none" },
  // A voucher and its reversal.
  { id: 121, date: "2026-01-14", gross: "100.00", supplier: 3011, number: "ST-5", expect: "none" },
  { id: 122, date: "2026-01-28", gross: "-100.00", supplier: 3011, number: "ST-5", expect: "none" },
  // The same number from two suppliers.
  { id: 123, date: "2026-01-16", gross: "10.00", supplier: 3012, number: "A-1", expect: "none" },
  { id: 124, date: "2026-01-16", gross: "10.00", supplier: 3013, number: "A-1", expect: "none" },
  // The same number, once as expense and once as revenue.
  { id: 125, date: "2026-02-16", gross: "10.00", supplier: 3014, number: "X-9", expect: "none" },
  {
    id: 126,
    date: "2026-02-16",
    gross: "10.00",
    supplier: 3014,
    number: "X-9",
    kind: "D",
    expect: "none",
  },
  // Two recent drafts of the same amount: not paired, not stuck.
  {
    id: 127,
    date: "2026-03-20",
    gross: "15.00",
    supplier: 3015,
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  {
    id: 128,
    date: "2026-03-20",
    gross: "15.00",
    supplier: 3015,
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  // A draft created 10 days ago.
  {
    id: 129,
    date: "2026-03-30",
    gross: "18.00",
    supplier: 3016,
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  // A gross of 0 twice on one day doubles nothing.
  { id: 134, date: "2026-02-25", gross: "0", supplier: 3017, number: null, expect: "none" },
  { id: 135, date: "2026-02-25", gross: "0", supplier: 3017, number: null, expect: "none" },
  // No supplier at all: not compared.
  { id: 136, date: "2026-02-26", gross: "5.00", supplier: null, number: null, expect: "none" },
  { id: 137, date: "2026-02-26", gross: "5.00", supplier: null, number: null, expect: "none" },
  // A pair entirely before the period (read through the lookback, reported in December).
  { id: 138, date: "2025-12-10", gross: "60.00", supplier: 3018, number: "D-1", expect: "none" },
  { id: 139, date: "2025-12-12", gross: "60.00", supplier: 3018, number: "D-1", expect: "none" },
];

const VOUCHER_DOCS = VOUCHERS.map(voucher);

/** Sales: one stuck invoice draft, one recent credit note draft, one issued invoice. */
const INVOICES: readonly ScenarioDocument[] = [
  {
    row: invoiceDoc(
      { id: 201, date: "2026-03-01", net: "1000", tax: "190", status: "100" },
      { create: created("2026-03-01") },
    ),
    positions: [],
  },
  {
    row: invoiceDoc(
      { id: 202, date: "2026-01-10", net: "500", tax: "95", status: "200" },
      { create: created("2026-01-10") },
    ),
    positions: [],
  },
];
const CREDIT_NOTES: readonly ScenarioDocument[] = [
  {
    row: creditNoteDoc(
      { id: 301, date: "2026-03-28", net: "50", tax: "9.5", status: "100" },
      { create: created("2026-04-12") },
    ),
    positions: [],
  },
];

const DOCUMENT_TEMPLATE = (() => {
  const body = loadFixture("recorded/2026-11-10/advanced/documents.json").body as {
    objects: Raw[];
  };
  const row = body.objects[0];
  if (row === undefined) throw new Error("document fixture is empty");
  return row;
})();

/**
 * `GET /Voucher/{id}` with the attached document and `GET /Document/{id}` with its checksum, for
 * every voucher of a booked same-amount pair. `undefined` hash: the voucher has no receipt.
 */
function receiptRoutes(
  hashes: Readonly<Record<number, string | null | undefined>>,
  docs: readonly ScenarioDocument[] = VOUCHER_DOCS,
): FakeRoute[] {
  return Object.entries(hashes).flatMap(([id, hash]): FakeRoute[] => {
    const row = docs.find((doc) => doc.row["id"] === id)?.row;
    if (row === undefined) throw new Error(`no voucher ${id} in the scenario`);
    const documentId = String(5000 + Number(id));
    if (hash === undefined) {
      return [
        { path: `/Voucher/${id}`, response: { body: { objects: [{ ...row, document: null }] } } },
      ];
    }
    return [
      {
        path: `/Voucher/${id}`,
        response: {
          body: { objects: [{ ...row, document: { id: documentId, objectName: "Document" } }] },
        },
      },
      {
        path: `/Document/${documentId}`,
        response: {
          body: {
            objects: [
              {
                ...structuredClone(DOCUMENT_TEMPLATE),
                id: documentId,
                baseObject: { id, objectName: "Voucher" },
                contentHash: hash,
              },
            ],
          },
        },
      },
    ];
  });
}

const HASHES = {
  106: HASH_A,
  107: HASH_B,
  108: HASH_A.toUpperCase(),
  109: HASH_A,
  132: HASH_A,
  133: null,
  113: undefined,
  114: undefined,
};

function routes(extra: readonly FakeRoute[] = receiptRoutes(HASHES)): FakeRoute[] {
  return [
    ...scenarioRoutes({ vouchers: VOUCHER_DOCS, invoices: INVOICES, creditNotes: CREDIT_NOTES }),
    ...extra,
  ];
}

async function audit(client: FakeSevdeskClient, options = {}): Promise<AuditResult> {
  return runAudit(client, "duplicates", { period: Q1, cacheOwner: {}, today: TODAY }, options);
}

/** Finding codes by document id. */
function codesById(result: AuditResult): Map<number, string[]> {
  const byId = new Map<number, string[]>();
  for (const finding of result.findings) {
    for (const record of finding.records) {
      byId.set(record.id, [...(byId.get(record.id) ?? []), finding.code]);
    }
  }
  return byId;
}

describe("check duplicates", () => {
  it("finds the known positives and none of the known negatives", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await audit(client);
    const byId = codesById(result);

    for (const spec of VOUCHERS) {
      const found = byId.get(spec.id) ?? [];
      expect({ id: spec.id, codes: found }).toEqual({
        id: spec.id,
        codes: spec.expect === "none" ? [] : [spec.expect],
      });
    }
    expect(byId.get(201)).toEqual(["sales_draft_stuck"]);
    expect(byId.get(202)).toBeUndefined();
    expect(byId.get(301)).toBeUndefined();
    expect(auditResultSchema.parse(result)).toEqual(result);
    expect(client.writes()).toEqual([]);
  });

  it("groups each supplier's pairs into one finding with links, warnings first", async () => {
    const result = await audit(new FakeSevdeskClient(routes()));
    const numbers = result.findings.filter((finding) => finding.code === "voucher_number_twice");

    expect(numbers.map((finding) => finding.contact?.id)).toEqual([3001, 3009]);
    expect(numbers[0]).toMatchObject({
      check: "duplicates",
      severity: "warning",
      documents: 2,
      records: [
        { objectName: "Voucher", id: 101, link: "https://my.sevdesk.de/ex/detail/id/101" },
        { objectName: "Voucher", id: 102 },
      ],
      contact: { id: 3001, link: "https://my.sevdesk.de/crm/detail/id/3001" },
    });
    expect(result.findings[0]?.severity).toBe("warning");
    const byName = result.findings.find(
      (finding) => finding.code === "voucher_amount_twice" && finding.contact?.id === undefined,
    );
    expect(byName?.records.map((record) => record.id)).toEqual([113, 114]);
    expect(byName?.contact?.name).toBe("Kiosk Müller");
    expect(byName?.net).toBeDefined();
  });

  it("reads receipt checksums only for the vouchers of booked same-amount pairs", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await audit(client);
    const voucherReads = client.calls
      .filter((call) => /^\/Voucher\/\d+$/.test(call.path))
      .map((call) => Number(call.path.split("/")[2]))
      .sort((a, b) => a - b);

    expect(voucherReads).toEqual([106, 107, 108, 109, 113, 114, 132, 133]);
    expect(client.calls.filter((call) => call.path.startsWith("/Document/"))).toHaveLength(6);
    expect(result.notes.join(" ")).toContain(
      "Receipt files were compared by SHA-256 checksum for 8 vouchers",
    );
    for (const call of client.calls) expect(call.method).toBe("GET");
  });

  it("stops comparing receipts at the cap and says so", async () => {
    // More same-amount pairs than the cap allows, each with an unknown receipt.
    const count = MAX_RECEIPT_HASH_VOUCHERS / 2 + 3;
    const pairs = Array.from({ length: count }, (_, index) => [
      voucher({
        id: 7000 + index * 2,
        date: "2026-02-02",
        gross: "9.99",
        supplier: 6000 + index,
        number: null,
      }),
      voucher({
        id: 7001 + index * 2,
        date: "2026-02-03",
        gross: "9.99",
        supplier: 6000 + index,
        number: null,
      }),
    ]).flat();
    const noReceipts = Object.fromEntries(pairs.map((doc) => [Number(doc.row["id"]), undefined]));
    const client = new FakeSevdeskClient([
      ...scenarioRoutes({ vouchers: pairs }),
      ...receiptRoutes(noReceipts, pairs),
    ]);
    const result = await audit(client);

    expect(client.calls.filter((call) => /^\/Voucher\/\d+$/.test(call.path))).toHaveLength(
      MAX_RECEIPT_HASH_VOUCHERS,
    );
    expect(result.notes.join(" ")).toContain(
      `the scan was cut at ${String(MAX_RECEIPT_HASH_VOUCHERS)} vouchers, 6 vouchers not compared`,
    );
    expect(result.findings.every((finding) => finding.code === "voucher_amount_twice")).toBe(true);
    expect(result.findings).toHaveLength(count);
  });

  it("stops comparing receipts at the time budget", async () => {
    let now = 0;
    const client = new FakeSevdeskClient(routes());
    const result = await audit(client, {
      deadline: { at: 1, now: () => now++ },
    });

    expect(client.calls.filter((call) => /^\/Voucher\/\d+$/.test(call.path))).toHaveLength(1);
    expect(result.coverage.timeBudgetReached).toBe(true);
    expect(result.notes.join(" ")).toContain("the time budget stopped it");
    // 108/109 could not be confirmed: they stay a possible duplicate.
    expect(codesById(result).get(108)).toEqual(["voucher_amount_twice"]);
  });

  it("keeps a pair a possible duplicate when a receipt cannot be read", async () => {
    const failing: FakeRoute = {
      path: "/Voucher/108",
      response: { error: new SevdeskError({ kind: "not_found", message: "gone" }) },
    };
    const client = new FakeSevdeskClient(routes([failing, ...receiptRoutes(HASHES)]));
    const result = await audit(client);

    expect(codesById(result).get(109)).toEqual(["voucher_amount_twice"]);
    expect(result.notes.join(" ")).toContain("the receipt of 1 voucher could not be read");
  });

  it("states its rules, coverage and the vouchers it could not compare", async () => {
    const result = await audit(new FakeSevdeskClient(routes()));
    const notes = result.notes.join(" ");

    expect(notes).toContain(`at most ${String(AMOUNT_WINDOW_DAYS)} days apart`);
    expect(notes).toContain(`${String(STUCK_DRAFT_DAYS)} days after they were created`);
    expect(notes).toContain("2 vouchers in the period without a supplier");
    const inPeriod = VOUCHERS.filter((spec) => spec.date >= "2026-01-01").length;
    expect(result.coverage).toMatchObject({
      documentsInScope: inPeriod + 2,
      documentsLeftOut: 0,
      truncated: false,
      excluded: { drafts: 0 },
    });
    expect(result.caveatDe).toContain("keine Steuerberatung");
  });

  it("says the scan was cut when the listing stops at its cap", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await runAudit(client, "duplicates", {
      period: Q1,
      cacheOwner: {},
      today: TODAY,
      limits: { maxRows: 5 },
    });

    expect(result.coverage.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain("The scan was cut");
  });

  it("documents its codes", () => {
    expect([...DUPLICATE_FINDING_CODES].sort()).toEqual(
      [...new Set(VOUCHERS.map((spec) => spec.expect))]
        .filter((code) => code !== "none")
        .concat("sales_draft_stuck")
        .sort(),
    );
  });
});

describe("numberKey", () => {
  it("ignores case, spaces and separators and needs a digit", () => {
    expect(numberKey("RE-2026/0042")).toBe("RE20260042");
    expect(numberKey(" re 2026.0042 ")).toBe("RE20260042");
    expect(numberKey("Miete")).toBeUndefined();
    expect(numberKey(undefined)).toBeUndefined();
    expect(numberKey("0")).toBe("0");
  });
});
