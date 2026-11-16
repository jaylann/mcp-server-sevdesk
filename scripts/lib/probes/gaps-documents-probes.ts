/**
 * Probes for the competitor-gap issues on documents: orders (#89: order confirmations and delivery
 * notes from an order, accepting or rejecting an offer, order discounts), drafts (#90: deleting
 * order and credit note drafts, updating credit note drafts), recurring invoice templates (#91) and
 * the layout of documents (#94: language, letterpaper and template, text templates, a discount on
 * the whole document).
 *
 * Like every write probe they run only with `--allow-writes` on a trial account and create their
 * own tagged data through `createTestData` (contact, drafts, headers and notes carry the run tag),
 * which lands in the cleanup list. Nothing is e-mailed or enshrined. Documents are finalized
 * (`sendBy`, which only marks them as sent) only where a question needs a sent document, and the
 * probe's question says so. Findings report codes, amounts, ids, key names and scrubbed values;
 * base64 bodies (the PDF of a `changeParameter` answer, the DocServer thumbnails) never reach a
 * finding, and the run's scrubber replaces them in the evidence.
 *
 * Orders need a number: `saveOrder` without `orderNumber` is refused (D-027). The probes save
 * orders with the number `getNextOrderNumber` peeks (`useNextNumber=false`, reserves nothing).
 * Only the opt-in probe `write-reserved-number-delete-draft` reserves numbers, as the draft tools
 * do (D-066), and so consumes numbers of the trial's sequences.
 */
import { rowsOf } from "../fixture-plan.js";
import { RUN_TAG_PREFIX } from "../live-env.js";
import {
  addDays,
  berlinMidnight,
  createdId,
  diffState,
  type DocumentKind,
  germanDate,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  type Query,
  refId,
  type Row,
  sendState,
  str,
  type TestData,
} from "./core.js";
import {
  changedFields,
  data,
  firstRow,
  inconclusive,
  isGone,
  outcomeOf,
  shapeOf,
} from "./m4-shared-probes.js";

type DraftOptions = NonNullable<Parameters<TestData["draft"]>[1]>;
type OrderType = "AN" | "AB" | "LI";
/** A number range: the three order types and credit notes. */
type NumberRange = OrderType | "CN";

const NUMBER_KEY: Readonly<Record<DocumentKind, string>> = {
  Invoice: "invoiceNumber",
  CreditNote: "creditNoteNumber",
  Order: "orderNumber",
};

const BODY_KEY: Readonly<Record<DocumentKind, string>> = {
  Invoice: "invoice",
  CreditNote: "creditNote",
  Order: "order",
};

const POSITIONS: Readonly<Record<DocumentKind, { readonly path: string; readonly key: string }>> = {
  Invoice: { path: "/InvoicePos", key: "invoice" },
  CreditNote: { path: "/CreditNotePos", key: "creditNote" },
  Order: { path: "/OrderPos", key: "order" },
};

/** The `type` of `getTemplatesWithThumb` per document kind (spec enum). */
const TEMPLATE_TYPE: Readonly<Record<DocumentKind, string>> = {
  Invoice: "Invoice",
  Order: "Order",
  CreditNote: "Creditnote",
};

const KINDS: readonly DocumentKind[] = ["Invoice", "Order", "CreditNote"];

/** Language values tried in turn: the spec names no format. */
const LANGUAGES: readonly string[] = ["en_US", "en", "EN"];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scrubbed copy of a row, for diffs that end up in a finding. */
function safe(ctx: ProbeContext, row: Row | undefined): Row | undefined {
  return row === undefined ? undefined : (ctx.scrubber.scrub(row) as Row);
}

/** One sevDesk value as the report may show it: scrubbed under its own key. */
function shown(ctx: ProbeContext, key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "(empty)";
  const scrubbed: unknown = (ctx.scrubber.scrub({ [key]: value }) as Row)[key];
  return typeof scrubbed === "string" ||
    typeof scrubbed === "number" ||
    typeof scrubbed === "boolean"
    ? String(scrubbed)
    : JSON.stringify(scrubbed);
}

/** `ok` with the answer's shape, or the refusal. */
function answerOf(result: HttpResult): string {
  return result.ok ? `ok, answer ${shapeOf(result.objects)}` : outcomeOf(result);
}

/** The document number of a row: "no number" or the scrubbed number. */
function numberText(ctx: ProbeContext, row: Row | undefined, kind: DocumentKind): string {
  const number = str(row, NUMBER_KEY[kind]);
  return number === "" ? "no number" : `number ${shown(ctx, NUMBER_KEY[kind], number)}`;
}

/** The sums sevDesk computed for a document. */
function sums(row: Row | undefined): string {
  return ["sumNet", "sumTax", "sumGross", "sumDiscounts"]
    .map((key) => `${key} ${str(row, key) || "-"}`)
    .join(", ");
}

function rangeRequest(range: NumberRange): {
  readonly path: string;
  readonly query: Query;
  readonly key: string;
} {
  return range === "CN"
    ? { path: "/CreditNote/Factory/getNextCreditNoteNumber", query: {}, key: "creditNoteNumber" }
    : {
        path: "/Order/Factory/getNextOrderNumber",
        query: { orderType: range },
        key: "orderNumber",
      };
}

function numberOf(result: HttpResult): string | undefined {
  return result.ok && typeof result.objects === "string" && result.objects !== ""
    ? result.objects
    : undefined;
}

/** The next number of a range without reserving it (`useNextNumber=false`, D-066). */
async function peekNumber(ctx: ProbeContext, range: NumberRange): Promise<string | undefined> {
  const { path, query } = rangeRequest(range);
  return numberOf(await ctx.http.get(path, { ...query, useNextNumber: "false" }));
}

/**
 * Reserves the next number of a range (`useNextNumber=true`), as the draft tools do (D-066): a
 * side-effect GET with the write tier. Only the opt-in probe `write-reserved-number-delete-draft`
 * calls it, because it consumes a number of the trial's sequence.
 */
async function reserveNumber(ctx: ProbeContext, range: NumberRange): Promise<string | undefined> {
  const { path, query } = rangeRequest(range);
  return numberOf(await ctx.http.get(path, { ...query, useNextNumber: "true" }, { tier: "write" }));
}

/** `next AB number X → Y (moved | did not move)`, scrubbed. */
function counterNote(
  ctx: ProbeContext,
  range: NumberRange,
  before: string | undefined,
  after: string | undefined,
): string {
  const { key } = rangeRequest(range);
  const text = `next ${range} number ${shown(ctx, key, before)} → ${shown(ctx, key, after)}`;
  if (before === undefined || after === undefined) return `${text} (a peek failed)`;
  return `${text} (${before === after ? "did not move" : "moved"})`;
}

/** An order draft saved with the peeked number of its range (or `number`). */
async function orderDraft(
  ctx: ProbeContext,
  orderType: OrderType,
  options: DraftOptions = {},
  number?: string,
): Promise<{
  readonly id: number | undefined;
  readonly result: HttpResult;
  readonly number: string | undefined;
}> {
  const orderNumber = number ?? (await peekNumber(ctx, orderType));
  const draft = await data(ctx).draft("Order", {
    ...options,
    orderType,
    fields: { ...options.fields, ...(orderNumber === undefined ? {} : { orderNumber }) },
  });
  return { ...draft, number: orderNumber };
}

/** A draft of any kind (orders as offers with a peeked number). */
async function documentDraft(
  ctx: ProbeContext,
  kind: DocumentKind,
  options: DraftOptions = {},
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  return kind === "Order" ? orderDraft(ctx, "AN", options) : data(ctx).draft(kind, options);
}

async function positionsOf(ctx: ProbeContext, kind: DocumentKind, id: number): Promise<Row[]> {
  const { path, key } = POSITIONS[kind];
  const page = await ctx.read.page(path, { [`${key}[id]`]: id, [`${key}[objectName]`]: kind }, 50);
  return page.rows.filter((row) => refId(row, key) === id);
}

function describePositions(rows: readonly Row[]): string {
  const items = rows.map(
    (row) => `${str(row, "quantity")} × ${str(row, "price")} at ${str(row, "taxRate")} %`,
  );
  return `${rows.length} position(s)${items.length === 0 ? "" : ` (${items.join(", ")})`}`;
}

/** Whether two position lists carry the same names (in any order). */
function sameNames(a: readonly Row[], b: readonly Row[]): boolean {
  const names = (rows: readonly Row[]) =>
    rows
      .map((row) => str(row, "name"))
      .sort()
      .join("\n");
  return a.length === b.length && names(a) === names(b);
}

