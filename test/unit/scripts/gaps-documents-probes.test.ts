import { describe, expect, it } from "vitest";

import { ALL_PROBES } from "../../../scripts/lib/probes/catalog.js";
import {
  allowanceFacts,
  GAPS_DOCUMENTS_PROBES,
} from "../../../scripts/lib/probes/gaps-documents-probes.js";
import { renderReport } from "../../../scripts/lib/probes/report.js";
import { type RunOptions, runProbes } from "../../../scripts/lib/probes/runner.js";
import { assertNoSecrets, createScrubber } from "../../../scripts/lib/scrub.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type ScriptedCall, ScriptedClient } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TAG = "MCP-E2E 20261120-1000-abcd";
const IDS = GAPS_DOCUMENTS_PROBES.map((probe) => probe.id);

/** Base64 bodies sevDesk sends in layout lists and changeParameter answers (synthetic). */
const PDF_BASE64 = `JVBERi0xLjQK${"QUJD".repeat(1000)}`;
const PNG_BASE64 = `iVBORw0KGgo${"REVG".repeat(1000)}`;
const HTML_BASE64 = `PGh0bWw+${"R0hJ".repeat(800)}`;

type Rec = Record<string, unknown>;
type Kind = "Invoice" | "Order" | "CreditNote";

const KIND_KEY: Readonly<Record<Kind, string>> = {
  Invoice: "invoice",
  Order: "order",
  CreditNote: "creditNote",
};
const NUMBER_KEY: Readonly<Record<Kind, string>> = {
  Invoice: "invoiceNumber",
  Order: "orderNumber",
  CreditNote: "creditNoteNumber",
};
const PREFIX: Readonly<Record<string, string>> = { AN: "AN", AB: "AB", LI: "LI", CN: "GU" };

function options(client: ScriptedClient, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    client,
    scrubber: createScrubber({ secrets: [TOKEN] }),
    probes: ALL_PROBES,
    allowWrites: true,
    tag: TAG,
    today: "2026-11-20",
    nowSeconds: Date.parse("2026-11-20T09:00:00Z") / 1000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    ...overrides,
  };
}

function refuse(status: number, upstreamMessage: string): never {
  throw new SevdeskError({
    kind: status === 404 ? "not_found" : "validation",
    message: "Invalid request",
    status,
    upstreamMessage,
  });
}

const ref = (objectName: string, id: unknown) => ({ id: String(id), objectName });
const idOf = (value: unknown): string =>
  typeof value === "object" && value !== null ? String((value as Rec)["id"]) : String(value);

const LETTERPAPERS: readonly Rec[] = [
  {
    id: "57d7ff34f23ada297d265f21",
    pdf: PDF_BASE64,
    sevClient: "0",
    name: "Blanko",
    default: 1,
    img: PNG_BASE64,
  },
  {
    id: "57d7ff34f23ada297d265f22",
    pdf: PDF_BASE64,
    sevClient: "512345",
    name: "Huber Briefpapier",
    default: 0,
    img: PNG_BASE64,
  },
];

function templates(type: string | undefined): Rec[] {
  return ["Invoice", "Order", "Creditnote"]
    .filter((item) => type === undefined || item === type)
    .flatMap((item, index) => [
      {
        id: `57986aee6bd2d53306068d${index}1`,
        name: "SEVDOC_TEMPLATE_STANDARD",
        translationCode: "SEVDOC_TEMPLATE_STANDARD",
        sevClient: "0",
        type: item,
        html: HTML_BASE64,
        default: 1,
        premium: false,
      },
      {
        id: `57986aee6bd2d53306068d${index}2`,
        name: "SEVDOC_TEMPLATE_MODERN",
        translationCode: "SEVDOC_TEMPLATE_MODERN",
        sevClient: "0",
        type: item,
        html: HTML_BASE64,
        default: 0,
        premium: false,
      },
    ]);
}

interface AccountSettings {
  /** changeParameter marks the draft as sent (synthetic, to test the contradiction). */
  readonly changeParameterSends?: boolean;
  /** A credit note update without `contact` is refused (synthetic, for the fallback). */
  readonly refuseMinimalCreditNoteUpdate?: boolean;
  /** Invoices present before the run. */
  readonly invoices?: readonly Rec[];
  /** discountSave must be one object, not a list (synthetic, for the fallback). */
  readonly discountAsObject?: boolean;
  /** No input stores a schedule date, not even an update (the case "the API cannot"). */
  readonly ignoreScheduleDates?: boolean;
  /**
   * Discounts as recorded on 2026-11-16/17 (D-116): `getDiscounts` answers on invoices, orders and
   * credit notes, `sumDiscounts`, `sumDiscountNet` and `sumDiscountGross` are negative, and
   * `createInvoiceFromOrder` copies the order's discount. Synthetic (not recorded): sums per tax
   * rate and for gross prices, a fixed value read as gross when sent with `isNet: false`, AB
   * copies the discount and LI does not, partial invoices take `amount` % of each position,
   * `calculateInvoicingRange` takes dd.mm.yyyy only, the e-invoice XML carries one
   * document-level allowance. Off: the earlier synthetic variant (getDiscounts on orders only).
   */
  readonly discountsAsRecorded?: boolean;
  /** Synthetic (not recorded): saving a gross document (showNet false) is refused. */
  readonly refuseGrossDocuments?: boolean;
  /** Synthetic (not recorded): createInvoiceFromOrder is refused. */
  readonly refuseInvoiceFromOrder?: boolean;
}

const DOC_ID = "d4605b19248ad176443b7cb382679b1f";

/** A CII e-invoice with one line and a 10 % allowance on the document (synthetic). */
const EINVOICE_XML = [
  '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">',
  "<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>",
  "<rsm:SupplyChainTradeTransaction>",
  "<ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedLineTradeSettlement><ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement></ram:IncludedSupplyChainTradeLineItem>",
  "<ram:ApplicableHeaderTradeAgreement><ram:BuyerTradeParty><ram:Name>Huber Rabatt GmbH</ram:Name></ram:BuyerTradeParty></ram:ApplicableHeaderTradeAgreement>",
  "<ram:ApplicableHeaderTradeSettlement>",
  "<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:CalculationPercent>10.00</ram:CalculationPercent><ram:BasisAmount>100.00</ram:BasisAmount><ram:ActualAmount>10.00</ram:ActualAmount><ram:Reason>Rabatt Huber</ram:Reason></ram:SpecifiedTradeAllowanceCharge>",
  "<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:AllowanceTotalAmount>10.00</ram:AllowanceTotalAmount><ram:TaxBasisTotalAmount>90.00</ram:TaxBasisTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
  "</ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>",
].join("");

const SCHEDULE_DATES: readonly string[] = [
  "accountNextInvoice",
  "accountStartDate",
  "accountEndDate",
  "accountLastInvoice",
];

/** A day as YYYY-MM-DD in Berlin winter time (every date of these tests falls in winter). */
const berlinDay = (ms: number): string => new Date(ms + 3_600_000).toISOString().slice(0, 10);

/**
 * A schedule date as sevDesk stores it (recorded 2026-11-16, D-111: an ISO date-time at 00:00
 * Berlin), from Unix seconds, an ISO date-time or `dd.mm.yyyy`; `null` for anything else.
 */
function storedScheduleDate(value: unknown): string | null {
  let day: string | undefined;
  if (typeof value === "number") day = berlinDay(value * 1000);
  if (typeof value === "string") {
    const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
    if (german !== null) day = `${german[3] ?? ""}-${german[2] ?? ""}-${german[1] ?? ""}`;
    else if (!Number.isNaN(Date.parse(value))) day = berlinDay(Date.parse(value));
  }
  return day === undefined ? null : `${day}T00:00:00+01:00`;
}

/**
 * A simulated trial account for these probes. Where the 2026-11-16 run recorded a behaviour, it
 * follows it: orders need a number; a draft offer takes a status through `PUT /Order/{id}` and
 * gets another number of its range (D-108); DELETE removes drafts only, and recurring templates
 * at status 100 or 50 but not 200 (409, D-109, D-112); deleting a draft saved with the number just
 * reserved gives that number back (D-066); a template stores `accountStartDate` (and with it
 * `accountNextInvoice`) and `accountEndDate` on create, on a `saveInvoice` update and on
 * `PUT /Invoice/{id}`, but not `accountNextInvoice` alone (D-111); changeParameter answers
 * `{metaData}` and leaves the record alone; order and credit note changeParameter answer 500
 * "Syntax error". The rest are assumptions for the probes' logic (marked synthetic):
 * changeParameter on orders and credit notes works after a getPdf preview, only the language
 * en_US is known, the renumbering of a draft offer leaves the counter alone.
 */
