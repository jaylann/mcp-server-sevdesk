import { describe, expect, it } from "vitest";

import { decimal, toDecimalString } from "../../../../src/domain/money.js";
import {
  allocate,
  collectPaidDocuments,
  contributedAmounts,
  contributionsOf,
  type DocumentHeader,
  documentKey,
  type DocumentPayment,
  fetchDocumentHeader,
  listDocumentHeaders,
  loadContactVatIds,
  mapLimited,
  normalizeRate,
  normalizeVatId,
  percentOf,
  ratioOf,
  scanPositions,
  sumOf,
  voucherDirections,
} from "../../../../src/domain/reports/positions-scan.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  creditNoteDoc,
  creditNotePositions,
  invoiceDoc,
  invoicePositions,
  scenarioRoutes,
  voucherDoc,
  voucherPositions,
} from "./builders.js";

const s = (value: { units: bigint; scale: number }): string => toDecimalString(value);
const TODAY = "2026-11-08";

describe("listDocumentHeaders", () => {
  it("lists invoices, credit notes and vouchers in the window and leaves out drafts, templates and reminders", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          { row: invoiceDoc({ id: 1, date: "2026-03-05", net: "100", tax: "19" }), positions: [] },
          {
            row: invoiceDoc({ id: 2, date: "2026-03-06", net: "10", tax: "1.9", status: "100" }),
            positions: [],
          },
          {
            row: invoiceDoc(
              { id: 3, date: "2026-03-07", net: "10", tax: "1.9" },
              { invoiceType: "WKR" },
            ),
            positions: [],
          },
          {
            row: invoiceDoc(
              { id: 4, date: "2026-03-08", net: "0", tax: "0" },
              { invoiceType: "MA" },
            ),
            positions: [],
          },
          // Outside the window: sevDesk's looser bound let it in, the re-check drops it.
          { row: invoiceDoc({ id: 5, date: "2026-04-01", net: "1", tax: "0.19" }), positions: [] },
        ],
        creditNotes: [
          {
            row: creditNoteDoc({ id: 11, date: "2026-03-10", net: "20", tax: "3.8" }),
            positions: [],
          },
          {
            row: creditNoteDoc({
              id: 12,
              date: "2026-03-10",
              net: "20",
              tax: "3.8",
              status: "100",
            }),
            positions: [],
          },
        ],
        vouchers: [
          { row: voucherDoc({ id: 21, date: "2026-03-12", net: "50", tax: "9.5" }), positions: [] },
          {
            row: voucherDoc({ id: 22, date: "2026-03-12", net: "50", tax: "9.5", status: "50" }),
            positions: [],
          },
          {
            row: voucherDoc(
              { id: 23, date: "2026-03-12", net: "50", tax: "9.5" },
              { voucherType: "RV" },
            ),
            positions: [],
          },
          {
            row: voucherDoc(
              { id: 24, date: "2026-03-12", net: "50", tax: "9.5" },
              { creditDebit: null },
            ),
            positions: [],
          },
        ],
      }),
    );

    const list = await listDocumentHeaders(client, {
      from: "2026-03-01",
      to: "2026-03-31",
      today: TODAY,
    });

    expect(list.headers.map((header) => `${header.kind}:${String(header.id)}`)).toEqual([
      "invoice:1",
      "credit_note:11",
      "voucher:21",
    ]);
    expect(list.excluded).toEqual({
      draft: 3,
      recurring_template: 2,
      reminder: 1,
      unknown_direction: 1,
    });
    expect(list.rowsRead).toBe(11);
    expect(list.truncated).toBe(false);
    const invoiceCall = client.callsTo("/Invoice")[0];
    expect(invoiceCall?.query).toMatchObject({ embed: "contact", limit: 1000, offset: 0 });
    expect(invoiceCall?.query["startDate"]).toBeTypeOf("number");
    expect(client.callsTo("/Voucher")[0]?.query).toMatchObject({ voucherType: "VOU" });
  });

  it("maps the header fields the reports need", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          {
            row: invoiceDoc({
              id: 1,
              date: "2026-03-05",
              delivery: "2026-02-20",
              deliveryUntil: "2026-02-28",
              net: "100",
              tax: "19",
              vatNumber: "ATU 123.456-78",
              countryId: 2,
              payDate: "2026-03-20",
            }),
            positions: [],
          },
        ],
        creditNotes: [
          {
            row: creditNoteDoc({ id: 11, date: "2026-03-10", net: "20", tax: "3.8", rule: 9 }),
            positions: [],
          },
          {
            row: creditNoteDoc({ id: 12, date: "2026-03-10", net: "20", tax: "3.8" }),
            positions: [],
          },
        ],
        vouchers: [
          {
            row: voucherDoc({
              id: 21,
              date: "2026-03-12",
              net: "50",
              tax: "9.5",
              kind: "D",
              rule: 1,
            }),
            positions: [],
          },
        ],
      }),
    );

    const { headers } = await listDocumentHeaders(client, {
      from: "2026-03-01",
      to: "2026-03-31",
      today: TODAY,
    });

    const [inv, cnExpense, cnRevenue, rev] = headers;
    expect(inv).toMatchObject({
      kind: "invoice",
      number: "RE-1",
      date: "2026-03-05",
      deliveryDate: "2026-02-20",
      deliveryDateUntil: "2026-02-28",
      payDate: "2026-03-20",
      taxRuleId: 1,
      direction: "revenue",
      sign: 1,
      contactVatId: "ATU12345678",
      countryId: 2,
      invoiceType: "RE",
    });
    expect(inv?.eur && s(inv.eur.gross)).toBe("119");
    // An expense rule on a credit note: a self-billed credit note to a supplier.
    expect(cnExpense).toMatchObject({ kind: "credit_note", direction: "expense", sign: 1 });
    expect(cnRevenue).toMatchObject({ kind: "credit_note", direction: "revenue", sign: -1 });
    expect(rev).toMatchObject({
      kind: "voucher",
      direction: "revenue",
      taxRuleId: 1,
      number: "B-21",
    });
  });

  it("maps Update 1.0 tax types to the rules that replace them and flags them", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          {
            row: invoiceDoc(
              { id: 1, date: "2026-03-05", net: "100", tax: "0", rule: null },
              { taxType: "eu" },
            ),
            positions: [],
          },
          {
            row: invoiceDoc(
              { id: 2, date: "2026-03-05", net: "100", tax: "0", rule: null },
              { taxType: "custom" },
            ),
            positions: [],
          },
        ],
        vouchers: [
          {
            row: voucherDoc(
              { id: 21, date: "2026-03-12", net: "50", tax: "9.5", rule: null },
              { taxType: "default" },
            ),
            positions: [],
          },
        ],
      }),
    );

    const { headers } = await listDocumentHeaders(client, {
      from: "2026-03-01",
      to: "2026-03-31",
      today: TODAY,
    });

    // "eu" covers goods and services alike: kept as the legacy type, no rule guessed.
    expect(headers.map((header) => [header.taxRuleId, header.legacyTaxType])).toEqual([
      [undefined, "eu"],
      [undefined, "custom"],
      [9, "default"],
    ]);
  });

  it("marks foreign-currency documents without EUR values as unconvertible", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          {
            row: invoiceDoc({
              id: 1,
              date: "2026-03-05",
              currency: "USD",
              net: "84.03",
              tax: "15.97",
              foreign: { net: "100", tax: "19", gross: "119" },
            }),
            positions: [],
          },
          {
            row: invoiceDoc({ id: 2, date: "2026-03-05", currency: "USD", net: "100", tax: "19" }),
            positions: [],
          },
        ],
      }),
    );

    const { headers } = await listDocumentHeaders(client, {
      from: "2026-03-01",
      to: "2026-03-31",
      kinds: ["invoice"],
      today: TODAY,
    });

    expect(headers[0]?.eur && s(headers[0].eur.net)).toBe("84.03");
    expect(headers[0]?.gross && s(headers[0].gross)).toBe("119");
    expect(headers[1]?.eur).toBeUndefined();
  });

  it("stops at the row cap and reports truncated", async () => {
    const invoices = Array.from({ length: 5 }, (_, index) => ({
      row: invoiceDoc({ id: index + 1, date: "2026-03-05", net: "1", tax: "0.19" }),
      positions: [],
    }));
    const client = new FakeSevdeskClient(scenarioRoutes({ invoices }));

    const capped = await listDocumentHeaders(client, {
      from: "2026-03-01",
      to: "2026-03-31",
      maxRows: 3,
      today: TODAY,
    });
    expect(capped.headers).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect(client.callsTo("/CreditNote")).toHaveLength(0);
  });
});

