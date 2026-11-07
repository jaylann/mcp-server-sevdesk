import { describe, expect, it } from "vitest";

import {
  addDays,
  allOf,
  cleanText,
  contactRef,
  documentListData,
  documentListSummary,
  documentTotals,
  listDocumentPositions,
  listDocuments,
  loadUnitNames,
  matchesNumber,
  type PositionRecord,
  refId,
  SCAN_MAX_ROWS,
  sentDto,
  splitTotals,
  statusDto,
  taxDto,
  toPositionDto,
} from "../../../src/domain/document-positions.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

const NO_UNITS: ReadonlyMap<number, string> = new Map();

/** A shared-fields record with every optional field unset. */
function salesRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 100,
    ...overrides,
  } as Parameters<typeof taxDto>[0];
}

describe("totals", () => {
  it("uses sumNet/sumTax/sumGross for EUR documents", () => {
    expect(splitTotals({ sumNet: "100", sumTax: "19", sumGross: "119" }, "EUR")).toEqual({
      totals: {
        net: { amount: "100.00", currency: "EUR" },
        tax: { amount: "19.00", currency: "EUR" },
        gross: { amount: "119.00", currency: "EUR" },
      },
      eur: undefined,
    });
  });

  it("splits foreign-currency documents into document currency and EUR", () => {
    const { totals, eur } = splitTotals(
      {
        sumNet: "92.59",
        sumTax: "0",
        sumGross: "92.59",
        sumNetForeignCurrency: "100",
        sumTaxForeignCurrency: "0",
        sumGrossForeignCurrency: "100",
      },
      "USD",
    );
    expect(totals.gross).toEqual({ amount: "100.00", currency: "USD" });
    expect(eur?.gross).toEqual({ amount: "92.59", currency: "EUR" });
  });

  it("does not claim an EUR figure when a foreign document has no converted sums", () => {
    const { totals, eur } = splitTotals(
      { sumNet: "10", sumNetForeignCurrency: "0", sumGrossForeignCurrency: undefined },
      "CHF",
    );
    expect(totals).toEqual({ net: { amount: "10.00", currency: "CHF" } });
    expect(eur).toBeUndefined();
  });

  it("keeps sevDesk's precision and zero values", () => {
    expect(splitTotals({ sumNet: "0", sumTax: "0.005" }, "EUR").totals).toEqual({
      net: { amount: "0.00", currency: "EUR" },
      tax: { amount: "0.005", currency: "EUR" },
    });
  });

  it("reports document discounts only when there are some", () => {
    expect(documentTotals({ sumNet: "1", sumDiscounts: "0" })).toEqual({
      currency: "EUR",
      totals: { net: { amount: "1.00", currency: "EUR" } },
    });
    expect(documentTotals({ currency: "eur", sumDiscounts: "5.5" }).discounts).toEqual({
      amount: "5.50",
      currency: "EUR",
    });
    expect(
      documentTotals({
        currency: "USD",
        sumNetForeignCurrency: "10",
        sumDiscounts: "4.6",
        sumDiscountsForeignCurrency: "5",
      }).discounts,
    ).toEqual({ amount: "5.00", currency: "USD" });
  });

  it("rejects an invalid currency from sevDesk", () => {
    expect(() => documentTotals({ currency: "EURO", sumNet: "1" })).toThrow();
  });
});

describe("contact references", () => {
  it("returns undefined for a missing contact", () => {
    expect(contactRef(null)).toBeUndefined();
    expect(contactRef(undefined)).toBeUndefined();
  });

  it("keeps a plain reference as id only", () => {
    expect(contactRef({ id: "12", objectName: "Contact" })).toEqual({ id: 12 });
  });

  it("names embedded organisations and persons", () => {
    expect(contactRef({ id: "1", name: "Musterfirma GmbH" })).toEqual({
      id: 1,
      name: "Musterfirma GmbH",
    });
    expect(
      contactRef({ id: "2", name: null, surename: "Erika", familyname: "Musterfrau" }),
    ).toEqual({ id: 2, name: "Erika Musterfrau" });
    expect(contactRef({ id: "3", name: " ", surename: null })).toEqual({ id: 3 });
  });

  it("fails on an unreadable contact instead of dropping it", () => {
    expect(() => contactRef({ objectName: "Contact" })).toThrow(SevdeskError);
  });

  it("reads ids of plain or embedded references", () => {
    expect(refId(undefined, "a user")).toBeUndefined();
    expect(refId({ id: "7", objectName: "SevUser", fullname: "x" }, "a user")).toBe(7);
    expect(() => refId({ id: "x" }, "a user")).toThrow(SevdeskError);
  });
});