function gapsAccount(settings: AccountSettings = {}) {
  let nextId = 500;
  const docs = new Map<string, Rec>();
  const positions: Rec[] = [];
  const discounts: Rec[] = [];
  const textTemplates = new Map<string, Rec>();
  const counters: Record<string, number> = { AN: 1000, AB: 1000, LI: 1000, CN: 1000 };
  /** The number each range reserved last (`useNextNumber=true`), until its draft is deleted. */
  const reserved: Record<string, string | undefined> = {};
  /** Documents that had a getPdf preview (synthetic: changeParameter on orders needs one). */
  const previewed = new Set<string>();
  /** The layout choices per document, kept apart from the record. */
  const layouts = new Map<string, Record<string, string>>();
  const parameters = (store: string) =>
    ["language", "template", "letterpaper", "payPal"].map((key) => ({
      key,
      name: key,
      visible: true,
      value: layouts.get(store)?.[key] ?? (key === "language" ? "de_DE" : null),
      values: [
        { name: "a", value: "de_DE", translationCode: "SEVDOC_LANG_DE_DE", isCustom: null },
        { name: "b", value: "en_US", translationCode: "SEVDOC_LANG_EN_US", isCustom: null },
      ],
    }));
  for (const invoice of settings.invoices ?? [])
    docs.set(`Invoice/${idOf(invoice["id"])}`, invoice);

  const nextNumber = (range: string) => `${PREFIX[range] ?? range}-${counters[range] ?? 0}`;

  /** The schedule dates a template keeps from a create or update body (D-111). */
  function applySchedule(doc: Rec, fields: Rec): void {
    if (settings.ignoreScheduleDates === true) return;
    const start = storedScheduleDate(fields["accountStartDate"]);
    if (start !== null) Object.assign(doc, { accountStartDate: start, accountNextInvoice: start });
    const end = storedScheduleDate(fields["accountEndDate"]);
    if (end !== null) doc["accountEndDate"] = end;
  }

  /** Deleting a draft saved with the number its range reserved last gives it back (D-066). */
  function giveBackNumber(kind: string, doc: Rec): void {
    const range =
      kind === "Order" ? String(doc["orderType"]) : kind === "CreditNote" ? "CN" : undefined;
    if (range === undefined || reserved[range] === undefined) return;
    if (doc[NUMBER_KEY[kind as Kind]] !== reserved[range]) return;
    counters[range] = (counters[range] ?? 0) - 1;
    reserved[range] = undefined;
  }

  const ofDoc = (rows: readonly Rec[], kind: string, id: unknown, key: string) =>
    rows.filter((row) => {
      const target = row[key] as Rec | undefined;
      return target?.["id"] === String(id) && target["objectName"] === kind;
    });

  /** Sums per tax rate, gross prices and fixed gross values (see `discountsAsRecorded`). */
  function recomputeAsRecorded(kind: Kind, doc: Rec): void {
    const gross = doc["showNet"] === false;
    const byRate = new Map<number, number>();
    for (const row of ofDoc(positions, kind, doc["id"], KIND_KEY[kind])) {
      const rate = Number(row["taxRate"] ?? 19);
      const price = Number(row["price"]) * Number(row["quantity"] ?? 1);
      const net = gross ? price / (1 + rate / 100) : price;
      Object.assign(row, {
        sumNet: net.toFixed(2),
        sumTax: ((net * rate) / 100).toFixed(2),
        sumGross: (net * (1 + rate / 100)).toFixed(2),
      });
      byRate.set(rate, (byRate.get(rate) ?? 0) + net);
    }
    const net = [...byRate.values()].reduce((sum, value) => sum + value, 0);
    const grossTotal = [...byRate].reduce(
      (sum, [rate, value]) => sum + value * (1 + rate / 100),
      0,
    );
    // The share of the net taken off: a percentage, or a fixed value (net, or gross with isNet 0).
    const share = ofDoc(discounts, kind, doc["id"], "object").reduce((sum, row) => {
      const value = Number(row["value"]);
      if (row["percentage"] === "1") return sum + value / 100;
      return sum + value / (row["isNet"] === "0" ? grossTotal : net);
    }, 0);
    const sumNet = net * (1 - share);
    const sumGross = grossTotal * (1 - share);
    Object.assign(doc, {
      sumNet: sumNet.toFixed(2),
      sumTax: (sumGross - sumNet).toFixed(2),
      sumGross: sumGross.toFixed(2),
      sumDiscounts: (-net * share).toFixed(2),
      sumDiscountNet: (-net * share).toFixed(2),
      sumDiscountGross: (-grossTotal * share).toFixed(2),
    });
  }

  function recompute(kind: Kind, doc: Rec): void {
    if (settings.discountsAsRecorded === true) {
      recomputeAsRecorded(kind, doc);
      return;
    }
    const net = ofDoc(positions, kind, doc["id"], KIND_KEY[kind]).reduce(
      (sum, row) => sum + Number(row["price"]) * Number(row["quantity"] ?? 1),
      0,
    );
    const discount = ofDoc(discounts, kind, doc["id"], "object").reduce(
      (sum, row) =>
        sum +
        (row["percentage"] === "1" ? (net * Number(row["value"])) / 100 : Number(row["value"])),
      0,
    );
    const sumNet = net - discount;
    Object.assign(doc, {
      sumNet: sumNet.toFixed(2),
      sumTax: (sumNet * 0.19).toFixed(2),
      sumGross: (sumNet * 1.19).toFixed(2),
      sumDiscounts: discount.toFixed(2),
    });
  }

  function save(kind: Kind, body: Rec): unknown {
    const key = KIND_KEY[kind];
    const header = body[key] as Rec;
    const rawDiscounts = body["discountSave"];
    if (settings.discountAsObject === true && Array.isArray(rawDiscounts)) {
      refuse(400, "discountSave expected an object");
    }
    if (settings.discountAsObject !== true && rawDiscounts !== undefined && rawDiscounts !== null) {
      if (!Array.isArray(rawDiscounts)) refuse(400, "discountSave expected array");
    }
    const discountSave =
      rawDiscounts !== null && typeof rawDiscounts === "object" && !Array.isArray(rawDiscounts)
        ? [rawDiscounts]
        : rawDiscounts;
    if (settings.refuseGrossDocuments === true && header["showNet"] === false) {
      refuse(422, "Gross documents are not allowed");
    }
    let doc: Rec;
    if (header["id"] !== undefined) {
      const found = docs.get(`${kind}/${idOf(header["id"])}`);
      if (found === undefined) return refuse(400, `${kind} not found`);
      if (
        settings.refuseMinimalCreditNoteUpdate === true &&
        kind === "CreditNote" &&
        header["contact"] === undefined
      ) {
        refuse(422, "Must set contact");
      }
      for (const [field, value] of Object.entries(header)) {
        if (["id", "objectName", "mapAll"].includes(field)) continue;
        if (SCHEDULE_DATES.includes(field) || field.startsWith("recurring")) continue;
        found[field] = value;
      }
      if (found["invoiceType"] === "WKR") applySchedule(found, header);
      if (header["status"] !== undefined) found["status"] = idOf(header["status"]);
      doc = found;
    } else {
      if (kind === "Order" && (header["orderNumber"] ?? "") === "") refuse(400, "Bad Request");
      const id = String(nextId++);
      // Recorded 2026-11-16: a WKR template keeps any accountIntervall string, drops the
      // recurring* fields and keeps only the schedule dates of D-111.
      const kept = Object.fromEntries(
        Object.entries(header).filter(
          ([field]) => !SCHEDULE_DATES.includes(field) && !field.startsWith("recurring"),
        ),
      );
      doc = {
        ...(header["invoiceType"] === "WKR" ? kept : header),
        ...(header["invoiceType"] === "WKR"
          ? {
              accountIntervall: header["accountIntervall"] ?? null,
              ...Object.fromEntries(SCHEDULE_DATES.map((field) => [field, null])),
            }
          : {}),
        id,
        objectName: kind,
        status: idOf(header["status"] ?? "100"),
        [NUMBER_KEY[kind]]: header[NUMBER_KEY[kind]] ?? null,
        create: "2026-11-20T10:00:00+01:00",
      };
      if (header["invoiceType"] === "WKR") applySchedule(doc, header);
      docs.set(`${kind}/${id}`, doc);
    }
    const deleted = body[`${key}PosDelete`];
    const deleteList = Array.isArray(deleted) ? deleted : deleted ? [deleted] : [];
    for (const item of deleteList as Rec[]) {
      const index = positions.findIndex((row) => row["id"] === String(item["id"]));
      if (index >= 0) positions.splice(index, 1);
    }
    for (const position of (body[`${key}PosSave`] as Rec[] | null | undefined) ?? []) {
      positions.push({ ...position, id: String(nextId++), [key]: ref(kind, doc["id"]) });
    }
    for (const item of (discountSave as Rec[] | null | undefined) ?? []) {
      discounts.push({
        id: String(nextId++),
        objectName: "Discounts",
        object: ref(kind, doc["id"]),
        discount: "1",
        text: item["text"],
        percentage: item["percentage"] === true ? "1" : "0",
        value: String(item["value"]),
        isNet: settings.discountsAsRecorded === true && item["isNet"] === false ? "0" : "1",
      });
    }
    const discountDelete = body["discountDelete"];
    for (const item of (Array.isArray(discountDelete) ? discountDelete : []) as Rec[]) {
      const index = discounts.findIndex((row) => row["id"] === String(item["id"]));
      if (index >= 0) discounts.splice(index, 1);
    }
    recompute(kind, doc);
    return {
      objects: {
        [key]: doc,
        [`${key}Pos`]: ofDoc(positions, kind, doc["id"], key),
        discount: ofDoc(discounts, kind, doc["id"], "object"),
      },
    };
  }

  function derive(call: ScriptedCall, type: "AB" | "LI"): unknown {
    const sourceId = String(call.query["order[id]"]);
    const source = docs.get(`Order/${sourceId}`);
    if (source === undefined) return refuse(400, "Order not found");
    if (type === "LI" && source["orderType"] === "AB" && source["status"] === "100") {
      refuse(422, "Order must not be a draft");
    }
    const id = String(nextId++);
    const doc: Rec = {
      id,
      objectName: "Order",
      orderType: type,
      status: "100",
      orderNumber: nextNumber(type),
      origin: ref("Order", sourceId),
      contact: source["contact"],
      header: source["header"],
      headText: source["headText"],
      footText: source["footText"],
    };
    docs.set(`Order/${id}`, doc);
    for (const row of ofDoc(positions, "Order", sourceId, "order")) {
      positions.push({ ...row, id: String(nextId++), order: ref("Order", id) });
    }
    if (settings.discountsAsRecorded === true && type === "AB")
      copyDiscounts("Order", sourceId, "Order", id);
    recompute("Order", doc);
    return { objects: doc };
  }

  function copyDiscounts(fromKind: Kind, fromId: string, toKind: Kind, toId: string): void {
    for (const row of ofDoc(discounts, fromKind, fromId, "object")) {
      discounts.push({ ...row, id: String(nextId++), object: ref(toKind, toId) });
    }
  }

  /** Recorded (D-116): the invoice copies the order's discount; partial shares synthetic. */
  function invoiceFromOrder(body: Rec): unknown {
    if (settings.refuseInvoiceFromOrder === true) refuse(422, "Order cannot be invoiced");
    const sourceId = idOf(body["order"]);
    const source = docs.get(`Order/${sourceId}`);
    if (source === undefined) return refuse(400, "Order not found");
    const share = body["type"] === "percentage" ? Number(body["amount"]) / 100 : 1;
    const id = String(nextId++);
    const doc: Rec = {
      id,
      objectName: "Invoice",
      invoiceType: typeof body["partialType"] === "string" ? body["partialType"] : "RE",
      status: "100",
      showNet: source["showNet"],
      origin: ref("Order", sourceId),
      contact: source["contact"],
      header: source["header"],
    };
    docs.set(`Invoice/${id}`, doc);
    for (const row of ofDoc(positions, "Order", sourceId, "order")) {
      const { order: _order, ...rest } = row;
      positions.push({
        ...rest,
        id: String(nextId++),
        price: Number(row["price"]) * share,
        invoice: ref("Invoice", id),
      });
    }
    if (settings.discountsAsRecorded === true) copyDiscounts("Order", sourceId, "Invoice", id);
    recompute("Invoice", doc);
    return { objects: { invoice: doc, invoicePos: ofDoc(positions, "Invoice", id, "invoice") } };
  }

  function list(rows: readonly Rec[]): unknown {
    return { total: rows.length, objects: rows };
  }

  function invoiceList(query: Readonly<Record<string, unknown>>): unknown {
    let rows = [...docs.entries()]
      .filter(([key]) => key.startsWith("Invoice/"))
      .map(([, doc]) => doc);
    if (query["showWkr"] === "all") rows = rows.filter((row) => row["invoiceType"] === "WKR");
    else if (query["invoiceType"] !== undefined)
      rows = rows.filter((row) => row["invoiceType"] === query["invoiceType"]);
    else if (query["showAll"] !== "true") rows = rows.filter((row) => row["invoiceType"] !== "WKR");
    if (query["origin[id]"] !== undefined) {
      rows = rows.filter((row) => idOf(row["origin"]) === String(query["origin[id]"]));
    }
    return list(rows);
  }

  const handler = (call: ScriptedCall): unknown => {
    const { path, method, query } = call;
    const body = (call.body ?? {}) as Rec;
    if (path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
    if (path === "/SevUser") return list([{ id: "7", objectName: "SevUser" }]);
    if (method === "POST" && path === "/Contact") {
      return { objects: { id: String(nextId++), objectName: "Contact" } };
    }
    const next =
      path === "/Order/Factory/getNextOrderNumber"
        ? String(query["orderType"])
        : path === "/CreditNote/Factory/getNextCreditNoteNumber"
          ? "CN"
          : undefined;
    if (next !== undefined) {
      const number = nextNumber(next);
      if (query["useNextNumber"] === "true") {
        counters[next] = (counters[next] ?? 0) + 1;
        reserved[next] = number;
      }
      return { objects: number };
    }
    const saved = /^\/(Invoice|CreditNote|Order)\/Factory\/save\1$/.exec(path);
    if (saved !== null) return save(saved[1] as Kind, body);
    if (path === "/Order/Factory/createContractNoteFromOrder") return derive(call, "AB");
    if (path === "/Order/Factory/createPackingListFromOrder") return derive(call, "LI");
    if (path === "/CreditNote/Factory/createFromInvoice") {
      const invoiceId = idOf(body["invoice"]);
      const invoice = docs.get(`Invoice/${invoiceId}`);
      if (invoice?.["status"] !== "200") refuse(422, "Invoice must be sent");
      const id = String(nextId++);
      const doc: Rec = {
        id,
        objectName: "CreditNote",
        creditNoteType: "CN",
        status: "100",
        creditNoteNumber: "GU-1000",
        origin: ref("Invoice", invoiceId),
        refSrcInvoice: ref("Invoice", invoiceId),
        contact: invoice["contact"],
        header: invoice["header"],
      };
      docs.set(`CreditNote/${id}`, doc);
      return { objects: { creditNote: doc, creditNotePos: [], discount: [] } };
    }
    const sendBy = /^\/(Invoice|CreditNote|Order)\/(\d+)\/sendBy$/.exec(path);
    if (sendBy !== null) {
      const doc = docs.get(`${sendBy[1] ?? ""}/${sendBy[2] ?? ""}`);
      if (doc === undefined) return refuse(404, "not found");
      Object.assign(doc, { status: "200", sendDate: "2026-11-20T10:00:00+01:00", sendType: "VPR" });
      if (sendBy[1] === "Invoice") doc["invoiceNumber"] = "RE-1001";
      return { objects: doc };
    }
    const change = /^\/(Invoice|CreditNote|Order)\/(\d+)\/changeParameter$/.exec(path);
    if (change !== null) {
      const store = `${change[1] ?? ""}/${change[2] ?? ""}`;
      const doc = docs.get(store);
      if (doc === undefined) return refuse(404, "not found");
      if (change[1] !== "Invoice" && !previewed.has(store)) refuse(500, "Syntax error");
      const value = String(body["value"]);
      if (body["key"] === "language" && value !== "en_US") refuse(400, "Invalid language");
      // The choice lives in the document, not on the record (recorded 2026-11-16).
      layouts.set(store, { ...layouts.get(store), [String(body["key"])]: value });
      if (settings.changeParameterSends === true) {
        Object.assign(doc, { sendDate: "2026-11-20T10:00:00+01:00", sendType: "VPDF" });
      }
      return { objects: { metaData: { docId: DOC_ID, parameters: parameters(store) } } };
    }
    const preview = /^\/(Invoice|CreditNote|Order)\/(\d+)\/getPdf$/.exec(path);
    if (preview !== null) {
      const store = `${preview[1] ?? ""}/${preview[2] ?? ""}`;
      if (!docs.has(store)) return refuse(404, "not found");
      previewed.add(store);
      return {
        objects: {
          filename: `${DOC_ID}.pdf`,
          mimetype: null,
          base64Encoded: true,
          content: PDF_BASE64,
        },
      };
    }
    const render = /^\/(Invoice|CreditNote|Order)\/(\d+)\/render$/.exec(path);
    if (render !== null) {
      const store = `${render[1] ?? ""}/${render[2] ?? ""}`;
      if (render[1] !== "Invoice") refuse(404, "not found");
      return { objects: { pdf: PDF_BASE64, docId: DOC_ID, parameters: parameters(store) } };
    }
    const discountsOf = /^\/(Invoice|CreditNote|Order)\/(\d+)\/getDiscounts$/.exec(path);
    if (discountsOf !== null) {
      const kind = discountsOf[1] as Kind;
      if (kind !== "Order" && settings.discountsAsRecorded !== true) refuse(404, "not found");
      return list(ofDoc(discounts, kind, discountsOf[2], "object"));
    }
    if (path === "/Invoice/Factory/createInvoiceFromOrder") return invoiceFromOrder(body);
    if (settings.discountsAsRecorded === true) {
      if (path === "/Invoice/Factory/calculateInvoicingRange") {
        if (typeof body["startDate"] !== "string") refuse(400, "Invalid date");
        return { objects: { startDate: "2027-01-31", endDate: "2027-02-27" } };
      }
      if (path === "/PaymentMethod") {
        return list([{ id: "21919", objectName: "PaymentMethod", electronicInvoiceId: "58" }]);
      }
      if (method === "POST" && path === "/CommunicationWay") {
        return { objects: { id: String(nextId++), objectName: "CommunicationWay" } };
      }
      const xml = /^\/Invoice\/(\d+)\/getXml$/.exec(path);
      if (xml !== null) return { objects: EINVOICE_XML };
    }
    if (path === "/Discounts") return list(discounts);
    if (path === "/DocServer/getLetterpapersWithThumb") {
      return { objects: { result: "1", letterpapers: LETTERPAPERS } };
    }
    if (path === "/DocServer/getTemplatesWithThumb") {
      const type = typeof query["type"] === "string" ? query["type"] : undefined;
      return { objects: { result: "1", templates: templates(type) } };
    }
    if (path === "/TextTemplate") {
      if (method === "POST") {
        const id = String(nextId++);
        const row: Rec = { ...body, id, main: "0" };
        delete row["mapAll"];
        textTemplates.set(id, row);
        return { objects: row };
      }
      return list([...textTemplates.values()]);
    }
    const putOrder = /^\/Order\/(\d+)$/.exec(path);
    if (method === "PUT" && putOrder !== null) {
      const doc = docs.get(`Order/${putOrder[1] ?? ""}`);
      if (doc === undefined) return refuse(404, "not found");
      // Recorded 2026-11-16 (D-108): a draft takes the status too and is renumbered
      // ("AN-0007" → "AN-0008"); the counter is left alone (synthetic).
      if (doc["status"] === "100") {
        const range = String(doc["orderType"]);
        doc["orderNumber"] = `${PREFIX[range] ?? range}-${(counters[range] ?? 0) + 1}`;
      }
      doc["status"] = String(body["status"]);
      return { objects: doc };
    }
    const putInvoice = /^\/Invoice\/(\d+)$/.exec(path);
    if (method === "PUT" && putInvoice !== null) {
      const doc = docs.get(`Invoice/${putInvoice[1] ?? ""}`);
      if (doc === undefined) return refuse(404, "not found");
      // Recorded 2026-11-16 (D-111): PUT stores a template's schedule dates as saveInvoice does.
      if (doc["invoiceType"] === "WKR") applySchedule(doc, body);
      return { objects: doc };
    }
    const byId = /^\/(Invoice|Order|CreditNote|TextTemplate)\/(\d+)$/.exec(path);
    if (byId !== null) {
      const store = byId[1] === "TextTemplate" ? undefined : `${byId[1] ?? ""}/${byId[2] ?? ""}`;
      const doc = store === undefined ? textTemplates.get(byId[2] ?? "") : docs.get(store);
      if (doc === undefined) return refuse(404, "not found");
      if (method === "GET") return { objects: [doc] };
      if (method === "DELETE") {
        // Recorded 2026-11-16: drafts only (D-109); templates at 100 and 50, never at 200 (D-112).
        const status = String(doc["status"]);
        const deletable = status === "100" || (doc["invoiceType"] === "WKR" && status === "50");
        if (store !== undefined && !deletable) {
          refuse(409, `${byId[1] ?? ""} can only be deleted in status 100 but is status ${status}`);
        }
        if (store === undefined) textTemplates.delete(byId[2] ?? "");
        else {
          docs.delete(store);
          giveBackNumber(byId[1] ?? "", doc);
        }
        return { objects: [null] };
      }
      return refuse(400, "not simulated");
    }
    const pos = /^\/(Invoice|Order|CreditNote)Pos$/.exec(path);
    if (pos !== null) {
      const kind = pos[1] as Kind;
      const key = KIND_KEY[kind];
      return list(ofDoc(positions, kind, String(query[`${key}[id]`]), key));
    }
    if (path === "/Invoice") return invoiceList(query);
    if (path === "/Order" || path === "/CreditNote") {
      return list(
        [...docs.entries()]
          .filter(([key]) => key.startsWith(`${path.slice(1)}/`))
          .map(([, d]) => d),
      );
    }
    if (method !== "GET") refuse(422, "not simulated");
    return list([]);
  };
  return { client: new ScriptedClient(handler), handler, docs, counters, discounts };
}

async function run(client: ScriptedClient, overrides: Partial<RunOptions> = {}) {
  const report = await runProbes(options(client, { only: IDS, ...overrides }));
  const finding = (id: string) => report.results.find((result) => result.id === id)?.finding ?? "";
  return { report, finding };
}

/**
 * The probe writes the client lets only a commit tool send: finalizing, a layout change, a
 * contract note (it accepts the offer), a `PUT` to an order or invoice (every one here sets a
 * status or a template's schedule) and a `saveInvoice` that is not a regular draft (a template,
 * or an update without the type).
 */
function needsCommit(call: ScriptedCall): boolean {
  if (/\/(sendBy|changeParameter|createContractNoteFromOrder)$/.test(call.path)) return true;
  if (call.method === "PUT" && /^\/(Order|Invoice)\/\d+$/.test(call.path)) return true;
  if (call.path !== "/Invoice/Factory/saveInvoice") return false;
  return ((call.body as Rec)["invoice"] as Rec)["invoiceType"] !== "RE";
}

describe("gaps-documents probe catalog", () => {
  it("registers every probe once, with the two opt-in probes marked", () => {
    for (const id of IDS) {
      expect(
        ALL_PROBES.filter((probe) => probe.id === id),
        id,
      ).toHaveLength(1);
    }
    expect(GAPS_DOCUMENTS_PROBES.filter((probe) => probe.optIn === true).map((p) => p.id)).toEqual([
      "write-reserved-number-delete-draft",
      "write-recurring-template-due",
      "write-einvoice-discount",
    ]);
    for (const probe of GAPS_DOCUMENTS_PROBES.filter((item) => item.optIn === true)) {
      expect(probe.question).toMatch(/^OPT-IN/);
    }
    expect(GAPS_DOCUMENTS_PROBES.some((probe) => probe.sendsEmail === true)).toBe(false);
  });
});

describe("gaps-documents probes on a simulated trial account", () => {
  it("runs every probe without errors, with the right tiers and nothing sent out", async () => {
    const { client } = gapsAccount();
    const { report } = await run(client);
    expect(report.results.map((result) => result.id).sort()).toEqual([...IDS].sort());
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);
    const writes = client.writes();
    for (const call of writes) {
      expect(call.tier, `${call.method} ${call.path}`).toBe(needsCommit(call) ? "commit" : "write");
      expect(call.path).not.toMatch(/sendViaEmail|enshrine|bookAmount|cancelInvoice/);
    }
    const reserving = client.calls.filter((call) => call.query["useNextNumber"] === "true");
    expect(reserving).toHaveLength(2);
    for (const call of reserving) expect(call).toMatchObject({ sideEffect: true, tier: "write" });
    expect(
      client.calls.filter((call) => /getNext\w+Number$/.test(call.path)).length,
    ).toBeGreaterThan(10);
    // Every order is saved with sevDesk's own number, never without one.
    for (const call of writes.filter((item) => item.path === "/Order/Factory/saveOrder")) {
      const order = (call.body as Rec)["order"] as Rec;
      if (order["id"] === undefined) expect(order["orderNumber"]).toMatch(/^(AN|AB)-10\d\d$/);
    }
    expect(report.created.map((record) => record.objectName)).toEqual(
      expect.arrayContaining(["Contact", "Order", "CreditNote", "Invoice", "TextTemplate"]),
    );
  });

  it("keeps base64 bodies and account data out of the report", async () => {
    const { client } = gapsAccount();
    const { report } = await run(client);
    const markdown = renderReport(report);
    for (const secret of [PDF_BASE64, PNG_BASE64, HTML_BASE64]) {
      expect(markdown).not.toContain(secret.slice(0, 40));
      expect(markdown).not.toContain(secret.slice(-40));
    }
    expect(markdown).not.toContain("Huber");
    expect(() => {
      assertNoSecrets(markdown, [TOKEN]);
    }).not.toThrow();
    const layouts = report.results.find((result) => result.id === "read-docserver-layouts");
    expect(layouts?.finding).toMatch(/img: string \(up to \d+ chars, not shown\)/);
    expect(JSON.stringify(layouts?.evidence)).not.toContain(PNG_BASE64.slice(0, 40));
  });

  it("describes order confirmations and delivery notes against their source", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, {
      only: ["write-order-contract-note-from-order", "write-order-packing-list-from-order"],
    });
    const contract = finding("write-order-contract-note-from-order");
    expect(contract).toMatch(/From a draft offer \(AN\).*new order \d+: type AB, status 100/);
    expect(contract).toMatch(/From a sent offer \(AN\) \(order \d+, status 200\)/);
    expect(contract).toMatch(/\(the peeked next one\); next AB number \S+ → \S+ \(did not move\)/);
    expect(contract).toMatch(/origin \d+ \(Order\), the source/);
    expect(contract).toMatch(/headText taken over, footText taken over; 2 position\(s\)/);
    expect(contract).toMatch(/names taken over; sumNet 150.00 \(source 150.00\)/);
    const packing = finding("write-order-packing-list-from-order");
    expect(packing).toMatch(
      /From a draft order confirmation \(AB\).*refused \(422: Order must not/,
    );
    expect(packing).toMatch(/From a sent order confirmation \(AB\).*type LI/);
    // The run tag's head text is compared, not shown.
    expect(contract).not.toContain(`${TAG} head`);
  });

  it("sets offer statuses, sets them back, and records the renumbering of a draft", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, { only: ["write-order-status-accept-reject"] });
    const text = finding("write-order-status-accept-reject");
    expect(text).toMatch(/^PUT \/Order\/\{id\} set a status\./);
    expect(text).toMatch(/PUT \{status: 500\} ok .*status 200 → 500; changed: nothing else/);
    expect(text).toMatch(/PUT \{status: 200\} ok .*status 500 → 200/);
    expect(text).toMatch(/status 200 → 300/);
    // D-108: a draft offer takes the status as well and gets another number of its range.
    expect(text).toMatch(
      /draft offer → 500 \(order \d+\): PUT \{status: 500\} ok .*status 100 → 500; changed: orderNumber: "([^"]+)" → "(?!\1")[^"]+"/,
    );
    const puts = client
      .writes()
      .filter((call) => call.method === "PUT" && /^\/Order\/\d+$/.test(call.path));
    expect(puts).toHaveLength(5);
    for (const call of puts) expect(Object.keys(call.body as Rec)).toEqual(["status"]);
  });

  it("deletes drafts, records the refusal of non-drafts, and follows the counters", async () => {
    const { client } = gapsAccount();
    const { finding, report } = await run(client, {
      only: ["write-delete-draft-order-credit-note", "write-reserved-number-delete-draft"],
    });
    const text = finding("write-delete-draft-order-credit-note");
    expect(text).toMatch(
      /Offer draft \d+ saved with the peeked number: after saving next AN number \S+ → \S+ \(did not move\); DELETE ok, answer a list of 1; GET afterwards 404: gone/,
    );
    expect(text).toMatch(/Credit note draft \d+ without a number: DELETE ok.*gone/);
    expect(text).toMatch(
      /Sent offer \d+: DELETE refused \(409: Order can only be deleted in status 100 but is status 200\).*still there \(status 200\)/,
    );
    expect(text).toMatch(/No finalized credit note of this run at hand/);
    const reserved = finding("write-reserved-number-delete-draft");
    expect(reserved).toMatch(
      /AN: reserved \S+; next AN number \S+ → \S+ \(moved\) after reserving/,
    );
    // D-066: deleting the draft hands the reserved number out again, in both ranges.
    for (const range of ["AN", "CN"]) {
      expect(reserved).toMatch(
        new RegExp(
          `${range}: reserved ([^;\\s]+);.*?after deleting the next is \\1: sevDesk hands the reserved number out again`,
        ),
      );
    }
    expect(reserved).not.toMatch(/a gap/);
    expect(report.results.find((r) => r.id === "write-reserved-number-delete-draft")?.status).toBe(
      "observed",
    );
    expect(report.created.filter((record) => record.state === "deleted by the probe").length).toBe(
      5,
    );
  });

  it("skips the opt-in probes unless they are selected by id", async () => {
    const { client } = gapsAccount();
    const report = await runProbes(options(client, { probes: GAPS_DOCUMENTS_PROBES }));
    const skipped = report.results.filter((result) => result.status === "skipped");
    expect(skipped.map((result) => result.id)).toEqual([
      "write-reserved-number-delete-draft",
      "write-recurring-template-due",
      "write-einvoice-discount",
    ]);
    expect(client.calls.some((call) => call.query["useNextNumber"] === "true")).toBe(false);
    expect(client.calls.some((call) => call.path.endsWith("/getXml"))).toBe(false);
  });

  it("updates credit note drafts in place, replaces positions and keeps the invoice link", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, { only: ["write-credit-note-update-draft"] });
    const text = finding("write-credit-note-update-draft");
    expect(text).toMatch(
      /Header update of draft (\d+) \(header only\): ok, answer id \1 \(same record\); changed: header:/,
    );
    expect(text).toMatch(
      /creditNotePosDelete as an array, header only\): ok; now 2 position\(s\).*old one gone/,
    );
    expect(text).toMatch(
      /creditNotePosDelete as one object\): ok; now 1 position\(s\).*that one gone/,
    );
    expect(text).toMatch(
      /Credit note \d+ from invoice \d+ \(header only\): ok; origin (\d+) → \1, refSrcInvoice \1 → \1, type CN → CN/,
    );
    const finalized = client.writes().filter((call) => call.path.endsWith("/sendBy"));
    expect(finalized.map((call) => call.path)).toEqual([
      expect.stringMatching(/^\/Invoice\/\d+\/sendBy$/),
    ]);
  });

  it("falls back to the carried header when a header-only credit note update is refused", async () => {
    const { client } = gapsAccount({ refuseMinimalCreditNoteUpdate: true });
    const { finding } = await run(client, { only: ["write-credit-note-update-draft"] });
    expect(finding("write-credit-note-update-draft")).toMatch(
      /carried header \(the header-only update was refused \(422: Must set contact\)\)\): ok/,
    );
    const carried = client
      .writes()
      .map((call) => (call.body as Rec | undefined)?.["creditNote"] as Rec | undefined)
      .find((header) => header?.["contact"] !== undefined && header["id"] !== undefined);
    expect(carried).toMatchObject({
      objectName: "CreditNote",
      mapAll: true,
      contact: { objectName: "Contact" },
      contactPerson: { id: 7, objectName: "SevUser" },
      creditNoteDate: "20.11.2026",
      status: "100",
      taxRule: { id: "9", objectName: "TaxRule" },
    });
  });

  it("creates, lists, changes, deactivates and deletes recurring templates", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, {
      only: [
        "write-recurring-template-create",
        "write-recurring-interval-formats",
        "write-recurring-template-update-end",
        "write-recurring-template-due",
      ],
    });
    const created = finding("write-recurring-template-create");
    expect(created).toMatch(
      /accountIntervall \+ accountNextInvoice: saved as invoice \d+.*type WKR, status 100.*; accountIntervall P0Y1M0W, accountNextInvoice \(empty\), accountStartDate \(empty\)/,
    );
    expect(created).toMatch(
      /recurringInterval \+ recurringStartDate \+ recurringNextVoucher: saved as invoice \d+.*accountIntervall \(empty\)/,
    );
    expect(created).toMatch(
      /listed in: default list false, showWkr=all true, invoiceType=WKR true, showAll=true true/,
    );
    // sendDate no longer counts as a schedule field.
    expect(created).not.toContain("sendDate (empty)");
    const formats = finding("write-recurring-interval-formats");
    expect(formats).toMatch(/accountIntervall "P1M": saved/);
    expect(formats).toMatch(/accountIntervall "1 month": saved.*accountIntervall 1 month/);
    expect(formats).toMatch(
      /accountNextInvoice as dd.mm.yyyy: saved.*accountNextInvoice \(empty\)/,
    );
    const ended = finding("write-recurring-template-update-end");
    expect(ended).toMatch(
      /Update with its id: ok, answer id \d+; changed: accountIntervall: "P0Y1M0W" → "P0Y3M0W"/,
    );
    expect(ended).toMatch(/Deactivate: saveInvoice \{status: 50\} ok → status 50/);
    expect(ended).toMatch(/Back to 100 \(saveInvoice\): ok → status 100/);
    expect(ended).toMatch(/Second template \d+: .*DELETE at status 50: DELETE ok.*gone/);
    // D-111: accountStartDate stores the schedule on create, so the first input is kept.
    const due = finding("write-recurring-template-due");
    expect(due).toMatch(
      /^Kept template (\d+): status 100.*accountNextInvoice 2026-11-19T00:00:00\+01:00, accountStartDate 2026-11-19T00:00:00\+01:00.*stored dates: accountNextInvoice, accountStartDate \(made with: accountStartDate as Unix seconds, run 2026-11-19; getDiscounts refused \(404/,
    );
    // The due template carries a 10 % discount (#124), sent with its first save.
    const firstDue = client
      .writes()
      .find(
        (call) =>
          call.path === "/Invoice/Factory/saveInvoice" &&
          ((call.body as Rec)["invoice"] as Rec)["accountStartDate"] !== undefined,
      );
    expect((firstDue?.body as Rec | undefined)?.["discountSave"]).toEqual([
      expect.objectContaining({ percentage: true, value: 10 }),
    ]);
    expect(due).toMatch(/Run read-recurring-generated tomorrow\. Tried before: nothing\.$/);
    const saves = client
      .writes()
      .filter((call) => call.path === "/Invoice/Factory/saveInvoice")
      .map((call) => (call.body as Rec)["invoice"] as Rec);
    expect(
      saves.filter((header) => header["id"] === undefined).every((h) => h["invoiceType"] === "WKR"),
    ).toBe(true);
  });

  it("finds invoices generated from tagged templates, by origin and by header, each once", async () => {
    const template = {
      id: "900",
      objectName: "Invoice",
      invoiceType: "WKR",
      status: "100",
      header: `${TAG} Abo`,
      customerInternalNote: TAG,
      accountIntervall: "P0Y1M0W",
      accountNextInvoice: "1797462000",
    };
    const generated = {
      id: "901",
      objectName: "Invoice",
      invoiceType: "RE",
      status: "200",
      header: `${TAG} Abo`,
      invoiceNumber: "RE-1044",
      invoiceDate: "2026-11-21T00:00:00+01:00",
      sendDate: "2026-11-21T06:00:00+01:00",
      sendType: "VM",
      origin: { id: "900", objectName: "Invoice" },
    };
    const copy = { ...generated, id: "902", origin: null, status: "100", sendDate: null };
    // A second template of the same run shares the header (`<tag> Abo`).
    const other = { ...template, id: "903" };
    const fromOther = { ...copy, id: "904", origin: { id: "903", objectName: "Invoice" } };
    const { client } = gapsAccount({ invoices: [template, generated, copy, other, fromOther] });
    const { finding } = await run(client, {
      allowWrites: false,
      only: ["read-recurring-generated"],
    });
    const text = finding("read-recurring-generated");
    // 901, 902 and 904, each counted once although both templates match 902 by header.
    expect(text).toMatch(/^2 tagged template\(s\), 3 generated invoice\(s\) found\./);
    expect(text).toMatch(
      /in the default list: false; accountIntervall P0Y1M0W, accountNextInvoice 1797462000/,
    );
    const [first = "", second = ""] = text.split("Template 903 ");
    expect(first).toMatch(
      /generated with this origin: 901: type RE, status 200, number \S+, invoiceDate 2026-11-21.*sendType VM, origin 900/,
    );
    // A row linked to the other template is not listed as a header match of this one.
    expect(first).toMatch(/same header, not linked to a tagged template: 902: type RE, status 100/);
    expect(first).not.toContain("904:");
    expect(second).toMatch(/generated with this origin: 904: type RE, .*origin 903/);
    expect(second).toMatch(/same header, not linked to a tagged template: 902: /);
    expect(second).not.toContain("901:");
    expect(text).not.toContain("RE-1044");
    expect(client.writes()).toEqual([]);
  });

  it("changes language, letterpaper and template on drafts and finds where they are stored", async () => {
    const { client } = gapsAccount();
    const { finding, report } = await run(client, { only: ["write-change-parameter-draft"] });
    const text = finding("write-change-parameter-draft");
    expect(report.results[0]?.status).toBe("observed");
    expect(text).toMatch(/^No draft left the draft state\./);
    expect(text).toMatch(
      /Invoice draft \d+: language "en_US": ok, answer an object with keys metaData; status, sendDate, sendType and number unchanged; other changes: none; value read back in: no field/,
    );
    expect(text).not.toContain("57d7ff34f23ada297d265f22");
    expect(text).toMatch(/Order draft \d+: language "en_US": refused \(500: Syntax error\)/);
    for (const kind of ["Invoice", "Order", "CreditNote"]) expect(text).toContain(`${kind} draft`);
    const changes = client.writes().filter((call) => call.path.endsWith("/changeParameter"));
    expect(changes).toHaveLength(13);
    for (const call of changes) expect(Object.keys(call.body as Rec)).toEqual(["key", "value"]);
    const letterpapers = changes.filter((call) => (call.body as Rec)["key"] === "letterpaper");
    for (const call of letterpapers) {
      expect((call.body as Rec)["value"]).toBe("57d7ff34f23ada297d265f22");
    }
  });

  it("reports a changeParameter that marks a draft as sent as a contradiction", async () => {
    const { client } = gapsAccount({ changeParameterSends: true });
    const { report } = await run(client, { only: ["write-change-parameter-draft"] });
    expect(report.results[0]).toMatchObject({
      status: "contradicted",
      finding: expect.stringMatching(/STATE CHANGED: sendDate: \(empty\) → 2026-11-20/) as unknown,
    });
    expect(report.results[0]?.deviations).toEqual(
      expect.arrayContaining([{ id: "D-023", verdict: "contradicts" }]),
    );
    expect(
      report.created.some((record) => record.state.startsWith("changed by changeParameter")),
    ).toBe(true);
  });

  it("finds which input stores a template's schedule and deletes every probe template", async () => {
    const { client, docs } = gapsAccount();
    const { finding, report } = await run(client, { only: ["write-recurring-schedule-fields"] });
    const text = finding("write-recurring-schedule-fields");
    // D-111: accountStartDate and accountEndDate are stored, accountNextInvoice alone is not.
    const [storedBy = ""] = text.split(". Run date asked for: 2026-12-20");
    expect(storedBy).toMatch(
      /^A schedule date was stored by: accountStartDate as Unix seconds \(accountNextInvoice, accountStartDate\); accountStartDate as ISO \(accountNextInvoice, accountStartDate\); accountStartDate as dd\.mm\.yyyy/,
    );
    expect(storedBy).toMatch(/accountEndDate as dd\.mm\.yyyy \(accountEndDate\)/);
    expect(storedBy).not.toMatch(/accountNextInvoice as ISO|invoiceDate/);
    expect(text).toMatch(
      /accountStartDate as ISO: template \d+: status 100.*accountStartDate 2026-12-20T00:00:00\+01:00.*stored dates: accountNextInvoice, accountStartDate; deleted/,
    );
    expect(text).toMatch(/accountNextInvoice as ISO: template \d+: .*stored dates: none; deleted/);
    expect(text).toMatch(
      /PUT \/Invoice\/\{id\}: accountStartDate \+ accountNextInvoice \(Unix seconds\): template \d+, update ok: status 100.*stored dates: accountNextInvoice, accountStartDate; deleted/,
    );
    // D-112: sevDesk refuses to delete the template at 200; the probe ends it and deletes it.
    expect(text).toMatch(
      /status 200 \(starting the subscription\?\): template (\d+), update ok: status 200.*; DELETE refused \(409: Invoice can only be deleted in status 100 but is status 200\); GET afterwards still there \(status 200\); cleanup: saveInvoice \{status: 50\} ok → status 50; DELETE again: gone\.$/,
    );
    expect([...docs.keys()].filter((key) => key.startsWith("Invoice/"))).toEqual([]);
    expect(report.created.filter((record) => record.objectName === "Invoice")).toHaveLength(12);
    for (const record of report.created.filter((item) => item.objectName === "Invoice")) {
      expect(record.state, String(record.id)).toBe("deleted by the probe");
    }
    // Status 50 goes out between the refused DELETE and the second one.
    const active = Number(
      /status 200 \(starting the subscription\?\): template (\d+)/.exec(text)?.[1],
    );
    const steps = client.writes().flatMap((call) => {
      const invoice = (call.body as Rec | undefined)?.["invoice"] as Rec | undefined;
      if (call.path === `/Invoice/${active}`) return [call.method];
      return invoice?.["id"] === active ? [`saveInvoice status ${String(invoice["status"])}`] : [];
    });
    expect(steps).toEqual(["saveInvoice status 200", "DELETE", "saveInvoice status 50", "DELETE"]);
    const creates = client
      .writes()
      .filter((call) => call.path === "/Invoice/Factory/saveInvoice")
      .map((call) => (call.body as Rec)["invoice"] as Rec)
      .filter((header) => header["id"] === undefined);
    expect(creates).toHaveLength(12);
    expect(creates[0]).toMatchObject({ accountStartDate: 1797721200, invoiceType: "WKR" });
    expect(creates[1]).toMatchObject({ accountStartDate: "2026-12-19T23:00:00.000Z" });
    expect(creates[2]).toMatchObject({ accountStartDate: "20.12.2026" });
  });

  it("says plainly when no input stores a schedule, and then leaves no due template", async () => {
    const { client, docs } = gapsAccount({ ignoreScheduleDates: true });
    const { report, finding } = await run(client, {
      only: ["write-recurring-schedule-fields", "write-recurring-template-due"],
    });
    expect(finding("write-recurring-schedule-fields")).toMatch(
      /^NO input stored a start, end or next-run date: the API does not set a template's schedule this way\./,
    );
    expect(report.results.find((r) => r.id === "write-recurring-template-due")).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(
        /^NO input stored a start or next-run date, so no due template was left/,
      ) as unknown,
    });
    expect([...docs.keys()].filter((key) => key.startsWith("Invoice/"))).toEqual([]);
  });

  it("reads changeParameter choices back from metaData and render, and finds the order form", async () => {
    const { client } = gapsAccount();
    const { finding, report } = await run(client, { only: ["write-change-parameter-read-back"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-change-parameter-read-back");
    expect(text).toMatch(
      /^Invoice draft \d+: language: ok, answer an object with keys metaData; answer keys metaData; metaData: docId, parameters; parameters: language: = the one sent, 2 choice\(s\), visible true; template: no value/,
    );
    expect(text).toMatch(/letterpaper: ok.*letterpaper: = the one sent/);
    expect(text).toMatch(/template: ok.*template: = the one sent/);
    expect(text).toMatch(/language again \(no change\): ok.*language: = the one sent/);
    expect(text).toMatch(
      /GET \/Invoice\/\{id\}\?embed=document: extra keys none; chosen values in: no field/,
    );
    expect(text).toMatch(
      /getPdf \(preventSendBy=true\): keys filename, mimetype, base64Encoded, content; chosen values in: no field/,
    );
    expect(text).toMatch(
      /POST \/Invoice\/\{id\}\/render \{forceReload: false\}: answer keys pdf, docId, parameters; parameters: language: = the one sent/,
    );
    expect(text).toMatch(/status, sendDate, sendType and number unchanged after all of it/);
    expect(text).toMatch(
      /Order draft \d+: accepted: after a getPdf preview \(preventSendBy=true\)\. body \{key, value\}: refused \(500: Syntax error\) \| after a getPdf preview \(preventSendBy=true\): getPdf ok; ok/,
    );
    expect(text).toMatch(/CreditNote draft \d+: accepted: after a getPdf preview/);
    expect(text).not.toContain("57d7ff34f23ada297d265f21");
    expect(text).not.toContain(PDF_BASE64.slice(0, 40));
    const pdfReads = client.calls.filter((call) => call.path.endsWith("/getPdf"));
    for (const call of pdfReads) expect(call.query).toMatchObject({ preventSendBy: "true" });
    const tiers = client
      .writes()
      .map((call) => [call.path.split("/").pop(), call.tier] as const)
      .filter(([endpoint]) => endpoint === "changeParameter" || endpoint === "render");
    for (const [endpoint, tier] of tiers) {
      expect(tier).toBe(endpoint === "changeParameter" ? "commit" : "write");
    }
  });

  it("tries every changeParameter form on orders when none is accepted", async () => {
    const { handler } = gapsAccount();
    // Without the preview workaround: every form is refused on orders and credit notes.
    const refusing = new ScriptedClient((call) => {
      if (call.path.endsWith("/changeParameter") && !call.path.startsWith("/Invoice")) {
        refuse(500, "Syntax error");
      }
      return handler(call);
    });
    const { finding } = await run(refusing, { only: ["write-change-parameter-read-back"] });
    const text = finding("write-change-parameter-read-back");
    expect(text).toMatch(
      /Order draft \d+: no form was accepted\. body \{key, value\}: refused \(500: Syntax error\) \| after a getPdf preview.*refused \(500: Syntax error\) \| after POST \/Order\/\{id\}\/render \{forceReload: false\}: render refused \(404: not found\); refused \(500: Syntax error\) \| key and value in the query: refused \(500: Syntax error\) \| path \/order\/\{id\}\/changeParameter: refused \(500: Syntax error\)/,
    );
    expect(text).toMatch(/path \/Creditnote\/\{id\}\/changeParameter: refused/);
    const queryForm = refusing
      .writes()
      .find((call) => call.path.endsWith("/changeParameter") && call.body === undefined);
    expect(queryForm?.query).toEqual({ key: "language", value: "en_US" });
  });

  it("creates and deletes a text template", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, { only: ["write-text-template-create-delete"] });
    const text = finding("write-text-template-create-delete");
    expect(text).toMatch(
      /category DOCUMENT, objectType RE, textType HEAD, main 0; name as sent, text as sent; listed with textType=HEAD: true\. DELETE ok.*gone/,
    );
    const post = client.writes().find((call) => call.path === "/TextTemplate");
    expect(post?.body).toMatchObject({
      name: `${TAG} text`,
      textType: "HEAD",
      category: "DOCUMENT",
    });
  });

  it("saves document discounts, reads them back and deletes them", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, {
      only: ["write-document-discount", "read-order-get-discounts"],
    });
    const text = finding("write-document-discount");
    expect(text).toMatch(
      /Invoice, 10 % \(as a list, invoice \d+\): .*sumNet 90.00, sumTax 17.10, sumGross 107.10, sumDiscounts 10.00/,
    );
    expect(text).toMatch(/discountDelete: ok; then sumNet 100.00.*discounts left: 0/);
    expect(text).toMatch(
      /Order, fixed 10.00 .*GET \/Order\/\{id\}\/getDiscounts: 1 row\(s\) \(id \d+: discount 1, percentage 0, value 10, isNet 1/,
    );
    expect(text).toMatch(
      /CreditNote, 10 % .*GET \/CreditNote\/\{id\}\/getDiscounts: refused \(404/,
    );
    expect(text).toMatch(/GET \/Discounts by object: \d+ row\(s\), 1 of this Invoice/);
    const discountSaves = client
      .writes()
      .map((call) => (call.body as Rec | undefined)?.["discountSave"])
      .filter((value) => Array.isArray(value));
    expect(discountSaves).toHaveLength(6);
    // The first tagged order lost its discount to discountDelete; the probe asks the next one.
    expect(finding("read-order-get-discounts")).toMatch(
      /^Order \d+: objects is a list of 1 .*keys: id: string.*Orders without discounts asked before: 1\.$/,
    );
  });

  it("falls back to discountSave as one object when the list form is refused", async () => {
    const { client } = gapsAccount({ discountAsObject: true });
    const { report } = await run(client, { only: ["write-document-discount"] });
    expect(report.results[0]?.finding).toMatch(
      /Invoice, 10 % \(as one object \(the list was refused \(400: discountSave expected an object\)\), invoice \d+\): .*sumNet 90.00/,
    );
  });
});