describe("fetchDocumentHeader", () => {
  it("reads one document by id, embedding the contact for sales documents only", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Invoice/7",
        response: {
          body: { objects: [invoiceDoc({ id: 7, date: "2026-03-05", net: "1", tax: "0.19" })] },
        },
      },
      {
        path: "/Voucher/8",
        response: {
          body: { objects: [voucherDoc({ id: 8, date: "2026-03-05", net: "1", tax: "0.19" })] },
        },
      },
      {
        path: "/CreditNote/9",
        response: {
          body: { objects: [creditNoteDoc({ id: 9, date: "2026-03-05", net: "1", tax: "0.19" })] },
        },
      },
    ]);

    await expect(
      fetchDocumentHeader(client, { objectName: "Invoice", id: 7 }, undefined, TODAY),
    ).resolves.toMatchObject({ kind: "invoice", id: 7 });
    await expect(
      fetchDocumentHeader(client, { objectName: "Voucher", id: 8 }),
    ).resolves.toMatchObject({ kind: "voucher", id: 8 });
    await expect(
      fetchDocumentHeader(client, { objectName: "CreditNote", id: 9 }),
    ).resolves.toMatchObject({ kind: "credit_note", id: 9 });
    expect(client.callsTo("/Invoice/7")[0]?.query).toEqual({ embed: "contact" });
    expect(client.callsTo("/Voucher/8")[0]?.query).toEqual({});
  });
});