describe("status, tax and send state", () => {
  it("labels documented status codes and keeps unknown ones", () => {
    expect(statusDto("order", 500)).toEqual({ code: 500, label: "Accepted" });
    expect(statusDto("creditNote", 300)).toEqual({ code: 300, label: "unknown" });
  });

  it("names Update 2.0 tax rules from reference data", () => {
    expect(taxDto(salesRecord({ taxRule: { id: 11, objectName: "TaxRule" } }))).toEqual({
      generation: "2.0",
      rule: {
        id: 11,
        code: "KLEINUNTERNEHMER_P19",
        name: "Steuer nicht erhoben nach §19UStG",
        documented: true,
      },
    });
    expect(taxDto(salesRecord({ taxRule: { id: 99, objectName: "TaxRule" } })).rule).toEqual({
      id: 99,
    });
  });

  it("shows the legacy tax type and tax set of Update 1.0 documents", () => {
    expect(
      taxDto(
        salesRecord({
          taxType: "custom",
          taxSet: { id: 5, objectName: "TaxSet" },
          taxText: "zzgl. Umsatzsteuer 19%",
          smallSettlement: false,
        }),
      ),
    ).toEqual({
      generation: "1.0",
      taxType: "custom",
      taxSetId: 5,
      text: "zzgl. Umsatzsteuer 19%",
      smallBusiness: false,
    });
    expect(taxDto(salesRecord())).toEqual({});
  });

  it("treats empty, '0' and unknown send types as not sent (D-009)", () => {
    expect(sentDto(salesRecord({ sendType: "0" }))).toBeUndefined();
    expect(sentDto(salesRecord({ sendType: "" }))).toBeUndefined();
    expect(sentDto(salesRecord({ sendType: "FAX" }))).toBeUndefined();
    expect(sentDto(salesRecord({ sendType: "vp" }))).toEqual({ via: "VP" });
    expect(sentDto(salesRecord({ sendDate: "2026-11-02T08:00:00+01:00" }))).toEqual({
      date: "2026-11-02",
    });
  });
});