/** `origin 123 (Order), the source` or `origin none`. */
function originText(row: Row | undefined, sourceId: number): string {
  const id = refId(row, "origin");
  if (id === undefined) {
    const scalar = str(row, "origin");
    return scalar === "" ? "origin none" : `origin ${scalar} (scalar)`;
  }
  const objectName = str(isRecord(row?.["origin"]) ? row["origin"] : undefined, "objectName");
  return `origin ${id} (${objectName || "no objectName"})${id === sourceId ? ", the source" : ", NOT the source"}`;
}

/** DELETE `/<kind>/<id>`, then GET it: the answer and whether the record is gone. */
async function deleteAndCheck(
  ctx: ProbeContext,
  objectName: string,
  id: number,
): Promise<{ readonly text: string; readonly gone: boolean }> {
  const deleted = await ctx.http.write("DELETE", `/${objectName}/${id}`, { tier: "write" });
  const after = await ctx.http.get(`/${objectName}/${id}`);
  const gone = isGone(after);
  if (gone) data(ctx).mark(objectName, id, "deleted by the probe");
  const still = firstRow(after.objects);
  return {
    gone,
    text:
      `DELETE ${answerOf(deleted)}; GET afterwards ` +
      (gone
        ? `${after.ok ? "an empty list" : String(after.status ?? after.kind)}: gone`
        : after.ok
          ? `still there (status ${str(still, "status")})`
          : outcomeOf(after)),
  };
}

/** Reads the record of `kind` by id; with the scrubbed send state and number. */
async function stateOf(
  ctx: ProbeContext,
  kind: DocumentKind,
  id: number,
): Promise<{ readonly row: Row | undefined; readonly state: Record<string, string> }> {
  const row = await ctx.read.byId(kind, id);
  const scrubbed = safe(ctx, row);
  return {
    row,
    state: { ...sendState(scrubbed), number: str(scrubbed, NUMBER_KEY[kind]) },
  };
}

// ---------------------------------------------------------------------------------------------
// #89: documents derived from an order, offer status, order discounts
// ---------------------------------------------------------------------------------------------

interface DeriveSource {
  readonly label: string;
  readonly orderType: OrderType;
  readonly finalize: boolean;
}

/**
 * Creates each source order (two positions, head and foot text), optionally finalizes it, calls
 * the factory and describes the new order against its source.
 */
async function deriveFromOrders(
  ctx: ProbeContext,
  factory: "createContractNoteFromOrder" | "createPackingListFromOrder",
  range: OrderType,
  sources: readonly DeriveSource[],
): Promise<ProbeOutcome> {
  const tag = data(ctx).tag;
  const lines: string[] = [];
  let created = 0;
  for (const source of sources) {
    const order = await orderDraft(ctx, source.orderType, {
      positions: [{ price: 100 }, { price: 25, quantity: 2 }],
      fields: { headText: `${tag} head`, footText: `${tag} foot` },
    });
    if (order.id === undefined) {
      lines.push(`${source.label}: the source order was refused (${outcomeOf(order.result)})`);
      continue;
    }
    if (source.finalize) {
      const finalized = await data(ctx).finalize("Order", order.id);
      if (!finalized.ok) {
        lines.push(`${source.label}: sendBy of order ${order.id} ${outcomeOf(finalized)}`);
        continue;
      }
      data(ctx).mark("Order", order.id, "marked as sent with sendBy (orders are not enshrined)");
    }
    const sourceRow = await ctx.read.byId("Order", order.id);
    const sourcePositions = await positionsOf(ctx, "Order", order.id);
    const before = await peekNumber(ctx, range);
    const result = await ctx.http.write("POST", `/Order/Factory/${factory}`, {
      tier: "write",
      query: { "order[id]": order.id, "order[objectName]": "Order" },
      body: { id: order.id, objectName: "Order" },
    });
    const id = createdId(result.objects, "order");
    if (!result.ok || id === undefined || id === order.id) {
      lines.push(
        `${source.label} (order ${order.id}, status ${str(sourceRow, "status")}): ${answerOf(result)}` +
          (id === order.id ? " (the answer names the source order)" : ""),
      );
      continue;
    }
    created += 1;
    data(ctx).register("Order", id, `${range} from order ${order.id} (draft? deletable)`);
    const row = await ctx.read.byId("Order", id);
    if (str(row, "status") !== "100") {
      data(ctx).mark("Order", id, `${range} from order ${order.id}, status ${str(row, "status")}`);
    }
    const positions = await positionsOf(ctx, "Order", id);
    const after = await peekNumber(ctx, range);
    const sourceAfter = await ctx.read.byId("Order", order.id);
    const number = str(row, "orderNumber");
    const texts = (["headText", "footText"] as const)
      .map((key) => {
        const value = str(row, key);
        if (value === "") return `${key} empty`;
        return `${key} ${value === str(sourceRow, key) ? "taken over" : "different"}`;
      })
      .join(", ");
    lines.push(
      `${source.label} (order ${order.id}, status ${str(sourceRow, "status")}): ${answerOf(result)}; ` +
        `new order ${id}: type ${str(row, "orderType")}, status ${str(row, "status")}, ` +
        `${number === "" ? "no number" : `number ${shown(ctx, "orderNumber", number)}${number === before ? " (the peeked next one)" : ""}`}; ` +
        `${counterNote(ctx, range, before, after)}; ${originText(row, order.id)}; ` +
        `contact ${refId(row, "contact") === refId(sourceRow, "contact") ? "the source's" : "different"}; ` +
        `${texts}; ${describePositions(positions)} of the source's ${sourcePositions.length}, names ` +
        `${sameNames(positions, sourcePositions) ? "taken over" : "different"}; sumNet ${str(row, "sumNet")} ` +
        `(source ${str(sourceRow, "sumNet")}); source status ${str(sourceRow, "status")} → ${str(sourceAfter, "status")}`,
    );
  }
  if (created === 0 && lines.every((line) => line.includes("source order was refused"))) {
    return inconclusive(`${lines.join(". ")}.`);
  }
  return { verdict: "observed", finding: `${lines.join(". ")}.` };
}

/** `PUT /Order/{id}` with only a status; the answer and what changed. */
async function putOrderStatus(
  ctx: ProbeContext,
  id: number,
  status: number,
): Promise<{ readonly text: string; readonly status: string }> {
  const before = await ctx.read.byId("Order", id);
  const result = await ctx.http.write("PUT", `/Order/${id}`, { tier: "write", body: { status } });
  const after = await ctx.read.byId("Order", id);
  const answered = firstRow(result.objects);
  return {
    status: str(after, "status"),
    text:
      `PUT {status: ${status}} ${result.ok ? `ok (answer ${shapeOf(result.objects)}, status in the answer ${str(answered, "status") || "-"})` : outcomeOf(result)}; ` +
      `status ${str(before, "status")} → ${str(after, "status")}; changed: ${changedFields(safe(ctx, before), safe(ctx, after), ["status"]) || "nothing else"}`,
  };
}

// ---------------------------------------------------------------------------------------------
// #90: credit note updates
// ---------------------------------------------------------------------------------------------