describe("gaps-documents probes on accounts that lack what they need", () => {
  it("answer inconclusive or with sevDesk's refusal, never with an error", async () => {
    const client = new ScriptedClient((call) => {
      if (call.path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
      if (call.path === "/SevUser")
        return { total: 1, objects: [{ id: "7", objectName: "SevUser" }] };
      if (call.method === "POST" && call.path === "/Contact") {
        return { objects: { id: "1", objectName: "Contact" } };
      }
      if (call.method !== "GET") refuse(422, "Refused by the simulated account");
      if (/\/\d+$/.test(call.path)) refuse(404, "not found");
      return { total: 0, objects: [] };
    });
    const { report } = await run(client);
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
    expect(byId["write-order-contract-note-from-order"]).toBe("inconclusive");
    expect(byId["write-recurring-template-create"]).toBe("inconclusive");
    expect(byId["write-change-parameter-draft"]).toBe("inconclusive");
    expect(byId["read-docserver-layouts"]).toBe("inconclusive");
    expect(byId["read-recurring-generated"]).toBe("inconclusive");
  });

  it("send only GETs in a read-only run", async () => {
    const { client } = gapsAccount();
    const { report } = await run(client, { allowWrites: false });
    expect(client.writes()).toEqual([]);
    expect(
      report.results
        .filter((result) => result.mode === "write")
        .every((r) => r.status === "skipped"),
    ).toBe(true);
    expect(report.results.find((result) => result.id === "read-recurring-generated")?.status).toBe(
      "inconclusive",
    );
  });
});

describe("gaps-documents probes for the open discount and template questions (#114, #124, #134)", () => {
  /** Documents of a kind still in the simulated account. */
  const left = (docs: ReadonlyMap<string, Rec>, kind: string) =>
    [...docs.keys()].filter((key) => key.startsWith(`${kind}/`));

  it("reads isNet, value and the sums on net and gross documents of every kind, deleting every draft", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { report, finding } = await run(client, { only: ["write-discount-net-gross"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-discount-net-gross");
    expect(text).toMatch(/^isNet values seen: 1, 0\./);
    for (const kind of ["Invoice", "Order", "CreditNote"]) {
      expect(text).toMatch(
        new RegExp(
          `${kind} net \\(showNet true, price 100\\), fixed 10\\.00 \\(\\w+ \\d+, showNet stored true\\): sumNet 90\\.00, sumTax 17\\.10, sumGross 107\\.10, sumDiscounts -10\\.00, sumDiscountNet -10\\.00, sumDiscountGross -11\\.90; getDiscounts 1 row\\(s\\) \\(id \\d+: discount 1, percentage 0, value 10, isNet 1`,
        ),
      );
      expect(text).toMatch(
        new RegExp(`${kind} gross \\(showNet false, price 119\\), fixed 10\\.00`),
      );
    }
    expect(text).toMatch(
      /Invoice gross \(showNet false, price 119\), fixed 10\.00, isNet false sent \(invoice \d+, showNet stored false\): .*sumDiscountGross -10\.00; getDiscounts 1 row\(s\) \(id \d+: discount 1, percentage 0, value 10, isNet 0/,
    );
    expect(text).toMatch(
      /Cleanup: (Invoice|Order|CreditNote) \d+ deleted(; (Invoice|Order|CreditNote) \d+ deleted){7}\.$/,
    );
    for (const kind of ["Invoice", "Order", "CreditNote"]) expect(left(docs, kind)).toEqual([]);
    // Only the last case sends isNet; gross documents send the gross price.
    const saves = client.writes().filter((call) => /\/Factory\/save/.test(call.path));
    expect(saves).toHaveLength(8);
    const sent = saves.map((call) => ((call.body as Rec)["discountSave"] as Rec[])[0] ?? {});
    expect(sent.filter((item) => "isNet" in item)).toEqual([
      expect.objectContaining({ isNet: false, percentage: false, value: 10 }),
    ]);
    // The discount text carries the run tag; it is never shown.
    expect(renderReport(report)).not.toContain(`${TAG} discount`);
  });

  it("deletes the drafts it made also when sevDesk refuses a later step", async () => {
    const account = gapsAccount({ discountsAsRecorded: true, refuseGrossDocuments: true });
    const { report, finding } = await run(account.client, { only: ["write-discount-net-gross"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-discount-net-gross");
    expect(text).toMatch(
      /Order gross \(showNet false, price 119\), fixed 10\.00: refused \(422: Gross documents are not allowed\)/,
    );
    expect(text).toMatch(
      /Cleanup: CreditNote \d+ deleted; Order \d+ deleted; Invoice \d+ deleted\.$/,
    );
    for (const kind of ["Invoice", "Order", "CreditNote"])
      expect(left(account.docs, kind)).toEqual([]);
  });

  it("reads the split of a discount over 19 % and 7 % and a fixed discount on a CHF invoice", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { finding } = await run(client, {
      only: ["write-discount-mixed-tax", "write-discount-foreign-currency"],
    });
    const mixed = finding("write-discount-mixed-tax");
    expect(mixed).toMatch(
      /^Without a discount the sums would be net 200\.00, tax 26\.00, gross 226\.00\./,
    );
    expect(mixed).toMatch(
      /10 % on 100 at 19 % \+ 100 at 7 % \(invoice \d+\): sumNet 180\.00, sumTax 23\.40, sumGross 203\.40, sumDiscounts -20\.00, sumDiscountNet -20\.00, sumDiscountGross -22\.60;.*positions: 19 %: sumGross 119\.00, sumNet 100\.00, sumTax 19\.00; 7 %: sumGross 107\.00/,
    );
    expect(mixed).toMatch(
      /fixed 10\.00 on 100 at 19 % \+ 100 at 7 % \(invoice \d+\): sumNet 190\.00/,
    );
    const chf = finding("write-discount-foreign-currency");
    expect(chf).toMatch(
      /^CHF invoice \d+, one position of 100\.00 net at 19 %, fixed 10\.00: sumNet 90\.00, .*; currency fields: currency CHF; getDiscounts 1 row\(s\)/,
    );
    expect(chf).toMatch(/Cleanup: Invoice \d+ deleted\.$/);
    const header = client
      .writes()
      .map((call) => (call.body as Rec | undefined)?.["invoice"] as Rec | undefined)
      .find((item) => item?.["currency"] === "CHF");
    expect(header).toBeDefined();
    expect(left(docs, "Invoice")).toEqual([]);
  });

  it("follows an offer's discount to its AB, LI, partial and advance invoice, leaving only the sent offers", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { report, finding } = await run(client, { only: ["write-discount-order-derived"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-discount-order-derived");
    expect(text).toMatch(/^Sent offer \d+ \(150\.00 net, 10 %\): sumNet 135\.00/);
    expect(text).toMatch(/AB \d+ from it: sumNet 135\.00.*getDiscounts 1 row\(s\)/);
    expect(text).toMatch(/LI \d+ from it: sumNet 150\.00.*getDiscounts 0 row\(s\)/);
    for (const type of ["TR", "AR"]) {
      expect(text).toMatch(
        new RegExp(
          `${type} 50 % \\(type percentage, amount 50\\) from offer \\d+ \\(.*\\): invoice \\d+, type ${type}, status 100: sumNet 67\\.50.*getDiscounts 1 row\\(s\\)`,
        ),
      );
    }
    expect(text).toMatch(
      /Cleanup: Invoice \d+ deleted; Order \d+ stays \(status 200, not a draft\); Invoice \d+ deleted; Order \d+ stays \(status 200, not a draft\); Order \d+ deleted; Order \d+ deleted; Order \d+ stays \(status 200, not a draft\)\.$/,
    );
    expect(left(docs, "Invoice")).toEqual([]);
    expect(left(docs, "Order").map((key) => docs.get(key)?.["status"])).toEqual([
      "200",
      "200",
      "200",
    ]);
    const fromOrder = client
      .writes()
      .filter((call) => call.path === "/Invoice/Factory/createInvoiceFromOrder");
    expect(fromOrder.map((call) => (call.body as Rec)["partialType"])).toEqual(["TR", "AR"]);
    for (const call of fromOrder) {
      expect(call.body).toMatchObject({ type: "percentage", amount: 50 });
    }
  });

  it("still deletes the order copies when the invoices from an order are refused", async () => {
    const { docs, client } = gapsAccount({
      discountsAsRecorded: true,
      refuseInvoiceFromOrder: true,
    });
    const { report, finding } = await run(client, { only: ["write-discount-order-derived"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-discount-order-derived");
    expect(text).toMatch(/TR 50 % from offer \d+: refused \(422: Order cannot be invoiced\)/);
    expect(text).toMatch(/AR 50 % from offer \d+: refused \(422: Order cannot be invoiced\)/);
    expect(left(docs, "Order").map((key) => docs.get(key)?.["status"])).toEqual([
      "200",
      "200",
      "200",
    ]);
  });

  it("keeps a template's discount through a replacement of every position, then deletes the template", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { report, finding } = await run(client, {
      only: ["write-recurring-template-discount"],
    });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-recurring-template-discount");
    expect(text).toMatch(
      /^Template \d+ \(start 2026-12-20, 100\.00 net, 10 %\): status 100, sumNet 90\.00.*getDiscounts 1 row\(s\)/,
    );
    expect(text).toMatch(
      /Replacing all 1 position\(s\) by one of 2 × 40\.00 \(no discount keys\): ok; 1 position\(s\) \(2 × 40 at 19 %\); sumNet 72\.00.*discount rows kept: 1 of 1\./,
    );
    expect(text).toMatch(
      /read-recurring-generated-discounts the next day\. Cleanup: template \d+ deleted\.$/,
    );
    expect(left(docs, "Invoice")).toEqual([]);
    const replace = client
      .writes()
      .find(
        (call) =>
          call.path === "/Invoice/Factory/saveInvoice" &&
          ((call.body as Rec)["invoice"] as Rec)["id"] !== undefined &&
          Array.isArray((call.body as Rec)["invoicePosDelete"]),
      );
    expect(replace?.tier).toBe("commit");
    expect(Object.keys(replace?.body as Rec)).toEqual([
      "invoice",
      "invoicePosSave",
      "invoicePosDelete",
    ]);
    expect((replace?.body as Rec)["invoicePosDelete"]).toEqual([
      { id: expect.any(Number) as unknown, objectName: "InvoicePos" },
    ]);
  });

  it("stores month-end start dates, asks for the invoicing range and deletes every template", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { report, finding } = await run(client, { only: ["write-recurring-month-end"] });
    expect(report.results[0]?.status).toBe("observed");
    const text = finding("write-recurring-month-end");
    for (const day of ["29", "30", "31"]) {
      expect(text).toMatch(
        new RegExp(
          `start 2027-01-${day} \\(template \\d+\\): status 100; accountIntervall P0Y1M0W, accountNextInvoice 2027-01-${day}T00:00:00\\+01:00, accountStartDate 2027-01-${day}T00:00:00\\+01:00`,
        ),
      );
    }
    expect(text).toMatch(
      /start 2027-01-31, end 2027-02-28 \(template \d+\): .*accountEndDate 2027-02-28T00:00:00\+01:00/,
    );
    expect(text).toMatch(
      /startDate 31 January as Unix seconds: refused \(400: Invalid date\); startDate 31 January as dd\.mm\.yyyy: startDate 2027-01-31, endDate 2027-02-27\./,
    );
    expect(text).toMatch(/Not answerable on a trial within days/);
    expect(text).toMatch(/Cleanup: (template \d+ deleted(; |\.$)){4}/);
    expect(left(docs, "Invoice")).toEqual([]);
    // Without the computation the templates are still read and deleted.
    const plain = gapsAccount();
    const { finding: plainFinding } = await run(plain.client, {
      only: ["write-recurring-month-end"],
    });
    expect(plainFinding("write-recurring-month-end")).toMatch(
      /dd\.mm\.yyyy: refused \(422: not simulated\)/,
    );
    expect(left(plain.docs, "Invoice")).toEqual([]);
  });

  it("reads the allowance of an e-invoice with a discount, only when selected (opt-in)", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    const { report, finding } = await run(client, { only: ["write-einvoice-discount"] });
    const result = report.results[0];
    expect(result?.status).toBe("observed");
    const text = finding("write-einvoice-discount");
    expect(text).toMatch(
      /^E-invoice \d+ with 10 % on 100\.00 net finalized \(sumNet 90\.00.*\)\. getXml: CII, profile "urn:cen\.eu:en16931:2017"; 1 allowance\/charge element\(s\) \(document level, charge false, amount 10\.00, percent 10\.00, basis 100\.00\); AllowanceTotalAmount 10\.00, TaxBasisTotalAmount 90\.00\./,
    );
    expect(text).toMatch(/Cleanup: Invoice \d+ stays \(status 200, not a draft\)\.$/);
    expect(left(docs, "Invoice").map((key) => docs.get(key)?.["status"])).toEqual(["200"]);
    const markdown = renderReport(report);
    expect(markdown).toContain("Fixture candidate: getXml of e-invoice");
    expect(markdown).not.toContain("Huber");
    expect(markdown).not.toContain(`${TAG} discount`);
  });

  it("reads the discounts of tagged templates and of the invoices generated from them", async () => {
    const { client, docs } = gapsAccount({ discountsAsRecorded: true });
    await run(client, { only: ["write-recurring-template-due"] });
    const [templateKey = ""] = left(docs, "Invoice");
    const template = docs.get(templateKey) ?? {};
    // What sevDesk generated on the run date (D-111): a draft with the template as origin.
    docs.set("Invoice/990", {
      id: "990",
      objectName: "Invoice",
      invoiceType: "RE",
      status: "100",
      header: template["header"],
      origin: ref("Invoice", template["id"]),
      sumNet: "100.00",
    });
    const { report, finding } = await run(client, {
      allowWrites: false,
      only: ["read-recurring-generated-discounts"],
    });
    expect(report.results[0]?.status).toBe("observed");
    expect(finding("read-recurring-generated-discounts")).toMatch(
      /^1 tagged template\(s\), 1 generated invoice\(s\)\. Template \d+ \(status 100\): sumNet 90\.00.*getDiscounts 1 row\(s\) \(id \d+: discount 1, percentage 1, value 10.*generated: 990 \(type RE, status 100\): sumNet 100\.00.*getDiscounts 0 row\(s\)\.$/,
    );
    const empty = gapsAccount();
    const none = await run(empty.client, {
      allowWrites: false,
      only: ["read-recurring-generated-discounts"],
    });
    expect(none.report.results[0]?.status).toBe("inconclusive");
  });

  it("tells document allowances from line allowances in UBL and CII", () => {
    const ubl = [
      "<Invoice><cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:MultiplierFactorNumeric>5</cbc:MultiplierFactorNumeric><cbc:Amount>5.00</cbc:Amount><cbc:BaseAmount>100.00</cbc:BaseAmount></cac:AllowanceCharge>",
      "<cac:InvoiceLine><cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:Amount>1.00</cbc:Amount></cac:AllowanceCharge></cac:InvoiceLine>",
      "<cac:LegalMonetaryTotal><cbc:AllowanceTotalAmount>5.00</cbc:AllowanceTotalAmount><cbc:TaxExclusiveAmount>96.00</cbc:TaxExclusiveAmount></cac:LegalMonetaryTotal></Invoice>",
    ].join("");
    expect(allowanceFacts(ubl)).toBe(
      "2 allowance/charge element(s) (document level, charge false, amount 5.00, percent 5, basis 100.00; line level, charge true, amount 1.00, percent -, basis -); AllowanceTotalAmount 5.00, TaxBasisTotalAmount 96.00",
    );
    expect(allowanceFacts("<rsm:CrossIndustryInvoice/>")).toBe(
      "0 allowance/charge element(s); AllowanceTotalAmount absent, TaxBasisTotalAmount absent",
    );
  });
});