describe("positions", () => {
  const base: PositionRecord = {
    id: 1,
    invoice: undefined,
    creditNote: undefined,
    order: undefined,
    part: undefined,
    quantity: "3",
    price: "10",
    priceNet: undefined,
    priceGross: undefined,
    name: "Artikel",
    text: undefined,
    unity: { id: 1, objectName: "Unity" },
    positionNumber: undefined,
    discount: "0",
    isPercentage: undefined,
    taxRate: "7",
    optional: true,
    sumNet: undefined,
    sumTax: undefined,
    sumGross: undefined,
    sumNetForeignCurrency: undefined,
    sumTaxForeignCurrency: undefined,
    sumGrossForeignCurrency: undefined,
  };

  it("takes a missing gross price from price when prices were entered gross", () => {
    const dto = toPositionDto(base, { currency: "EUR", showNet: false, unitNames: NO_UNITS });
    expect(dto).toEqual({
      id: 1,
      name: "Artikel",
      quantity: "3",
      unit: { id: 1 },
      unitPriceGross: { amount: "10.00", currency: "EUR" },
      taxRate: "7",
      optional: true,
    });
  });

  it("takes a missing net price from price when prices were entered net", () => {
    const dto = toPositionDto(
      { ...base, optional: false, discount: "10", isPercentage: true },
      { currency: "EUR", showNet: true, unitNames: new Map([[1, ""]]) },
    );
    expect(dto.unitPriceNet).toEqual({ amount: "10.00", currency: "EUR" });
    expect(dto.unitPriceGross).toBeUndefined();
    expect(dto.unit).toEqual({ id: 1 });
    expect(dto.discount).toEqual({ value: "10", isPercentage: true });
    expect(dto.optional).toBeUndefined();
  });

  it("guesses nothing when showNet is unknown", () => {
    const dto = toPositionDto(
      { ...base, unity: undefined, discount: "2" },
      { currency: "EUR", showNet: undefined, unitNames: NO_UNITS },
    );
    expect(dto.unitPriceNet).toBeUndefined();
    expect(dto.unitPriceGross).toBeUndefined();
    expect(dto.unit).toBeUndefined();
    expect(dto.discount).toEqual({ value: "2", isPercentage: false });
  });

  const route = (objects: unknown[], total?: string) => ({
    path: "/OrderPos",
    response: { body: total === undefined ? { objects } : { objects, total } },
  });
  const source = {
    path: "/OrderPos",
    parentKey: "order",
    objectName: "Order",
    what: "order positions",
  } as const;
  const row = (id: number, orderId: number, positionNumber?: number) => ({
    id: String(id),
    order: { id: String(orderId), objectName: "Order" },
    ...(positionNumber === undefined ? {} : { positionNumber: String(positionNumber) }),
  });

  it("reads one page when the filter is honoured and nothing is left", async () => {
    const client = new FakeSevdeskClient([route([row(2, 7, 2), row(1, 7, 1), row(3, 7)])]);
    const result = await listDocumentPositions(client, source, 7);
    expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.query).toMatchObject({
      "order[id]": 7,
      "order[objectName]": "Order",
      limit: 1000,
    });
  });

  it("sorts positions without numbers by id", async () => {
    const client = new FakeSevdeskClient([route([row(9, 7), row(8, 7)])]);
    const result = await listDocumentPositions(client, source, 7);
    expect(result.rows.map((r) => r.id)).toEqual([8, 9]);
  });

  it("re-reads page by page when sevDesk reports more rows than one page", async () => {
    const objects = Array.from({ length: 1500 }, (_, index) => row(index + 1, 7));
    const client = new FakeSevdeskClient([route(objects)]);
    const result = await listDocumentPositions(client, source, 7);
    expect(result.rows).toHaveLength(1500);
    expect(result.complete).toBe(true);
  });

  it("reports a capped read as incomplete", async () => {
    const objects = Array.from({ length: 10_001 }, (_, index) => row(index + 1, 7));
    const client = new FakeSevdeskClient([route(objects)]);
    const result = await listDocumentPositions(client, source, 7);
    expect(result.rows).toHaveLength(10_000);
    expect(result.complete).toBe(false);
  });

  it("fails on an unreadable position", async () => {
    const client = new FakeSevdeskClient([route([{ id: "x" }])]);
    await expect(listDocumentPositions(client, source, 7)).rejects.toMatchObject({
      kind: "unexpected_response",
      message: "sevDesk returned order positions in an unexpected format.",
    });
  });

  it("loads unit names and survives a failing unit list, except on cancellation", async () => {
    const ok = new FakeSevdeskClient([
      { path: "/Unity", response: { fixture: "meta/units.json" } },
    ]);
    expect((await loadUnitNames(ok)).get(9)).toBe("Std");

    const failing = new FakeSevdeskClient([
      { path: "/Unity", response: { error: new SevdeskError({ kind: "server", message: "x" }) } },
    ]);
    expect((await loadUnitNames(failing)).size).toBe(0);

    const aborted = new FakeSevdeskClient([
      { path: "/Unity", response: { error: new SevdeskError({ kind: "aborted", message: "x" }) } },
    ]);
    await expect(loadUnitNames(aborted)).rejects.toMatchObject({ kind: "aborted" });

    // A programming error (here: the fake has no route) is not mistaken for a sevDesk failure.
    await expect(loadUnitNames(new FakeSevdeskClient([]))).rejects.toThrow(/no route/);
  });

  it("re-checks document numbers trimmed and case-insensitively", () => {
    const matches = matchesNumber(" RE-1000 ");
    expect(matches?.({ number: "re-1000" })).toBe(true);
    expect(matches?.({ number: "RE-10001" })).toBe(false);
    expect(matches?.({})).toBe(false);
    expect(matchesNumber(undefined)).toBeUndefined();
  });

  it("combines local filters, or gives none", () => {
    expect(allOf<number>(undefined, undefined)).toBeUndefined();
    const both = allOf<number>(
      (n) => n > 1,
      undefined,
      (n) => n < 3,
    );
    expect([1, 2, 3].filter((n) => both?.(n) === true)).toEqual([2]);
  });
});