function compact(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** A stored document date as `dd.mm.yyyy` (from ISO or `dd.mm.yyyy`), else `undefined`. */
function documentDate(value: string): string | undefined {
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return value;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? germanDate(value.slice(0, 10)) : undefined;
}

/** A stored delivery date as Unix seconds (from Unix seconds or an ISO date), else `undefined`. */
function deliveryDate(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? berlinMidnight(value.slice(0, 10)) : undefined;
}

/**
 * The header of a stored credit note as an update tool would carry it over (every writable field
 * it knows), with the id; dates as `dd.mm.yyyy` and Unix seconds of Berlin midnight (D-018).
 */
function carriedCreditNote(row: Row, id: number): Record<string, unknown> {
  const ref = (key: string, objectName: string) => {
    const refIdValue = refId(row, key);
    return refIdValue === undefined
      ? undefined
      : { id: objectName === "TaxRule" ? String(refIdValue) : refIdValue, objectName };
  };
  const number = str(row, "creditNoteNumber");
  return compact({
    id,
    objectName: "CreditNote",
    mapAll: true,
    contact: ref("contact", "Contact"),
    contactPerson: ref("contactPerson", "SevUser"),
    creditNoteDate: documentDate(str(row, "creditNoteDate")),
    deliveryDate: deliveryDate(str(row, "deliveryDate")),
    status: str(row, "status") || "100",
    creditNoteType: str(row, "creditNoteType") || undefined,
    bookingCategory: str(row, "bookingCategory") || undefined,
    taxRule: ref("taxRule", "TaxRule"),
    taxRate: 0,
    taxText: str(row, "taxText") || undefined,
    currency: str(row, "currency") || undefined,
    showNet: str(row, "showNet") === "1" || str(row, "showNet") === "true",
    addressCountry: ref("addressCountry", "StaticCountry"),
    creditNoteNumber: number === "" ? undefined : number,
    refSrcInvoice: ref("refSrcInvoice", "Invoice"),
  });
}

/**
 * `saveCreditNote` with the id and `extra` body keys: first with a header of only id, objectName,
 * mapAll and the new header text; if sevDesk refuses that, with the carried-over header.
 */
async function updateCreditNote(
  ctx: ProbeContext,
  id: number,
  stored: Row | undefined,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly result: HttpResult; readonly form: string }> {
  const header = `${data(ctx).tag} CreditNote updated`;
  const send = (creditNote: Readonly<Record<string, unknown>>) =>
    ctx.http.write("POST", "/CreditNote/Factory/saveCreditNote", {
      tier: "write",
      body: { creditNote, creditNotePosSave: [], creditNotePosDelete: null, ...extra },
    });
  const minimal = await send({ id, objectName: "CreditNote", mapAll: true, header });
  if (minimal.ok || stored === undefined) return { result: minimal, form: "header only" };
  const carried = await send({ ...carriedCreditNote(stored, id), header });
  return {
    result: carried,
    form: `carried header (the header-only update was ${outcomeOf(minimal)})`,
  };
}

function creditNotePosition(tag: string, price: number): Record<string, unknown> {
  return {
    objectName: "CreditNotePos",
    mapAll: true,
    quantity: 1,
    price,
    name: `${tag} replacement`,
    unity: { id: 1, objectName: "Unity" },
    taxRate: 19,
  };
}

// ---------------------------------------------------------------------------------------------
// #91: recurring invoice templates (WKR)
// ---------------------------------------------------------------------------------------------

/** The two field sets a template may be made with: the code's names and issue #91's. */
const TEMPLATE_FORMS: readonly {
  readonly label: string;
  readonly fields: (next: string, interval: string) => Record<string, unknown>;
}[] = [
  {
    label: "accountIntervall + accountNextInvoice",
    fields: (next, interval) => ({
      accountIntervall: interval,
      accountNextInvoice: berlinMidnight(next),
    }),
  },
  {
    label: "recurringInterval + recurringStartDate + recurringNextVoucher",
    fields: (next, interval) => ({
      recurringInterval: interval,
      recurringStartDate: germanDate(next),
      recurringNextVoucher: germanDate(next),
    }),
  },
];

/** Keys of a template row that describe its schedule. */
const SCHEDULE_KEY = /intervall?|nextinvoice|lastinvoice|recurring|startdate|enddate|nextvoucher/i;

function schedule(ctx: ProbeContext, row: Row | undefined): string {
  const entries = Object.entries(row ?? {}).filter(([key]) => SCHEDULE_KEY.test(key));
  return (
    entries.map(([key, value]) => `${key} ${shown(ctx, key, value)}`).join(", ") ||
    "no schedule fields"
  );
}

async function templateDraft(
  ctx: ProbeContext,
  fields: Readonly<Record<string, unknown>>,
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  return data(ctx).draft("Invoice", {
    fields: { invoiceType: "WKR", header: `${data(ctx).tag} Abo`, ...fields },
  });
}

/** A template with the first field set sevDesk accepts; marks it in the cleanup list. */
async function createTemplate(
  ctx: ProbeContext,
  next: string,
): Promise<
  | { readonly id: number; readonly form: string; readonly refusals: string }
  | { readonly failure: string }
> {
  const refusals: string[] = [];
  for (const form of TEMPLATE_FORMS) {
    const draft = await templateDraft(ctx, form.fields(next, "P0Y1M0W"));
    if (draft.id !== undefined) {
      data(ctx).mark("Invoice", draft.id, "recurring template (WKR): delete in the web app");
      return { id: draft.id, form: form.label, refusals: refusals.join("; ") };
    }
    refusals.push(`${form.label} ${outcomeOf(draft.result)}`);
  }
  return { failure: refusals.join("; ") };
}

function isTagged(row: Row): boolean {
  return [str(row, "header"), str(row, "customerInternalNote")].some((text) =>
    text.startsWith(RUN_TAG_PREFIX),
  );
}

async function listedIn(ctx: ProbeContext, query: Query | undefined, id: number): Promise<boolean> {
  return (await ctx.read.page("/Invoice", query, 1000)).rows.some(
    (row) => Number(row["id"]) === id,
  );
}

/** `saveInvoice` with a template's id and these header fields (positions untouched). */
async function saveTemplate(
  ctx: ProbeContext,
  id: number,
  fields: Readonly<Record<string, unknown>>,
): Promise<HttpResult> {
  return ctx.http.write("POST", "/Invoice/Factory/saveInvoice", {
    tier: "write",
    body: {
      invoice: { id, objectName: "Invoice", mapAll: true, ...fields },
      invoicePosSave: [],
      invoicePosDelete: null,
    },
  });
}

/**
 * Deactivates a template: `saveInvoice` with status 50, else `PUT /Invoice/{id}` with status 50.
 * Returns the route that set status 50 (or none) and a description.
 */
async function deactivateTemplate(
  ctx: ProbeContext,
  id: number,
): Promise<{ readonly route: string | undefined; readonly text: string }> {
  const saved = await saveTemplate(ctx, id, { status: "50" });
  const afterSave = await ctx.read.byId("Invoice", id);
  if (saved.ok && str(afterSave, "status") === "50") {
    return { route: "saveInvoice", text: `saveInvoice {status: 50} ok → status 50` };
  }
  const put = await ctx.http.write("PUT", `/Invoice/${id}`, {
    tier: "write",
    body: { status: 50 },
  });
  const afterPut = await ctx.read.byId("Invoice", id);
  const text =
    `saveInvoice {status: 50} ${outcomeOf(saved)} → status ${str(afterSave, "status")}; ` +
    `PUT /Invoice/{id} {status: 50} ${outcomeOf(put)} → status ${str(afterPut, "status")}`;
  return { route: str(afterPut, "status") === "50" ? "PUT" : undefined, text };
}

// ---------------------------------------------------------------------------------------------
// #94: layouts, text templates, discounts
// ---------------------------------------------------------------------------------------------

/** Where a DocServer answer keeps its rows: the spec's top-level key, under `objects`, or a list. */
function layoutRows(
  result: HttpResult,
  listKey: string,
): { readonly rows: Row[]; readonly where: string } {
  const json = result.json;
  const objects = isRecord(json) ? json["objects"] : undefined;
  const candidates: readonly (readonly [string, unknown])[] = [
    [`top-level ${listKey}`, isRecord(json) ? json[listKey] : undefined],
    [`objects.${listKey}`, isRecord(objects) ? objects[listKey] : undefined],
    ["objects as the list", objects],
  ];
  for (const [where, value] of candidates) {
    if (Array.isArray(value)) return { rows: value.filter(isRecord), where };
  }
  const keys = isRecord(json) ? Object.keys(json).join(", ") : typeof json;
  return { rows: [], where: `no list (top-level keys: ${keys || "none"})` };
}

function isDefaultLayout(row: Row): boolean {
  const value = row["default"];
  return value === 1 || value === "1" || value === true || value === "true";
}

function isStockLayout(row: Row): boolean {
  const value = row["sevClient"];
  return value === "0" || value === 0;
}

/** Keys and value types of rows; strings over 200 characters by name and length only. */
function keyTypes(rows: readonly Row[]): string {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return keys
    .map((key) => {
      const types = new Set<string>();
      let longest = 0;
      for (const row of rows) {
        const value = row[key];
        types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
        if (typeof value === "string") longest = Math.max(longest, value.length);
      }
      return `${key}: ${[...types].join("/")}${longest > 200 ? ` (up to ${longest} chars, not shown)` : ""}`;
    })
    .join(", ");
}

async function readLayouts(
  ctx: ProbeContext,
  path: string,
  listKey: string,
  type?: string,
): Promise<{ readonly rows: Row[]; readonly text: string }> {
  const result = await ctx.http.get(path, type === undefined ? undefined : { type });
  const label = `GET ${path}${type === undefined ? "" : `?type=${type}`}`;
  if (!result.ok) return { rows: [], text: `${label}: ${outcomeOf(result)}` };
  const { rows, where } = layoutRows(result, listKey);
  const defaults = rows.filter(isDefaultLayout).length;
  const stock = rows.filter(isStockLayout).length;
  return {
    rows,
    text:
      `${label}: ${result.contentType ?? "no content type"}, rows ${where}, ${rows.length} row(s) ` +
      `(${defaults} default, ${stock} with sevClient "0", ${rows.length - stock} other)` +
      (rows.length === 0 ? "" : `; keys: ${keyTypes(rows)}`),
  };
}

/** A letterpaper and per kind a template that are not the default (ids are sevDesk's own). */
async function layoutChoices(ctx: ProbeContext): Promise<{
  readonly letterpaper: string | undefined;
  readonly templates: Readonly<Partial<Record<DocumentKind, string>>>;
}> {
  const pick = (rows: readonly Row[]) => {
    const row = rows.find((item) => !isDefaultLayout(item) && str(item, "id") !== "");
    return row === undefined ? undefined : str(row, "id");
  };
  const letterpapers = await readLayouts(
    ctx,
    "/DocServer/getLetterpapersWithThumb",
    "letterpapers",
  );
  const templates: Partial<Record<DocumentKind, string>> = {};
  for (const kind of KINDS) {
    const list = await readLayouts(
      ctx,
      "/DocServer/getTemplatesWithThumb",
      "templates",
      TEMPLATE_TYPE[kind],
    );
    const id = pick(list.rows);
    if (id !== undefined) templates[kind] = id;
  }
  return { letterpaper: pick(letterpapers.rows), templates };
}

/** Fields of `after` that hold `value` (also one level down, e.g. `letterpaper.id`). */
function fieldsHolding(before: Row | undefined, after: Row | undefined, value: string): string[] {
  const found: string[] = [];
  const matches = (item: unknown) =>
    (typeof item === "string" || typeof item === "number") && String(item) === value;
  for (const [key, item] of Object.entries(after ?? {})) {
    if (matches(item)) {
      found.push(before?.[key] === item ? `${key} (already before)` : key);
    } else if (isRecord(item)) {
      for (const [inner, innerValue] of Object.entries(item)) {
        if (matches(innerValue)) found.push(`${key}.${inner}`);
      }
    }
  }
  return found;
}

/** The answer of a `changeParameter` call, without its PDF. */
function changeAnswer(result: HttpResult): string {
  if (result.ok) {
    const row = firstRow(result.objects);
    const pdf = row !== undefined && typeof row["pdf"] === "string";
    return `ok, answer ${shapeOf(result.objects)}${pdf ? " (pdf: a base64 PDF, not kept)" : ""}`;
  }
  if (result.kind === "unexpected_response" && result.status !== undefined && result.status < 300) {
    return `HTTP ${result.status} without the objects envelope (the client refuses such answers)`;
  }
  return outcomeOf(result);
}

function discountBody(tag: string, percentage: boolean): Record<string, unknown> {
  return {
    objectName: "Discounts",
    mapAll: true,
    discount: true,
    text: `${tag} discount`,
    percentage,
    value: 10,
  };
}

function describeDiscount(row: Row): string {
  return (
    `id ${str(row, "id")}: discount ${str(row, "discount")}, percentage ${str(row, "percentage")}, ` +
    `value ${str(row, "value")}, isNet ${str(row, "isNet") || "-"}, object ${refId(row, "object") ?? "-"}`
  );
}

/** Where a document's discounts can be read back, and their ids. */
async function discountReadBack(
  ctx: ProbeContext,
  kind: DocumentKind,
  id: number,
): Promise<{ readonly text: string; readonly ids: readonly number[] }> {
  const ids = new Set<number>();
  const collect = (rows: readonly Row[]) => {
    for (const row of rows) {
      const rowId = Number(row["id"]);
      if (Number.isSafeInteger(rowId) && rowId > 0) ids.add(rowId);
    }
  };
  const row = await ctx.read.byId(kind, id);
  const keys = Object.keys(row ?? {}).filter((key) => /discount/i.test(key));
  const raw = keys.map((key) => `${key} ${shown(ctx, key, row?.[key])}`).join(", ");
  const own = await ctx.http.get(`/${kind}/${id}/getDiscounts`, { limit: 100, offset: 0 });
  const ownRows = own.ok && Array.isArray(own.objects) ? own.objects.filter(isRecord) : [];
  collect(ownRows);
  const all = await ctx.read.page(
    "/Discounts",
    { "object[id]": id, "object[objectName]": kind },
    100,
  );
  const mine = all.rows.filter((item) => refId(item, "object") === id);
  collect(mine);
  return {
    ids: [...ids],
    text:
      `raw GET /${kind}/{id}: ${raw || "no discount keys"}; ` +
      `GET /${kind}/{id}/getDiscounts: ${own.ok ? `${ownRows.length} row(s)${ownRows.length === 0 ? "" : ` (${ownRows.map(describeDiscount).join("; ")})`}` : outcomeOf(own)}; ` +
      `GET /Discounts by object: ${all.result.ok ? `${all.rows.length} row(s), ${mine.length} of this ${kind}${mine.length === 0 ? "" : ` (${mine.map(describeDiscount).join("; ")})`}` : outcomeOf(all.result)}`,
  };
}

/** The discount rows in a save answer (`objects.discount`), if any. */
function answerDiscounts(objects: unknown): Row[] {
  if (!isRecord(objects)) return [];
  const value = objects["discount"];
  return value === undefined || value === null ? [] : rowsOf(value);
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export const GAPS_DOCUMENTS_PROBES: readonly ProbeDefinition[] = [
  // --- #89 orders ----------------------------------------------------------------------------
  {
    id: "write-order-contract-note-from-order",
    title: "Order confirmation (AB) from an offer (createContractNoteFromOrder)",
    mode: "write",
    question:
      "What does POST /Order/Factory/createContractNoteFromOrder (order[id] in the query and the order in the body) answer for a draft offer and for a sent one " +
      "(the probe marks that offer as sent with sendBy: an order is not enshrined): the new order's type, status, number (assigned? does the AB counter move, D-027), " +
      "its link to the offer (origin), and which positions, head and foot texts it takes over?",
    deviations: ["D-027", "D-064", "NEW"],
    run: (ctx) =>
      deriveFromOrders(ctx, "createContractNoteFromOrder", "AB", [
        { label: "From a draft offer (AN)", orderType: "AN", finalize: false },
        { label: "From a sent offer (AN)", orderType: "AN", finalize: true },
      ]),
  },
  {
    id: "write-order-packing-list-from-order",
    title: "Delivery note (LI) from an order (createPackingListFromOrder)",
    mode: "write",
    question:
      "What does POST /Order/Factory/createPackingListFromOrder answer for a sent offer, a draft order confirmation and a sent one " +
      "(the probe marks those as sent with sendBy: an order is not enshrined): the delivery note's type, status, number and the LI counter (D-027), " +
      "its origin, and which positions and texts it takes over?",
    deviations: ["D-027", "D-064", "NEW"],
    run: (ctx) =>
      deriveFromOrders(ctx, "createPackingListFromOrder", "LI", [
        { label: "From a sent offer (AN)", orderType: "AN", finalize: true },
        { label: "From a draft order confirmation (AB)", orderType: "AB", finalize: false },
        { label: "From a sent order confirmation (AB)", orderType: "AB", finalize: true },
      ]),
  },
  {
    id: "write-order-status-accept-reject",
    title: "Accepting (500) or rejecting (300) an offer with PUT /Order/{id}",
    mode: "write",
    question:
      "Does PUT /Order/{id} with only {status: 500} (accepted) or {status: 300} (rejected) change an offer's status, from a sent offer " +
      "(the probe marks offers as sent with sendBy: an order is not enshrined) and from a draft; what else changes, what does it answer, " +
      "can an accepted or rejected offer be set back to 200 (compare D-073: PUT /Voucher refuses a status)?",
    deviations: ["D-073", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      const cases = [
        { label: "sent offer → 500 (accepted), then back to 200", sent: true, steps: [500, 200] },
        { label: "sent offer → 300 (rejected), then back to 200", sent: true, steps: [300, 200] },
        { label: "draft offer → 500", sent: false, steps: [500] },
      ] as const;
      let changedOnce = false;
      for (const item of cases) {
        const offer = await orderDraft(ctx, "AN");
        if (offer.id === undefined) {
          lines.push(`${item.label}: the offer was refused (${outcomeOf(offer.result)})`);
          continue;
        }
        if (item.sent) {
          const finalized = await data(ctx).finalize("Order", offer.id);
          if (!finalized.ok) {
            lines.push(`${item.label}: sendBy ${outcomeOf(finalized)}`);
            continue;
          }
        }
        const steps: string[] = [];
        for (const status of item.steps) {
          const put = await putOrderStatus(ctx, offer.id, status);
          if (put.status === String(status)) changedOnce = true;
          steps.push(put.text);
        }
        data(ctx).mark("Order", offer.id, "offer, status set by PUT /Order (not enshrined)");
        lines.push(`${item.label} (order ${offer.id}): ${steps.join(" | ")}`);
      }
      if (lines.every((line) => line.includes("was refused"))) {
        return inconclusive(`${lines.join(". ")}.`);
      }
      return {
        verdict: "observed",
        finding: `${changedOnce ? "PUT /Order/{id} set a status." : "No PUT changed the status."} ${lines.join(". ")}.`,
      };
    },
  },

  // --- #90 drafts ----------------------------------------------------------------------------
  {
    id: "write-delete-draft-order-credit-note",
    title: "DELETE /Order/{id} and DELETE /CreditNote/{id} on drafts and non-drafts",
    mode: "write",
    question:
      "What do DELETE /Order/{id} and DELETE /CreditNote/{id} answer on a draft (with and without a number), is the draft gone afterwards, " +
      "what do they answer for a non-draft (an offer the probe marks as sent with sendBy, and a finalized credit note an earlier probe of this run left), " +
      "and does saving or deleting a draft saved with a peeked number move the next number (D-066, peeks only)?",
    deviations: ["D-024", "D-066", "D-074", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      // Offer draft with the peeked number.
      const offer = await orderDraft(ctx, "AN");
      if (offer.id === undefined) {
        lines.push(`Offer draft: refused (${outcomeOf(offer.result)})`);
      } else {
        const afterSave = await peekNumber(ctx, "AN");
        const deleted = await deleteAndCheck(ctx, "Order", offer.id);
        const afterDelete = await peekNumber(ctx, "AN");
        lines.push(
          `Offer draft ${offer.id} saved with the peeked number: after saving ${counterNote(ctx, "AN", offer.number, afterSave)}; ` +
            `${deleted.text}; after deleting ${counterNote(ctx, "AN", afterSave, afterDelete)}`,
        );
      }
      // Credit note draft with the peeked number, and one without a number.
      const peeked = await peekNumber(ctx, "CN");
      const numbered = await data(ctx).draft("CreditNote", {
        fields: peeked === undefined ? {} : { creditNoteNumber: peeked },
      });
      if (numbered.id === undefined) {
        lines.push(`Numbered credit note draft: refused (${outcomeOf(numbered.result)})`);
      } else {
        const afterSave = await peekNumber(ctx, "CN");
        const deleted = await deleteAndCheck(ctx, "CreditNote", numbered.id);
        const afterDelete = await peekNumber(ctx, "CN");
        lines.push(
          `Credit note draft ${numbered.id} saved with the peeked number: after saving ${counterNote(ctx, "CN", peeked, afterSave)}; ` +
            `${deleted.text}; after deleting ${counterNote(ctx, "CN", afterSave, afterDelete)}`,
        );
      }
      const plain = await data(ctx).draft("CreditNote");
      lines.push(
        plain.id === undefined
          ? `Credit note draft without a number: refused (${outcomeOf(plain.result)})`
          : `Credit note draft ${plain.id} without a number: ${(await deleteAndCheck(ctx, "CreditNote", plain.id)).text}`,
      );
      // Non-drafts.
      const sent = await orderDraft(ctx, "AN");
      if (sent.id !== undefined) {
        const finalized = await data(ctx).finalize("Order", sent.id);
        lines.push(
          finalized.ok
            ? `Sent offer ${sent.id}: ${(await deleteAndCheck(ctx, "Order", sent.id)).text}`
            : `Sent offer: sendBy ${outcomeOf(finalized)}`,
        );
      }
      const finalizedCreditNote = data(ctx).created.find(
        (record) => record.objectName === "CreditNote" && record.state.startsWith("finalized"),
      );
      lines.push(
        finalizedCreditNote === undefined
          ? "No finalized credit note of this run at hand (run the M3 write probes first)"
          : `Finalized credit note ${finalizedCreditNote.id} (probe ${finalizedCreditNote.probe}): ${(await deleteAndCheck(ctx, "CreditNote", finalizedCreditNote.id)).text}`,
      );
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-reserved-number-delete-draft",
    title: "Next number after deleting a draft saved with a reserved number (opt-in)",
    mode: "write",
    optIn: true,
    question:
      "OPT-IN, consumes one number of the trial's offer sequence and one of its credit note sequence: after reserving a number with " +
      "useNextNumber=true (as the draft tools do, D-066), saving an offer and a credit note draft with it and deleting the draft, which number comes next: " +
      "the reserved one again, or the one after it (a gap in the Nummernkreis)?",
    deviations: ["D-066", "D-027", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      for (const range of ["AN", "CN"] as const) {
        const { key } = rangeRequest(range);
        const reserved = await reserveNumber(ctx, range);
        if (reserved === undefined) {
          lines.push(`${range}: the reservation answered no number`);
          continue;
        }
        const afterReserve = await peekNumber(ctx, range);
        const draft =
          range === "AN"
            ? await orderDraft(ctx, "AN", {}, reserved)
            : await data(ctx).draft("CreditNote", { fields: { creditNoteNumber: reserved } });
        if (draft.id === undefined) {
          lines.push(
            `${range}: reserved ${shown(ctx, key, reserved)}, the draft was refused (${outcomeOf(draft.result)})`,
          );
          continue;
        }
        const afterSave = await peekNumber(ctx, range);
        const deleted = await deleteAndCheck(
          ctx,
          range === "AN" ? "Order" : "CreditNote",
          draft.id,
        );
        const afterDelete = await peekNumber(ctx, range);
        const verdict =
          afterDelete === reserved
            ? "sevDesk hands the reserved number out again"
            : afterDelete !== undefined && afterDelete === afterReserve
              ? "the reserved number stays used: a gap"
              : "the next number is neither the reserved one nor the one after the reservation";
        lines.push(
          `${range}: reserved ${shown(ctx, key, reserved)}; ${counterNote(ctx, range, reserved, afterReserve)} after reserving; ` +
            `draft ${draft.id} saved, ${counterNote(ctx, range, afterReserve, afterSave)} after saving; ${deleted.text}; ` +
            `after deleting the next is ${shown(ctx, key, afterDelete)}: ${verdict}`,
        );
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-credit-note-update-draft",
    title: "Updating a credit note draft through saveCreditNote with its id",
    mode: "write",
    question:
      "Does saveCreditNote with an existing draft's id update it in place: which fields does a header-only update keep or clear, " +
      "does creditNotePosDelete replace a position as an array and as the spec's single object, and does an update keep origin, refSrcInvoice, " +
      "type and number of a credit note made by createFromInvoice (which needs a finalized invoice: the probe finalizes one with sendBy, auto-enshrined on the trial)?",
    deviations: ["D-054", "D-053", "D-051", "D-064", "NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const lines: string[] = [];
      const draft = await data(ctx).draft("CreditNote", {
        positions: [{ price: 100 }, { price: 40 }],
        fields: { headText: `${tag} head`, footText: `${tag} foot` },
      });
      if (draft.id === undefined) {
        return inconclusive(`The credit note draft was refused: ${outcomeOf(draft.result)}.`);
      }
      const id = draft.id;
      const before = await ctx.read.byId("CreditNote", id);
      const header = await updateCreditNote(ctx, id, before);
      const afterHeader = await ctx.read.byId("CreditNote", id);
      const answerId = createdId(header.result.objects, "creditNote");
      lines.push(
        `Header update of draft ${id} (${header.form}): ${outcomeOf(header.result)}` +
          `${answerId === undefined ? "" : `, answer id ${answerId}${answerId === id ? " (same record)" : " (ANOTHER record)"}`}; ` +
          `changed: ${changedFields(safe(ctx, before), safe(ctx, afterHeader)) || "nothing"}`,
      );
      // Replace one position: creditNotePosDelete as an array.
      const old = await positionsOf(ctx, "CreditNote", id);
      const first = old[0];
      if (first !== undefined) {
        const replace = await updateCreditNote(ctx, id, afterHeader, {
          creditNotePosSave: [creditNotePosition(tag, 50)],
          creditNotePosDelete: [{ id: Number(first["id"]), objectName: "CreditNotePos" }],
        });
        const now = await positionsOf(ctx, "CreditNote", id);
        const row = await ctx.read.byId("CreditNote", id);
        lines.push(
          `Replace position ${str(first, "id")} (creditNotePosDelete as an array, ${replace.form}): ${outcomeOf(replace.result)}; ` +
            `now ${describePositions(now)}, old one ${now.some((item) => str(item, "id") === str(first, "id")) ? "still there" : "gone"}; ${sums(row)}`,
        );
      }
      // Delete one position: creditNotePosDelete as a single object (the spec's form).
      const second = old[1];
      if (second !== undefined) {
        const stored = await ctx.read.byId("CreditNote", id);
        const single = await updateCreditNote(ctx, id, stored, {
          creditNotePosDelete: { id: Number(second["id"]), objectName: "CreditNotePos" },
        });
        const now = await positionsOf(ctx, "CreditNote", id);
        lines.push(
          `Delete position ${str(second, "id")} (creditNotePosDelete as one object): ${outcomeOf(single.result)}; ` +
            `now ${describePositions(now)}, that one ${now.some((item) => str(item, "id") === str(second, "id")) ? "still there" : "gone"}`,
        );
      }
      // A credit note made from an invoice.
      const invoice = await data(ctx).draft("Invoice");
      const finalized =
        invoice.id === undefined ? undefined : await data(ctx).finalize("Invoice", invoice.id);
      if (invoice.id === undefined || finalized === undefined || !finalized.ok) {
        lines.push(
          `From-invoice case: could not prepare a finalized invoice (${outcomeOf(finalized ?? invoice.result)})`,
        );
      } else {
        const fromInvoice = await ctx.http.write("POST", "/CreditNote/Factory/createFromInvoice", {
          tier: "write",
          body: { invoice: { id: invoice.id, objectName: "Invoice" } },
        });
        const derived = createdId(fromInvoice.objects, "creditNote");
        if (!fromInvoice.ok || derived === undefined) {
          lines.push(`From-invoice case: createFromInvoice ${outcomeOf(fromInvoice)}`);
        } else {
          data(ctx).register("CreditNote", derived, "draft from an invoice (deletable)");
          const stored = await ctx.read.byId("CreditNote", derived);
          const update = await updateCreditNote(ctx, derived, stored);
          const after = await ctx.read.byId("CreditNote", derived);
          const kept = (["origin", "refSrcInvoice"] as const)
            .map((key) => `${key} ${refId(stored, key) ?? "-"} → ${refId(after, key) ?? "-"}`)
            .join(", ");
          lines.push(
            `Credit note ${derived} from invoice ${invoice.id} (${update.form}): ${outcomeOf(update.result)}; ${kept}, ` +
              `type ${str(stored, "creditNoteType")} → ${str(after, "creditNoteType")}, ${numberText(ctx, stored, "CreditNote")} → ${numberText(ctx, after, "CreditNote")}; ` +
              `changed: ${changedFields(safe(ctx, stored), safe(ctx, after)) || "nothing"}`,
          );
        }
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },

  // --- #91 recurring invoices ---------------------------------------------------------------
  {
    id: "write-recurring-template-create",
    title: "Creating a recurring invoice template (WKR) with saveInvoice",
    mode: "write",
    question:
      "Which fields make a recurring invoice template (saveInvoice with invoiceType WKR): the accountIntervall/accountNextInvoice pair the code reads (D-014), " +
      "or the recurringInterval/recurringStartDate/recurringNextVoucher fields issue #91 names? What does sevDesk store and return (type, status, number, schedule fields), " +
      "and does GET /Invoice list the template by default, with showWkr=all and with invoiceType=WKR (D-049)?",
    deviations: ["D-014", "D-049", "NEW"],
    async run(ctx) {
      const next = addDays(ctx.today, 30);
      const lines: string[] = [];
      let listedFor: number | undefined;
      for (const form of TEMPLATE_FORMS) {
        const draft = await templateDraft(ctx, form.fields(next, "P0Y1M0W"));
        if (draft.id === undefined) {
          lines.push(`${form.label}: ${outcomeOf(draft.result)}`);
          continue;
        }
        data(ctx).mark("Invoice", draft.id, "recurring template (WKR): delete in the web app");
        const row = await ctx.read.byId("Invoice", draft.id);
        lines.push(
          `${form.label}: saved as invoice ${draft.id}, answer ${shapeOf(draft.result.objects)}; type ${str(row, "invoiceType")}, ` +
            `status ${str(row, "status")}, ${numberText(ctx, row, "Invoice")}, sendDate ${str(row, "sendDate") || "-"}; ${schedule(ctx, row)}`,
        );
        listedFor ??= draft.id;
      }
      if (listedFor === undefined)
        return inconclusive(`No template was saved. ${lines.join(". ")}.`);
      const lists = [
        `default list ${await listedIn(ctx, undefined, listedFor)}`,
        `showWkr=all ${await listedIn(ctx, { showWkr: "all" }, listedFor)}`,
        `invoiceType=WKR ${await listedIn(ctx, { invoiceType: "WKR" }, listedFor)}`,
        `showAll=true ${await listedIn(ctx, { showAll: "true" }, listedFor)}`,
      ];
      return {
        verdict: "observed",
        finding: `Next run asked for: ${next}. ${lines.join(". ")}. Template ${listedFor} listed in: ${lists.join(", ")}.`,
        deviations: { "D-014": "informs", "D-049": "informs" },
      };
    },
  },
  {
    id: "write-recurring-interval-formats",
    title: "Interval formats of recurring invoice templates",
    mode: "write",
    question:
      "Which accountIntervall values does saveInvoice accept for a WKR template and how are they stored (P0Y1M0W, P1M, P0Y0M1W, P0Y3M, P1Y; " +
      "and the wrong forms '1 month' and 'monthly'), and does accountNextInvoice take dd.mm.yyyy as well as Unix seconds?",
    deviations: ["D-014", "NEW"],
    async run(ctx) {
      const next = addDays(ctx.today, 30);
      const variants: readonly { label: string; fields: Record<string, unknown> }[] = [
        ...["P0Y1M0W", "P1M", "P0Y0M1W", "P0Y3M", "P1Y", "1 month", "monthly"].map((interval) => ({
          label: `accountIntervall "${interval}"`,
          fields: { accountIntervall: interval, accountNextInvoice: berlinMidnight(next) },
        })),
        {
          label: "accountNextInvoice as dd.mm.yyyy",
          fields: { accountIntervall: "P0Y1M0W", accountNextInvoice: germanDate(next) },
        },
      ];
      const lines: string[] = [];
      let saved = 0;
      for (const variant of variants) {
        const draft = await templateDraft(ctx, variant.fields);
        if (draft.id === undefined) {
          lines.push(`${variant.label}: ${outcomeOf(draft.result)}`);
          continue;
        }
        saved += 1;
        data(ctx).mark("Invoice", draft.id, "recurring template (WKR): delete in the web app");
        const row = await ctx.read.byId("Invoice", draft.id);
        lines.push(
          `${variant.label}: saved (invoice ${draft.id}, type ${str(row, "invoiceType")}, status ${str(row, "status")}); ${schedule(ctx, row)}`,
        );
      }
      if (saved === 0) return inconclusive(`Every variant was refused. ${lines.join(". ")}.`);
      return {
        verdict: "observed",
        finding: `Next run asked for: ${next} (Unix ${berlinMidnight(next)}). ${lines.join(". ")}.`,
        deviations: { "D-014": "informs" },
      };
    },
  },
  {
    id: "write-recurring-template-update-end",
    title: "Changing, deactivating and deleting a recurring invoice template",
    mode: "write",
    question:
      "Does saveInvoice with a WKR template's id change its schedule (accountIntervall P0Y3M0W, a later accountNextInvoice) and header in place; " +
      "how is a template ended: saveInvoice with status 50 (Deactivated recurring invoice) or PUT /Invoice/{id}, can it be set back to 100, " +
      "and can a template be deleted (DELETE /Invoice/{id}) while active and while deactivated?",
    deviations: ["D-014", "D-024", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      const first = await createTemplate(ctx, addDays(ctx.today, 30));
      if ("failure" in first) return inconclusive(`No template could be saved: ${first.failure}.`);
      const id = first.id;
      const before = await ctx.read.byId("Invoice", id);
      const update = await saveTemplate(ctx, id, {
        invoiceType: "WKR",
        header: `${data(ctx).tag} Abo updated`,
        ...(first.form.startsWith("accountIntervall")
          ? {
              accountIntervall: "P0Y3M0W",
              accountNextInvoice: berlinMidnight(addDays(ctx.today, 60)),
            }
          : {
              recurringInterval: "P0Y3M0W",
              recurringNextVoucher: germanDate(addDays(ctx.today, 60)),
            }),
      });
      const afterUpdate = await ctx.read.byId("Invoice", id);
      lines.push(
        `Template ${id} (made with ${first.form}${first.refusals === "" ? "" : `; refused first: ${first.refusals}`}), status ${str(before, "status")}. ` +
          `Update with its id: ${outcomeOf(update)}, answer id ${createdId(update.objects, "invoice") ?? "-"}; ` +
          `changed: ${changedFields(safe(ctx, before), safe(ctx, afterUpdate)) || "nothing"}`,
      );
      const deactivated = await deactivateTemplate(ctx, id);
      lines.push(`Deactivate: ${deactivated.text}`);
      if (deactivated.route !== undefined) {
        const back =
          deactivated.route === "saveInvoice"
            ? await saveTemplate(ctx, id, { status: "100" })
            : await ctx.http.write("PUT", `/Invoice/${id}`, {
                tier: "write",
                body: { status: 100 },
              });
        const afterBack = await ctx.read.byId("Invoice", id);
        lines.push(
          `Back to 100 (${deactivated.route}): ${outcomeOf(back)} → status ${str(afterBack, "status")}; ${schedule(ctx, afterBack)}`,
        );
      }
      lines.push(
        `DELETE the template at status ${str(await ctx.read.byId("Invoice", id), "status")}: ${(await deleteAndCheck(ctx, "Invoice", id)).text}`,
      );
      const second = await createTemplate(ctx, addDays(ctx.today, 30));
      if ("failure" in second) {
        lines.push(`Second template: ${second.failure}`);
      } else {
        const off = await deactivateTemplate(ctx, second.id);
        const status = str(await ctx.read.byId("Invoice", second.id), "status");
        lines.push(
          `Second template ${second.id}: ${off.text}; DELETE at status ${status}: ${(await deleteAndCheck(ctx, "Invoice", second.id)).text}`,
        );
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-recurring-template-due",
    title: "A recurring template whose next run is due (opt-in, stays active)",
    mode: "write",
    optIn: true,
    question:
      "OPT-IN, leaves an ACTIVE recurring template on the trial for a day: a WKR template (monthly) whose next run is yesterday, or today if a past date is refused, " +
      "for the tagged contact, which has no e-mail address, so nothing can be e-mailed. What does sevDesk store, and does it generate an invoice at once? " +
      "Run read-recurring-generated the next day to see what sevDesk generated (a draft or a finalized invoice; sent or not).",
    deviations: ["D-014", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      let made: { id: number; form: string; next: string } | undefined;
      for (const next of [addDays(ctx.today, -1), ctx.today]) {
        const template = await createTemplate(ctx, next);
        if ("failure" in template) {
          lines.push(`Next run ${next}: ${template.failure}`);
          continue;
        }
        made = { id: template.id, form: template.form, next };
        break;
      }
      if (made === undefined)
        return inconclusive(`No template could be saved. ${lines.join(". ")}.`);
      data(ctx).mark(
        "Invoice",
        made.id,
        "ACTIVE recurring template (WKR): deactivate or delete in the web app after read-recurring-generated",
      );
      const row = await ctx.read.byId("Invoice", made.id);
      const generated = (
        await ctx.read.page(
          "/Invoice",
          { showAll: "true", "origin[id]": made.id, "origin[objectName]": "Invoice" },
          1000,
        )
      ).rows.filter((item) => refId(item, "origin") === made.id);
      return {
        verdict: "observed",
        finding:
          `${lines.length === 0 ? "" : `${lines.join(". ")}. `}Template ${made.id} (${made.form}, next run asked for ${made.next}): ` +
          `type ${str(row, "invoiceType")}, status ${str(row, "status")}; ${schedule(ctx, row)}. ` +
          `Invoices with this template as origin right after saving: ${generated.length}. Run read-recurring-generated tomorrow.`,
      };
    },
  },

  // --- #94 documents ------------------------------------------------------------------------
  {
    id: "write-change-parameter-draft",
    title: "changeParameter (language, letterpaper, template) on drafts",
    mode: "write",
    question:
      "What does PUT /{Invoice,Order,CreditNote}/{id}/changeParameter answer on a DRAFT for language, letterpaper and template (one key per request; " +
      "letterpaper and template ids from the DocServer lists, not the default), does anything else on the record change (status, sendDate, sendType, number), " +
      "and in which fields can the chosen values be read back? (The answer's base64 PDF is never kept.)",
    deviations: ["D-025", "D-023", "NEW"],
    async run(ctx) {
      const choices = await layoutChoices(ctx);
      const lines: string[] = [];
      let changedState = false;
      let sent = 0;
      for (const kind of KINDS) {
        const draft = await documentDraft(ctx, kind);
        if (draft.id === undefined) {
          lines.push(`${kind}: draft refused (${outcomeOf(draft.result)})`);
          continue;
        }
        const id = draft.id;
        const values: readonly (readonly [string, readonly string[]])[] = [
          ["language", LANGUAGES],
          ["letterpaper", choices.letterpaper === undefined ? [] : [choices.letterpaper]],
          ["template", choices.templates[kind] === undefined ? [] : [choices.templates[kind]]],
        ];
        const steps: string[] = [];
        for (const [key, candidates] of values) {
          if (candidates.length === 0) {
            steps.push(`${key}: no non-default value in the DocServer list`);
            continue;
          }
          const tries: string[] = [];
          for (const value of candidates) {
            const before = await stateOf(ctx, kind, id);
            const result = await ctx.http.write("PUT", `/${kind}/${id}/changeParameter`, {
              tier: "commit",
              body: { key, value },
            });
            sent += 1;
            const after = await stateOf(ctx, kind, id);
            const stateDiff = diffState(before.state, after.state);
            if (stateDiff !== "") {
              changedState = true;
              data(ctx).mark(kind, id, `changed by changeParameter (${stateDiff})`);
            }
            const holding = fieldsHolding(before.row, after.row, value);
            const accepted =
              result.ok ||
              (result.kind === "unexpected_response" &&
                result.status !== undefined &&
                result.status < 300);
            tries.push(
              `${key} ${key === "language" ? `"${value}"` : "(a non-default id)"}: ${changeAnswer(result)}; ` +
                `${stateDiff === "" ? "status, sendDate, sendType and number unchanged" : `STATE CHANGED: ${stateDiff}`}; ` +
                `other changes: ${changedFields(safe(ctx, before.row), safe(ctx, after.row), ["status", "sendDate", "sendType", NUMBER_KEY[kind]]) || "none"}; ` +
                `value read back in: ${holding.join(", ") || "no field"}`,
            );
            if (accepted) break;
          }
          steps.push(tries.join(" / "));
        }
        lines.push(`${kind} draft ${id}: ${steps.join(" | ")}`);
      }
      if (sent === 0) return inconclusive(`Nothing was sent. ${lines.join(". ")}.`);
      return {
        verdict: changedState ? "contradicted" : "observed",
        finding: `${changedState ? "changeParameter CHANGED the send state of a draft." : "No draft left the draft state."} ${lines.join(". ")}.`,
        deviations: { "D-025": "informs", "D-023": changedState ? "contradicts" : "informs" },
      };
    },
  },
  {
    id: "write-text-template-create-delete",
    title: "Creating and deleting a text template (/TextTemplate)",
    mode: "write",
    question:
      "Does POST /TextTemplate (undocumented, D-024) create a head text template from {name, text, category DOCUMENT, objectType RE, textType HEAD}, " +
      "what does it answer and read back (keys, codes, main), does the textType filter list it, and does DELETE /TextTemplate/{id} remove it?",
    deviations: ["D-024", "NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const created = await ctx.http.write("POST", "/TextTemplate", {
        tier: "write",
        body: {
          objectName: "TextTemplate",
          mapAll: true,
          name: `${tag} text`,
          text: `${tag} head text`,
          category: "DOCUMENT",
          objectType: "RE",
          textType: "HEAD",
        },
      });
      const id = createdId(created.objects);
      if (!created.ok || id === undefined) {
        return {
          verdict: "observed",
          finding: `POST /TextTemplate ${answerOf(created)}.`,
        };
      }
      data(ctx).register("TextTemplate", id, "active (can be deleted in the web app)");
      const row = await ctx.read.byId("TextTemplate", id);
      const codes = ["category", "objectType", "textType", "main"]
        .map((key) => `${key} ${shown(ctx, key, row?.[key])}`)
        .join(", ");
      const listed = (await ctx.read.page("/TextTemplate", { textType: "HEAD" }, 1000)).rows.some(
        (item) => Number(item["id"]) === id,
      );
      const deleted = await deleteAndCheck(ctx, "TextTemplate", id);
      return {
        verdict: "observed",
        finding:
          `POST /TextTemplate ok, answer ${shapeOf(created.objects)}; template ${id} reads back with keys ${Object.keys(row ?? {}).join(", ") || "(none)"}; ` +
          `${codes}; name ${str(row, "name") === `${tag} text` ? "as sent" : "different"}, text ${str(row, "text") === `${tag} head text` ? "as sent" : "different"}; ` +
          `listed with textType=HEAD: ${listed}. ${deleted.text}.`,
      };
    },
  },
  {
    id: "write-document-discount",
    title: "A discount on the whole document (discountSave, discountDelete)",
    mode: "write",
    question:
      "How does a document-level discount work: discountSave (as a list, else as the spec's single object) with 10 % and with a fixed 10.00 on saveInvoice, saveOrder " +
      "and saveCreditNote (one position of 100.00 net at 19 %); how do sevDesk's sums change; where can the discount be read back (the raw GET /<kind>/{id}, " +
      "GET /<kind>/{id}/getDiscounts, GET /Discounts by object); and does discountDelete with the document's id remove it?",
    deviations: ["D-053", "NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const lines: string[] = [];
      let saved = 0;
      for (const kind of KINDS) {
        for (const percentage of [true, false]) {
          const label = `${kind}, ${percentage ? "10 %" : "fixed 10.00"}`;
          const discount = discountBody(tag, percentage);
          let form = "as a list";
          let draft = await documentDraft(ctx, kind, {
            body: { discountSave: [discount], discountDelete: null },
          });
          if (draft.id === undefined) {
            const listRefusal = outcomeOf(draft.result);
            form = `as one object (the list was ${listRefusal})`;
            draft = await documentDraft(ctx, kind, {
              body: { discountSave: discount, discountDelete: null },
            });
          }
          if (draft.id === undefined) {
            lines.push(`${label}: ${form}: ${outcomeOf(draft.result)}`);
            continue;
          }
          saved += 1;
          const id = draft.id;
          const row = await ctx.read.byId(kind, id);
          const readBack = await discountReadBack(ctx, kind, id);
          const inAnswer = answerDiscounts(draft.result.objects);
          let deletion = "";
          const discountIds = [
            ...new Set([...readBack.ids, ...inAnswer.map((item) => Number(item["id"]))]),
          ].filter((item) => Number.isSafeInteger(item) && item > 0);
          if (percentage && discountIds.length > 0) {
            const result = await ctx.http.write("POST", `/${kind}/Factory/save${kind}`, {
              tier: "write",
              body: {
                [BODY_KEY[kind]]: { id, objectName: kind, mapAll: true },
                [`${BODY_KEY[kind]}PosSave`]: [],
                [`${BODY_KEY[kind]}PosDelete`]: null,
                discountSave: null,
                discountDelete: discountIds.map((item) => ({ id: item, objectName: "Discounts" })),
              },
            });
            const after = await ctx.read.byId(kind, id);
            const left = await discountReadBack(ctx, kind, id);
            deletion = ` discountDelete: ${outcomeOf(result)}; then ${sums(after)}; discounts left: ${left.ids.length}`;
          }
          lines.push(
            `${label} (${form}, ${kind.toLowerCase()} ${id}): answer ${shapeOf(draft.result.objects)}` +
              `${inAnswer.length === 0 ? "" : ` with ${inAnswer.length} discount row(s)`}; ${sums(row)}; ${readBack.text}.${deletion}`,
          );
        }
      }
      if (saved === 0)
        return inconclusive(`No document with a discount was saved. ${lines.join(". ")}.`);
      return { verdict: "observed", finding: lines.join(" ") };
    },
  },
  {
    id: "read-order-get-discounts",
    title: "GET /Order/{id}/getDiscounts",
    mode: "read",
    question:
      "What does GET /Order/{id}/getDiscounts answer (envelope, row keys and types, isNet, the object reference)? Asks up to 10 orders, tagged ones first, " +
      "and describes the first answer with discounts (write-document-discount leaves tagged orders with one).",
    deviations: ["NEW"],
    async run(ctx) {
      const orders = (await ctx.read.page("/Order", undefined, 100)).rows;
      const candidates = [...orders.filter(isTagged), ...orders.filter((row) => !isTagged(row))]
        .map((row) => Number(row["id"]))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .slice(0, 10);
      if (candidates.length === 0) return inconclusive("The account has no order.");
      const empty: string[] = [];
      for (const id of candidates) {
        const result = await ctx.http.get(`/Order/${id}/getDiscounts`, { limit: 100, offset: 0 });
        if (!result.ok)
          return { verdict: "observed", finding: `Order ${id}: ${outcomeOf(result)}.` };
        const rows = Array.isArray(result.objects) ? result.objects.filter(isRecord) : [];
        if (rows.length === 0) {
          empty.push(`${id} (${shapeOf(result.objects)})`);
          continue;
        }
        return {
          verdict: "observed",
          finding:
            `Order ${id}: objects is ${shapeOf(result.objects)}; keys: ${keyTypes(rows)}; ${rows.map(describeDiscount).join("; ")}. ` +
            `Orders without discounts asked before: ${empty.length}.`,
        };
      }
      return inconclusive(`No order of ${candidates.length} has a discount: ${empty.join(", ")}.`);
    },
  },
  {
    id: "read-docserver-layouts",
    title: "Letterpapers and templates (DocServer), without thumbnails",
    mode: "read",
    question:
      "What do GET /DocServer/getLetterpapersWithThumb and getTemplatesWithThumb (without a type, and with type Invoice, Order, Creditnote) answer: where the rows are, " +
      'their keys and types, how many, which is the default, stock (sevClient "0") or own? Base64 fields are named with their length only; the run\'s scrubber replaces them in the evidence.',
    deviations: ["D-024", "D-025", "NEW"],
    async run(ctx) {
      const results = [
        await readLayouts(ctx, "/DocServer/getLetterpapersWithThumb", "letterpapers"),
        await readLayouts(ctx, "/DocServer/getTemplatesWithThumb", "templates"),
      ];
      for (const kind of KINDS) {
        results.push(
          await readLayouts(
            ctx,
            "/DocServer/getTemplatesWithThumb",
            "templates",
            TEMPLATE_TYPE[kind],
          ),
        );
      }
      const rows = results.reduce((total, item) => total + item.rows.length, 0);
      const finding = `${results.map((item) => item.text).join(". ")}.`;
      return rows === 0 ? inconclusive(finding) : { verdict: "observed", finding };
    },
  },
  {
    id: "read-recurring-generated",
    title: "Invoices sevDesk generated from the tagged recurring templates",
    mode: "read",
    question:
      "Which invoices did sevDesk generate from the tagged recurring templates (WKR, run tag) so far: type, status, number, sendDate/sendType and origin; " +
      "what do the templates' schedule fields read now; and do the templates show up in the default invoice list? Run it again the day after write-recurring-template-due.",
    deviations: ["D-049", "D-014", "NEW"],
    async run(ctx) {
      const templates = (await ctx.read.page("/Invoice", { showWkr: "all" }, 1000)).rows.filter(
        (row) => str(row, "invoiceType") === "WKR" && isTagged(row),
      );
      if (templates.length === 0) {
        return inconclusive("No tagged recurring template (WKR) on the account.");
      }
      const defaultIds = new Set(
        (await ctx.read.page("/Invoice", undefined, 1000)).rows.map((row) => str(row, "id")),
      );
      const all = (await ctx.read.page("/Invoice", { showAll: "true" }, 1000)).rows;
      const lines: string[] = [];
      let generatedTotal = 0;
      for (const template of templates.slice(0, 10)) {
        const id = Number(template["id"]);
        const byOrigin = (
          await ctx.read.page(
            "/Invoice",
            { showAll: "true", "origin[id]": id, "origin[objectName]": "Invoice" },
            1000,
          )
        ).rows.filter((row) => refId(row, "origin") === id);
        const byHeader = all.filter(
          (row) =>
            str(row, "invoiceType") !== "WKR" &&
            str(row, "header") !== "" &&
            str(row, "header") === str(template, "header") &&
            !byOrigin.some((item) => str(item, "id") === str(row, "id")),
        );
        generatedTotal += byOrigin.length + byHeader.length;
        const describe = (row: Row) =>
          `${str(row, "id")}: type ${str(row, "invoiceType")}, status ${str(row, "status")}, ${numberText(ctx, row, "Invoice")}, ` +
          `invoiceDate ${str(row, "invoiceDate").slice(0, 10) || "-"}, created ${str(row, "create").slice(0, 16) || "-"}, ` +
          `sendDate ${str(row, "sendDate") || "-"}, sendType ${str(row, "sendType") || "-"}, origin ${refId(row, "origin") ?? (str(row, "origin") || "-")}`;
        lines.push(
          `Template ${id} (status ${str(template, "status")}, in the default list: ${defaultIds.has(str(template, "id"))}; ${schedule(ctx, template)}): ` +
            `generated with this origin: ${byOrigin.length === 0 ? "none" : byOrigin.map(describe).join("; ")}; ` +
            `same header, no origin link: ${byHeader.length === 0 ? "none" : byHeader.map(describe).join("; ")}`,
        );
      }
      return {
        verdict: "observed",
        finding: `${templates.length} tagged template(s), ${generatedTotal} generated invoice(s) found. ${lines.join(". ")}.`,
        deviations: { "D-049": "informs", "D-014": "informs" },
      };
    },
  },
];