async function headersOf(routes: Parameters<typeof scenarioRoutes>[0]) {
  const client = new FakeSevdeskClient(scenarioRoutes(routes));
  const { headers } = await listDocumentHeaders(client, {
    from: "2026-01-01",
    to: "2026-12-31",
    today: TODAY,
  });
  return { client, headers };
}

describe("scanPositions", () => {
  it("groups positions by rate and uses them as they are when they add up", async () => {
    const { client, headers } = await headersOf({
      invoices: [
        {
          row: invoiceDoc({ id: 1, date: "2026-03-05", net: "300", tax: "45" }),
          positions: invoicePositions(1, [
            { rate: "19", net: "100", tax: "19" },
            { rate: "19.00", net: "100", tax: "19" },
            { rate: "7", net: "100", tax: "7" },
            { rate: "19", net: "999", tax: "189.81", optional: true },
          ]),
        },
      ],
    });

    const scan = await scanPositions(client, headers);

    expect(scan.documents).toHaveLength(1);
    const doc = scan.documents[0];
    expect(doc?.adjusted).toBe(false);
    expect(doc?.groups.map((group) => [group.rate, s(group.net), s(group.tax)])).toEqual([
      ["19", "200", "38"],
      ["7", "100", "7"],
    ]);
    expect(client.callsTo("/InvoicePos")[0]?.query).toMatchObject({
      "invoice[id]": 1,
      "invoice[objectName]": "Invoice",
    });
  });

  it("splits the document totals over the groups when the positions do not add up (discounts)", async () => {
    const { client, headers } = await headersOf({
      invoices: [
        {
          // 10 % document discount: positions 100 + 100, document 180 net.
          row: invoiceDoc({ id: 1, date: "2026-03-05", net: "180", tax: "23.4" }),
          positions: invoicePositions(1, [
            { rate: "19", net: "100", tax: "19" },
            { rate: "7", net: "100", tax: "7" },
          ]),
        },
      ],
    });

    const [doc] = (await scanPositions(client, headers)).documents;

    expect(doc?.adjusted).toBe(true);
    expect(doc?.groups.map((group) => [group.rate, s(group.net), s(group.tax)])).toEqual([
      ["19", "90", "17.1"],
      ["7", "90", "6.3"],
    ]);
    expect(s(sumOf(doc?.groups.map((group) => group.net) ?? []))).toBe("180");
  });

  it("uses EUR position sums of foreign-currency documents, or scales their own sums to the EUR totals", async () => {
    const { client, headers } = await headersOf({
      invoices: [
        {
          row: invoiceDoc({
            id: 1,
            date: "2026-03-05",
            currency: "USD",
            net: "90",
            tax: "17.1",
            foreign: { net: "100", tax: "19", gross: "119" },
          }),
          positions: invoicePositions(1, [
            {
              rate: "19",
              net: "90",
              tax: "17.1",
              foreign: { net: "100", tax: "19", gross: "119" },
            },
          ]),
        },
        {
          row: invoiceDoc({
            id: 2,
            date: "2026-03-06",
            currency: "USD",
            net: "45",
            tax: "8.55",
            foreign: { net: "50", tax: "9.5", gross: "59.5" },
          }),
          // Positions without EUR sums (foreign sums zero): their amounts only give proportions.
          positions: invoicePositions(2, [{ rate: "19", net: "50", tax: "9.5" }]),
        },
      ],
    });

    const scan = await scanPositions(client, headers);

    expect(
      scan.documents.map((doc) => [doc.adjusted, s(doc.groups[0]?.net ?? decimal(0))]),
    ).toEqual([
      [false, "90"],
      [true, "45"],
    ]);
  });

  it("negates revenue credit notes, keeps accounts and asset flags of voucher positions", async () => {
    const { client, headers } = await headersOf({
      creditNotes: [
        {
          row: creditNoteDoc({ id: 11, date: "2026-03-10", net: "20", tax: "3.8" }),
          positions: creditNotePositions(11, [{ rate: "19", net: "20", tax: "3.8" }]),
        },
      ],
      vouchers: [
        {
          row: voucherDoc({ id: 21, date: "2026-03-12", net: "1100", tax: "209" }),
          positions: voucherPositions(21, [
            { rate: "19", net: "100", tax: "19", account: 4930 },
            { rate: "19", net: "1000", tax: "190", account: 135, asset: true },
          ]),
        },
      ],
    });

    const scan = await scanPositions(client, headers);

    expect(scan.documents[0]?.groups.map((group) => [s(group.net), s(group.tax)])).toEqual([
      ["-20", "-3.8"],
    ]);
    expect(
      scan.documents[1]?.groups.map((group) => [group.accountDatevId, group.isAsset, s(group.net)]),
    ).toEqual([
      [4930, false, "100"],
      [135, true, "1000"],
    ]);
  });

  it("derives the rate of a document without positions", async () => {
    const { client, headers } = await headersOf({
      invoices: [
        { row: invoiceDoc({ id: 1, date: "2026-03-05", net: "100", tax: "19.04" }), positions: [] },
        { row: invoiceDoc({ id: 2, date: "2026-03-05", net: "100", tax: "16" }), positions: [] },
        { row: invoiceDoc({ id: 3, date: "2026-03-05", net: "0", tax: "0" }), positions: [] },
      ],
    });

    const scan = await scanPositions(client, headers);

    expect(scan.documents.map((doc) => [doc.derivedRate, doc.groups[0]?.rate])).toEqual([
      [true, "19"],
      [true, "16"],
      [true, "0"],
    ]);
  });

  it("caps the documents read, lists unconvertible ones, reports progress and keeps the order", async () => {
    const invoices = Array.from({ length: 6 }, (_, index) => ({
      row: invoiceDoc({ id: index + 1, date: "2026-03-05", net: "10", tax: "1.9" }),
      positions: invoicePositions(index + 1, [{ rate: "19", net: "10", tax: "1.9" }]),
    }));
    invoices.push({
      row: invoiceDoc({ id: 99, date: "2026-03-05", currency: "CHF", net: "10", tax: "0" }),
      positions: [],
    });
    const { client, headers } = await headersOf({ invoices });
    const progress: [number, number | undefined, string][] = [];

    const scan = await scanPositions(client, headers, {
      maxDocuments: 4,
      onProgress: (done, total, message) => {
        progress.push([done, total, message]);
      },
    });

    expect(scan.documents.map((doc) => doc.header.id)).toEqual([1, 2, 3, 4]);
    expect(scan.notRead).toBe(2);
    expect(scan.unconvertible).toEqual([{ objectName: "Invoice", id: 99, number: "RE-99" }]);
    expect(progress.at(-1)).toEqual([4, 4, "Read the positions of 4 of 4 documents."]);
  });

  it("stops with an aborted error when cancelled", async () => {
    const { client, headers } = await headersOf({
      invoices: [
        {
          row: invoiceDoc({ id: 1, date: "2026-03-05", net: "10", tax: "1.9" }),
          positions: invoicePositions(1, [{ rate: "19", net: "10", tax: "1.9" }]),
        },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanPositions(client, headers, { signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("refuses an unreadable tax rate", () => {
    expect(normalizeRate(undefined)).toBe("0");
    expect(normalizeRate(" ")).toBe("0");
    expect(normalizeRate("19.00")).toBe("19");
    expect(() => normalizeRate("neunzehn")).toThrow(SevdeskError);
  });
});

describe("exact helpers", () => {
  it("ratioOf rounds half away from zero and refuses division by zero", () => {
    expect(s(ratioOf(decimal("100"), decimal("1"), decimal("3")))).toBe("33.33");
    expect(s(ratioOf(decimal("0.05"), decimal("1"), decimal("2")))).toBe("0.03");
    expect(s(ratioOf(decimal("-0.05"), decimal("1"), decimal("2")))).toBe("-0.03");
    expect(s(ratioOf(decimal("10"), decimal("-1"), decimal("4")))).toBe("-2.5");
    expect(() => ratioOf(decimal(1), decimal(1), decimal(0))).toThrow("division by zero");
  });

  it("percentOf computes cents", () => {
    expect(s(percentOf(decimal("100.55"), "19"))).toBe("19.1");
    expect(s(percentOf(decimal("0.5"), "7"))).toBe("0.04");
  });

  it("allocate splits exactly, with fallbacks for zero weights", () => {
    const parts = allocate(decimal("10"), [decimal(1), decimal(1), decimal(1)], []);
    expect(parts.map(s)).toEqual(["3.33", "3.33", "3.34"]);
    expect(
      allocate(decimal("5"), [decimal(0), decimal(0)], [decimal(1), decimal(3)]).map(s),
    ).toEqual(["1.25", "3.75"]);
    expect(
      allocate(decimal("5"), [decimal(0), decimal(0)], [decimal(0), decimal(0)]).map(s),
    ).toEqual(["5", "0"]);
    expect(allocate(decimal("6"), [decimal(2), decimal(0)], []).map(s)).toEqual(["6", "0"]);
  });

  it("normalizeVatId strips separators and empties", () => {
    expect(normalizeVatId(" fr 12 345.678-90 ")).toBe("FR1234567890");
    expect(normalizeVatId("  ")).toBeUndefined();
    expect(normalizeVatId(undefined)).toBeUndefined();
  });

  it("mapLimited keeps the order and rethrows the first failure", async () => {
    await expect(
      mapLimited([3, 1, 2], 2, async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value));
        return value * 10;
      }),
    ).resolves.toEqual([30, 10, 20]);
    let started = 0;
    await expect(
      mapLimited([1, 2, 3, 4, 5], 1, (value) => {
        started += 1;
        return value === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(value);
      }),
    ).rejects.toThrow("boom");
    expect(started).toBe(2);
    await expect(mapLimited([], 4, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});

describe("payments", () => {
  const header = (overrides: Partial<DocumentHeader>): DocumentHeader => ({
    kind: "invoice",
    id: 1,
    statusCode: 1000,
    currency: "EUR",
    direction: "revenue",
    sign: 1,
    eur: { net: decimal(100), tax: decimal(19), gross: decimal(119) },
    gross: decimal(119),
    ...overrides,
  });
  const payment = (
    id: number,
    amount: string,
    currency = "EUR",
    objectName: DocumentPayment["document"]["objectName"] = "Invoice",
    signed = amount,
  ): DocumentPayment => ({
    date: "2026-03-10",
    document: { objectName, id },
    amount: { amount, currency },
    direction: signed.startsWith("-") ? "out" : "in",
    signedForDocument: { amount: signed, currency },
    transactionId: 500 + id,
    checkAccountId: undefined,
  });

  it("matches payments to known or fetched documents and skips excluded, refused and other-currency ones", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Voucher/8",
        response: {
          body: {
            objects: [
              voucherDoc({ id: 8, date: "2026-03-05", net: "10", tax: "1.9", status: "50" }),
            ],
          },
        },
      },
      {
        path: "/CreditNote/9",
        response: {
          body: { objects: [creditNoteDoc({ id: 9, date: "2026-03-05", net: "10", tax: "1.9" })] },
        },
      },
    ]);
    const known = new Map([[documentKey({ objectName: "Invoice", id: 1 }), header({})]]);

    const paid = await collectPaidDocuments(
      client,
      {
        payments: [
          payment(1, "50"),
          payment(1, "69"),
          payment(1, "5", "USD"),
          payment(8, "11.9", "EUR", "Voucher"),
          payment(9, "11.9", "EUR", "CreditNote"),
        ],
        truncated: true,
        notes: ["From the log."],
        transactionsScanned: 4,
        transactionsRead: 0,
      },
      { known, accept: (h) => h.kind !== "credit_note" },
    );

    expect(paid.headers.map((h) => h.id)).toEqual([1]);
    expect(paid.payments.get("Invoice:1")?.map((p) => p.amount.amount)).toEqual(["50", "69"]);
    expect(paid.coverage).toEqual({ read: 5, used: 2, documentsFetched: 2, truncated: true });
    expect(paid.excluded.draft).toBe(1);
    expect(paid.notes).toEqual([
      "From the log.",
      "1 payment in another currency than the document were left out.",
    ]);
  });

  it("turns payments into shares of their document, capped at the whole", () => {
    const doc = {
      header: header({}),
      groups: [{ rate: "19", net: decimal(100), tax: decimal(19), isAsset: false }],
      positionsComplete: true,
      adjusted: false,
      derivedRate: false,
    };
    const zero = { ...doc, header: header({ id: 2, gross: decimal(0) }) };
    const negative = { ...doc, header: header({ id: 3, gross: decimal(-119) }) };
    const whole = { ...doc, header: header({ id: 4 }) };
    const payments = new Map([
      ["Invoice:1", [payment(1, "59.5"), payment(1, "500")]],
      ["Invoice:2", [payment(2, "1")]],
      ["Invoice:3", [payment(3, "119")]],
    ]);

    payments.set("Invoice:4", [payment(4, "119"), payment(4, "119", "EUR", "Invoice", "-119")]);

    const contributions = contributionsOf([doc, zero, negative, whole], payments);

    expect(
      contributions.map((c) =>
        c.share === undefined ? "all" : `${s(c.share.paid)}/${s(c.share.gross)}`,
      ),
    ).toEqual(["59.5/119", "119/119", "119/119", "119/119", "-119/119"]);
    const amounts = contributedAmounts(doc.groups[0] as never, contributions[0]?.share);
    expect([s(amounts.net), s(amounts.tax)]).toEqual(["50", "9.5"]);
    // A bounced debit takes back what its payment added.
    const bounced = contributedAmounts(doc.groups[0] as never, contributions[4]?.share);
    expect([s(bounced.net), s(bounced.tax)]).toEqual(["-100", "-19"]);
    const none = contributionsOf([whole], new Map());
    expect(none).toEqual([{ document: whole }]);
  });

  it("caps the documents read by id and fetches them a few at a time", async () => {
    const routes = [1, 2, 3].map((id) => ({
      path: `/Invoice/${String(id)}`,
      response: {
        body: { objects: [invoiceDoc({ id, date: "2026-03-05", net: "10", tax: "1.9" })] },
      },
    }));
    const client = new FakeSevdeskClient(routes);

    const paid = await collectPaidDocuments(
      client,
      {
        payments: [payment(1, "1"), payment(2, "1"), payment(1, "2"), payment(3, "1")],
        truncated: false,
        notes: [],
        transactionsScanned: 4,
        transactionsRead: 4,
      },
      { accept: () => true, maxFetches: 2, today: TODAY },
    );

    expect(paid.headers.map((h) => h.id)).toEqual([1, 2]);
    expect(paid.coverage).toEqual({ read: 4, used: 3, documentsFetched: 2, truncated: true });
    expect(paid.notes.join(" ")).toContain("beyond the cap of 2 documents");
    expect(client.callsTo("/Invoice/3")).toEqual([]);
  });

  it("knows voucher directions from listed headers", () => {
    const direction = voucherDirections([
      header({ kind: "voucher", id: 8, direction: "expense" }),
      header({ kind: "voucher", id: 9, direction: "revenue" }),
      header({ kind: "voucher", id: 10, direction: undefined }),
      header({ id: 11 }),
    ]);
    expect([direction(8), direction(9), direction(10), direction(11)]).toEqual([
      "out",
      "in",
      undefined,
      undefined,
    ]);
  });
});

describe("loadContactVatIds", () => {
  it("reads each contact once and treats unreadable contacts as without VAT id", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Contact/5",
        response: {
          body: { objects: [{ id: "5", objectName: "Contact", name: "X", vatNumber: "fr 123" }] },
        },
      },
      {
        path: "/Contact/6",
        response: { error: new SevdeskError({ kind: "not_found", message: "gone" }) },
      },
    ]);

    const ids = await loadContactVatIds(client, [6, 5, 5]);

    expect([...ids.entries()]).toEqual([
      [5, "FR123"],
      [6, undefined],
    ]);
    expect(client.callsTo("/Contact/5")).toHaveLength(1);
  });

  it("rethrows cancellations", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Contact/5",
        response: { error: new SevdeskError({ kind: "aborted", message: "x" }) },
      },
    ]);
    await expect(loadContactVatIds(client, [5])).rejects.toMatchObject({ kind: "aborted" });
  });
});