describe("listDocuments", () => {
  const ids = (count: number, start = 1) =>
    Array.from({ length: count }, (_, index) => ({ id: start + index }));
  const map = (raw: unknown) => (raw as { id: number }).id;
  const even = (id: number) => id % 2 === 0;

  it("reads one page without a local filter", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(5) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 2,
      offset: 2,
      map,
    });
    expect(result).toEqual({
      items: [3, 4],
      received: 2,
      total: 5,
      hasMore: true,
      nextOffset: 4,
      filteredLocally: false,
    });
  });

  it("drops rows the recheck rejects without scanning: sevDesk's paging and total stay", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(5) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 3,
      offset: 0,
      map,
      recheck: (id) => id !== 2,
    });
    expect(client.calls).toHaveLength(1);
    expect(result).toEqual({
      items: [1, 3],
      received: 3,
      total: 5,
      hasMore: true,
      nextOffset: 3,
      filteredLocally: false,
    });
  });

  it("applies the recheck together with a local filter while scanning", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(10) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 3,
      offset: 0,
      map,
      keep: even,
      recheck: (id) => id !== 4,
    });
    expect(result.items).toEqual([2, 6, 8]);
    expect(result).toMatchObject({ received: 8, nextOffset: 8, filteredLocally: true });
  });

  it("scans across chunks until the limit is reached", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(450) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 150,
      offset: 0,
      map,
      keep: even,
    });
    expect(result.items).toHaveLength(150);
    expect(result.items.at(-1)).toBe(300);
    expect(result).toMatchObject({ received: 300, nextOffset: 300, hasMore: true });
    expect(result.total).toBeUndefined();
    expect(client.calls.map((call) => call.query["limit"])).toEqual([200, 200]);
  });

  it("reads chunks of limit rows when limit is larger than the default chunk", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(SCAN_MAX_ROWS + 50) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 600,
      offset: 0,
      map,
      keep: () => true,
    });
    expect(result.items).toHaveLength(600);
    expect(client.calls.map((call) => call.query["limit"])).toEqual([600]);
  });

  it("stops at the scan cap and hands back control", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: ids(SCAN_MAX_ROWS + 50) } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 25,
      offset: 0,
      map,
      keep: () => false,
    });
    expect(result).toMatchObject({ items: [], received: SCAN_MAX_ROWS, hasMore: true });
    expect(result.nextOffset).toBe(SCAN_MAX_ROWS);
  });

  it("ends on an empty page when sevDesk sends no total", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: [], total: null } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 25,
      offset: 40,
      map,
      keep: even,
    });
    expect(result).toMatchObject({ items: [], received: 0, hasMore: false, nextOffset: 40 });
    expect(documentListSummary("Orders", "matching orders", result, { offset: 40 })).toBe(
      "0 matching orders in no rows after offset 40 (filtered by this server, not sevDesk); " +
        "end of list.",
    );
  });

  it("builds list output without a total or nextOffset when they do not apply", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order", response: { body: { objects: [{ id: 1 }], total: null } } },
    ]);
    const result = await listDocuments({
      client,
      path: "/Order",
      query: {},
      limit: 5,
      offset: 0,
      map,
    });
    expect(documentListData(result, { limit: 5, offset: 0 })).toEqual({
      items: [1],
      offset: 0,
      limit: 5,
      hasMore: true,
      nextOffset: 1,
    });
    expect(documentListSummary("Orders", "orders", result, { offset: 0 })).toBe(
      "Orders 1–1; more may follow (nextOffset 1).",
    );
  });
});

describe("helpers", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDays("2028-02-20", 10)).toBe("2028-03-01");
    expect(addDays("2026-10-01", 0)).toBe("2026-10-01");
  });

  it("cleans text: sanitized, trimmed, empty becomes undefined", () => {
    const zwsp = String.fromCodePoint(0x200b);
    expect(cleanText(undefined, 10)).toBeUndefined();
    expect(cleanText(`  ${zwsp} `, 10)).toBeUndefined();
    expect(cleanText(` a${zwsp}b `, 10)).toBe("ab");
  });
});
