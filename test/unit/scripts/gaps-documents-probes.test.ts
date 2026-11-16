import { describe, expect, it } from "vitest";

import { ALL_PROBES } from "../../../scripts/lib/probes/catalog.js";
import { GAPS_DOCUMENTS_PROBES } from "../../../scripts/lib/probes/gaps-documents-probes.js";
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
}

const DOC_ID = "d4605b19248ad176443b7cb382679b1f";

const SCHEDULE_DATES: readonly string[] = [
  "accountNextInvoice",
  "accountStartDate",
  "accountEndDate",
  "accountLastInvoice",
];

/**
 * A simulated trial account for these probes. Where the 2026-11-16 run recorded a behaviour, it
 * follows it (orders need a number, templates store no schedule date on create, changeParameter
 * answers `{metaData}` and leaves the record alone, order and credit note changeParameter answer
 * 500 "Syntax error"); the rest are assumptions for the probes' logic (marked synthetic): a
 * saveInvoice update stores schedule dates, changeParameter on orders and credit notes works after
 * a getPdf preview, only the language en_US is known.
 */
function gapsAccount(settings: AccountSettings = {}) {
  let nextId = 500;
  const docs = new Map<string, Rec>();
  const positions: Rec[] = [];
  const discounts: Rec[] = [];
  const textTemplates = new Map<string, Rec>();
  const counters: Record<string, number> = { AN: 1000, AB: 1000, LI: 1000, CN: 1000 };
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
  const ofDoc = (rows: readonly Rec[], kind: string, id: unknown, key: string) =>
    rows.filter((row) => {
      const target = row[key] as Rec | undefined;
      return target?.["id"] === String(id) && target["objectName"] === kind;
    });

  function recompute(kind: Kind, doc: Rec): void {
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
      const keepDates = found["invoiceType"] === "WKR" && settings.ignoreScheduleDates !== true;
      for (const [field, value] of Object.entries(header)) {
        if (["id", "objectName", "mapAll"].includes(field)) continue;
        if (SCHEDULE_DATES.includes(field) && !keepDates) continue;
        found[field] = SCHEDULE_DATES.includes(field) ? String(value) : value;
      }
      if (header["status"] !== undefined) found["status"] = idOf(header["status"]);
      doc = found;
    } else {
      if (kind === "Order" && (header["orderNumber"] ?? "") === "") refuse(400, "Bad Request");
      const id = String(nextId++);
      // Recorded 2026-11-16: a WKR template keeps any accountIntervall string and stores no
      // schedule date and no recurring* field on create.
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
        isNet: "1",
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
    recompute("Order", doc);
    return { objects: doc };
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
      if (query["useNextNumber"] === "true") counters[next] = (counters[next] ?? 0) + 1;
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
      if (discountsOf[1] !== "Order") refuse(404, "not found");
      return list(ofDoc(discounts, "Order", discountsOf[2], "object"));
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
      if (doc["status"] === "100") refuse(400, "A draft cannot change its status");
      doc["status"] = String(body["status"]);
      return { objects: doc };
    }
    const byId = /^\/(Invoice|Order|CreditNote|TextTemplate)\/(\d+)$/.exec(path);
    if (byId !== null) {
      const store = byId[1] === "TextTemplate" ? undefined : `${byId[1] ?? ""}/${byId[2] ?? ""}`;
      const doc = store === undefined ? textTemplates.get(byId[2] ?? "") : docs.get(store);
      if (doc === undefined) return refuse(404, "not found");
      if (method === "GET") return { objects: [doc] };
      if (method === "DELETE") {
        if (doc["status"] !== "100" && doc["invoiceType"] !== "WKR" && store !== undefined) {
          refuse(409, `${byId[1] ?? ""} can only be deleted in status 100`);
        }
        if (store === undefined) textTemplates.delete(byId[2] ?? "");
        else docs.delete(store);
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
  return { client: new ScriptedClient(handler), handler, docs, counters };
}

async function run(client: ScriptedClient, overrides: Partial<RunOptions> = {}) {
  const report = await runProbes(options(client, { only: IDS, ...overrides }));
  const finding = (id: string) => report.results.find((result) => result.id === id)?.finding ?? "";
  return { report, finding };
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
      const commit = call.path.endsWith("/sendBy") || call.path.endsWith("/changeParameter");
      expect(call.tier, call.path).toBe(commit ? "commit" : "write");
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

  it("sets offer statuses, sets them back, and records the refusal on a draft", async () => {
    const { client } = gapsAccount();
    const { finding } = await run(client, { only: ["write-order-status-accept-reject"] });
    const text = finding("write-order-status-accept-reject");
    expect(text).toMatch(/^PUT \/Order\/\{id\} set a status\./);
    expect(text).toMatch(/PUT \{status: 500\} ok .*status 200 → 500; changed: nothing else/);
    expect(text).toMatch(/PUT \{status: 200\} ok .*status 500 → 200/);
    expect(text).toMatch(/status 200 → 300/);
    expect(text).toMatch(/draft offer → 500 .*refused \(400: A draft cannot change its status\)/);
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
      /Sent offer \d+: DELETE refused \(409: Order can only be deleted in status 100\).*still there \(status 200\)/,
    );
    expect(text).toMatch(/No finalized credit note of this run at hand/);
    const reserved = finding("write-reserved-number-delete-draft");
    expect(reserved).toMatch(
      /AN: reserved \S+; next AN number \S+ → \S+ \(moved\) after reserving/,
    );
    expect(reserved).toMatch(/the reserved number stays used: a gap.*CN: reserved/);
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
    ]);
    expect(client.calls.some((call) => call.query["useNextNumber"] === "true")).toBe(false);
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
    // The simulated account stores schedule dates only through an update with the id.
    const due = finding("write-recurring-template-due");
    expect(due).toMatch(
      /^Kept template (\d+), update ok: status 100.*stored dates: accountNextInvoice, accountStartDate \(made with: update with the id: accountStartDate \+ accountNextInvoice \(Unix seconds\), run 2026-11-19\)/,
    );
    expect(due).toMatch(
      /Tried before: accountStartDate as Unix seconds, run 2026-11-19: no start or next-run date stored \(deleted\)/,
    );
    expect(due).toMatch(/Run read-recurring-generated tomorrow/);
    const saves = client
      .writes()
      .filter((call) => call.path === "/Invoice/Factory/saveInvoice")
      .map((call) => (call.body as Rec)["invoice"] as Rec);
    expect(
      saves.filter((header) => header["id"] === undefined).every((h) => h["invoiceType"] === "WKR"),
    ).toBe(true);
  });

  it("finds invoices generated from tagged templates, by origin and by header", async () => {
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
    const { client } = gapsAccount({ invoices: [template, generated, copy] });
    const { finding } = await run(client, {
      allowWrites: false,
      only: ["read-recurring-generated"],
    });
    const text = finding("read-recurring-generated");
    expect(text).toMatch(/^1 tagged template\(s\), 2 generated invoice\(s\) found\./);
    expect(text).toMatch(
      /in the default list: false; accountIntervall P0Y1M0W, accountNextInvoice 1797462000/,
    );
    expect(text).toMatch(
      /generated with this origin: 901: type RE, status 200, number \S+, invoiceDate 2026-11-21.*sendType VM, origin 900/,
    );
    expect(text).toMatch(/same header, no origin link: 902: type RE, status 100/);
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
    const { finding } = await run(client, { only: ["write-recurring-schedule-fields"] });
    const text = finding("write-recurring-schedule-fields");
    expect(text).toMatch(
      /^A schedule date was stored by: update with the id: accountStartDate \+ accountNextInvoice \(Unix seconds\) \(accountNextInvoice, accountStartDate\)\. Run date asked for: 2026-12-20/,
    );
    expect(text).toMatch(
      /accountStartDate as ISO: template \d+: status 100.*stored dates: none; deleted/,
    );
    expect(text).toMatch(/PUT \/Invoice\/\{id\}: .*update refused \(400: not simulated\)/);
    expect(text).toMatch(
      /status 200 \(starting the subscription\?\): template \d+, update ok: status 200/,
    );
    expect([...docs.keys()].filter((key) => key.startsWith("Invoice/"))).toEqual([]);
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
