/**
 * Check `duplicates`: a quarter (2026-Q1) of vouchers and sales drafts with known positives and
 * known negatives, among them the false-positive cases the rules name (weekly purchases of the
 * same amount, two receipts told apart by their numbers, "Miete" typed as the description, a
 * description with a year repeated on monthly bills, a reversal, another supplier or direction,
 * drafts across suppliers with another amount or no number, a recent draft, a zero amount).
 */
import { describe, expect, it } from "vitest";

import {
  AMOUNT_WINDOW_DAYS,
  DUPLICATE_FINDING_CODES,
  numberKey,
  STUCK_DRAFT_DAYS,
} from "../../../../../src/domain/reports/audit/duplicates-check.js";
import {
  type AuditResult,
  auditResultSchema,
  runAudit,
} from "../../../../../src/domain/reports/audit/registry.js";
import { resolvePeriod } from "../../../../../src/domain/reports/vat.js";
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
  // Same number, spelled differently, different amounts, two weeks apart: booked twice.
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
    date: "2026-02-17",
    gross: "120.00",
    supplier: 3001,
    number: "re 2026 0042",
    expect: "voucher_number_twice",
  },
  // The earlier one in December (read through the lookback), the later one in the period.
  {
    id: 104,
    date: "2025-12-28",
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
    date: "2026-01-21",
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
  // The same PDF twice as drafts, once without the contact and with the name sevDesk's receipt
  // recognition made up: paired across suppliers by number and gross.
  {
    id: 150,
    date: "2026-03-16",
    gross: "238.00",
    supplier: 3021,
    number: "RE-555",
    draft: true,
    createdOn: "2026-04-14",
    expect: "draft_twice",
  },
  {
    id: 151,
    date: "2026-03-16",
    gross: "238.00",
    supplier: null,
    supplierName: "Seite 1 von 2",
    number: "RE 555",
    draft: true,
    createdOn: "2026-04-14",
    expect: "draft_twice",
  },
  // Two drafts under two different contacts.
  {
    id: 152,
    date: "2026-03-18",
    gross: "61.88",
    supplier: 3022,
    number: "AB-77",
    draft: true,
    createdOn: "2026-04-16",
    expect: "draft_twice",
  },
  {
    id: 153,
    date: "2026-03-18",
    gross: "61.88",
    supplier: 3023,
    number: "ab77",
    draft: true,
    createdOn: "2026-04-16",
    expect: "draft_twice",
  },
  // A booked voucher and a recognised draft of the same receipt without any supplier.
  {
    id: 154,
    date: "2026-03-02",
    gross: "99.00",
    supplier: 3024,
    number: "INV-9001",
    expect: "draft_repeats_voucher",
  },
  {
    id: 155,
    date: "2026-03-02",
    gross: "99.00",
    supplier: null,
    number: "INV 9001",
    draft: true,
    createdOn: "2026-04-12",
    expect: "draft_repeats_voucher",
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
  // Two recent drafts of the same amount, told apart by their numbers: not paired, not stuck.
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
  // "Miete 2026" on every monthly rent voucher, the same amount, March's still a draft: the
  // bills lie four weeks apart, so the year is a description, not a number booked twice.
  {
    id: 160,
    date: "2026-01-01",
    gross: "850.00",
    supplier: 3029,
    number: "Miete 2026",
    expect: "none",
  },
  {
    id: 161,
    date: "2026-02-01",
    gross: "850.00",
    supplier: 3029,
    number: "Miete 2026",
    expect: "none",
  },
  {
    id: 162,
    date: "2026-03-01",
    gross: "850.00",
    supplier: 3029,
    number: "Miete 2026",
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  // A draft and a booked voucher with the same number under two suppliers, another amount.
  {
    id: 163,
    date: "2026-03-20",
    gross: "50.00",
    supplier: 3025,
    number: "INV-9002",
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  {
    id: 164,
    date: "2026-03-20",
    gross: "51.00",
    supplier: 3026,
    number: "INV-9002",
    expect: "none",
  },
  // The same amount under two suppliers, no number.
  {
    id: 165,
    date: "2026-03-22",
    gross: "70.00",
    supplier: 3027,
    number: null,
    draft: true,
    createdOn: "2026-04-10",
    expect: "none",
  },
  { id: 166, date: "2026-03-22", gross: "70.00", supplier: 3028, number: null, expect: "none" },
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

const DOCUMENT_TEMPLATE = (() => {
  const body = loadFixture("recorded/2026-11-10/advanced/documents.json").body as {
    objects: Raw[];
  };
  const row = body.objects[0];
  if (row === undefined) throw new Error("document fixture is empty");
  return row;
})();

/**
 * The receipt checksum of each voucher of a booked same-amount pair, as `GET /Voucher` with
 * `embed=document` sends it in the row: `null` for a file without one, `undefined` for a voucher
 * without a receipt. Vouchers not named here have no receipt either.
 */
const HASHES: Readonly<Record<number, string | null | undefined>> = {
  106: HASH_A,
  107: HASH_B,
  108: HASH_A.toUpperCase(),
  109: HASH_A,
  132: HASH_A,
  133: null,
  113: undefined,
  114: undefined,
};

/**
 * `doc` with its receipt as the voucher list sends it: the whole document when `embedded` (the
 * recorded `GET /Document` row with the checksum), else only the reference.
 */
function withReceipt(
  doc: ScenarioDocument,
  hashes: Readonly<Record<number, string | null | undefined>>,
  embedded = true,
): ScenarioDocument {
  const id = Number(doc.row["id"]);
  const hash = hashes[id];
  if (!(id in hashes) || hash === undefined) return { ...doc, row: { ...doc.row, document: null } };
  const documentId = String(5000 + id);
  const document = embedded
    ? {
        ...structuredClone(DOCUMENT_TEMPLATE),
        id: documentId,
        object: null,
        baseObject: null,
        status: "50",
        contentHash: hash,
      }
    : { id: documentId, objectName: "Document" };
  return { ...doc, row: { ...doc.row, document } };
}

const VOUCHER_DOCS = VOUCHERS.map(voucher).map((doc) => withReceipt(doc, HASHES));

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

function routes(vouchers: readonly ScenarioDocument[] = VOUCHER_DOCS): FakeRoute[] {
  return scenarioRoutes({ vouchers, invoices: INVOICES, creditNotes: CREDIT_NOTES });
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

  it("takes the receipt checksums from the voucher list, without a read by id", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await audit(client);
    const lists = client.calls.filter((call) => call.path === "/Voucher");

    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) {
      expect(call.query).toMatchObject({ embed: "document", voucherType: "VOU", limit: 1000 });
    }
    expect(client.calls.filter((call) => /^\/(Voucher|Document)\/\d+/.test(call.path))).toEqual([]);
    // Same-amount pairs: 106/107, 108/109, 132/133, 113/114; 133 has a receipt without a
    // checksum (as a receipt sevDesk's recognition created), 113 and 114 no receipt file.
    expect(result.notes.join(" ")).toContain(
      "The receipt files of 8 vouchers of same-amount pairs were compared by the SHA-256 " +
        "checksum sevDesk lists with each voucher; 1 voucher has a receipt file without a " +
        "checksum (sevDesk stores none for some receipts, for example those its recognition " +
        "created from an upload), so the same file cannot be confirmed for their pairs, which " +
        "stay possible duplicates; 2 vouchers without a receipt file could not be compared",
    );
    expect(codesById(result).get(133)).toEqual(["voucher_amount_twice"]);
    for (const call of client.calls) expect(call.method).toBe("GET");
  });

  it("keeps a pair a possible duplicate when the list row carries only the reference", async () => {
    // A row without the embedded document (no `embed`, or sevDesk ignored it) has no checksum.
    const plain = VOUCHERS.map(voucher).map((doc) => withReceipt(doc, HASHES, false));
    const result = await audit(new FakeSevdeskClient(routes(plain)));

    expect(codesById(result).get(108)).toEqual(["voucher_amount_twice"]);
    expect(codesById(result).get(109)).toEqual(["voucher_amount_twice"]);
    // Told apart from receipts sevDesk stores without a checksum.
    expect(result.notes.join(" ")).toContain(
      "the list rows of 6 vouchers named the receipt file without embedding it " +
        "(embed=document), so its checksum was not read and their pairs stay possible duplicates",
    );
    expect(result.notes.join(" ")).not.toContain("without a checksum");
    expect(result.notes.join(" ")).toContain("2 vouchers without a receipt file");
  });

  it("states its rules, coverage and the vouchers it could not compare", async () => {
    const result = await audit(new FakeSevdeskClient(routes()));
    const notes = result.notes.join(" ");

    expect(notes).toContain(`at most ${String(AMOUNT_WINDOW_DAYS)} days apart`);
    expect(notes).toContain(`${String(STUCK_DRAFT_DAYS)} days after they were created`);
    expect(notes).toContain("the same document number (with a digit) at most 21 days apart");
    expect(notes).toContain("every invoice and credit note dated in the period was listed");
    expect(notes).toContain(
      "3 vouchers in the period without a supplier (no contact, no supplier name) could be " +
        "compared only in pairs with a draft",
    );
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

  it("pairs drafts across suppliers by number and gross, as checks under a contact with an id", async () => {
    const result = await audit(new FakeSevdeskClient(routes()));
    const across = result.findings
      .filter((finding) => [3021, 3022, 3024].includes(finding.contact?.id ?? 0))
      .map((finding) => [
        finding.code,
        finding.severity,
        finding.contact?.id,
        finding.records.map((record) => record.id),
      ]);

    expect(across).toEqual([
      ["draft_repeats_voucher", "check", 3024, [154, 155]],
      ["draft_twice", "check", 3021, [150, 151]],
      ["draft_twice", "check", 3022, [152, 153]],
    ]);
    expect(result.findings.find((finding) => finding.code === "draft_twice")).toMatchObject({
      title: "Draft repeats another draft",
      titleDe: "Entwurf wiederholt einen anderen Entwurf",
    });
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
