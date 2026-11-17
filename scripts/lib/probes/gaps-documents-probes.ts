/**
 * Probes for the competitor-gap issues on documents: orders (#89: order confirmations and delivery
 * notes from an order, accepting or rejecting an offer, order discounts), drafts (#90: deleting
 * order and credit note drafts, updating credit note drafts), recurring invoice templates (#91) and
 * the layout of documents (#94: language, letterpaper and template, text templates, a discount on
 * the whole document).
 *
 * Like every write probe they run only with `--allow-writes` on a trial account and create their
 * own tagged data through `createTestData` (contact, drafts, headers and notes carry the run tag),
 * which lands in the cleanup list. Nothing is e-mailed, and no probe calls an enshrine endpoint.
 * Documents are finalized (`sendBy`, which marks them as sent) only where a question needs a sent
 * document, and the probe's question says so: offers and order confirmations, which are not
 * enshrined, and the one invoice of `write-credit-note-update-draft`, which the trial account
 * enshrines when it is finalized (D-023, D-059). Recurring templates (WKR) stay on the account
 * unless a probe deletes them; a template at status 200 is ended (status 50) before its DELETE,
 * which sevDesk refuses at 200 (D-112). Findings report codes, amounts, ids, key names and
 * scrubbed values; base64 bodies (the PDF of a `changeParameter` answer, the DocServer thumbnails)
 * never reach a finding, and the run's scrubber replaces them in the evidence.
 *
 * Orders need a number: `saveOrder` without `orderNumber` is refused (D-027). The probes save
 * orders with the number `getNextOrderNumber` peeks (`useNextNumber=false`, reserves nothing).
 * Only the opt-in probe `write-reserved-number-delete-draft` reserves numbers, as the draft tools
 * do (D-066). sevDesk handed a reserved number out again once its draft was deleted (recorded
 * 2026-11-16, D-066); a run that stops between the reservation and the delete leaves a gap in
 * the trial's sequence.
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
 * calls it: the number is given back only when the draft saved with it is deleted (D-066).
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
      // A confirmation accepts the source offer (D-107), so the client requires commit for it.
      tier: factory === "createContractNoteFromOrder" ? "commit" : "write",
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

/**
 * `PUT /Order/{id}` with only a status (commit: it accepts or rejects an offer); the answer and
 * what changed.
 */
async function putOrderStatus(
  ctx: ProbeContext,
  id: number,
  status: number,
): Promise<{ readonly text: string; readonly status: string }> {
  const before = await ctx.read.byId("Order", id);
  const result = await ctx.http.write("PUT", `/Order/${id}`, { tier: "commit", body: { status } });
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

/** Keys of a template row that describe its schedule (`account…` and `recurring…`). */
const SCHEDULE_KEY = /^(?:account|recurring)/i;

/** Schedule date keys whose stored value makes a template due on a date. */
const DUE_KEYS: readonly string[] = ["accountNextInvoice", "accountStartDate"];
const DATE_KEYS: readonly string[] = [...DUE_KEYS, "accountEndDate", "accountLastInvoice"];

/** `date` (YYYY-MM-DD) at 00:00 Berlin as an ISO date-time in UTC. */
function isoMidnight(date: string): string {
  return new Date(berlinMidnight(date) * 1000).toISOString();
}

/**
 * One way to give a template a schedule: header fields on create, then optionally an update with
 * the template's id (through `saveInvoice` or `PUT /Invoice/{id}`). `next` is the run date.
 */
interface ScheduleVariant {
  readonly label: string;
  readonly create: (next: string) => Record<string, unknown>;
  readonly update?: {
    readonly via: "saveInvoice" | "PUT";
    readonly fields: (next: string) => Record<string, unknown>;
  };
}

const SCHEDULE_VARIANTS: readonly ScheduleVariant[] = [
  {
    label: "accountStartDate as Unix seconds",
    create: (next) => ({ accountStartDate: berlinMidnight(next) }),
  },
  { label: "accountStartDate as ISO", create: (next) => ({ accountStartDate: isoMidnight(next) }) },
  {
    label: "accountStartDate as dd.mm.yyyy",
    create: (next) => ({ accountStartDate: germanDate(next) }),
  },
  {
    label: "accountNextInvoice as ISO",
    create: (next) => ({ accountNextInvoice: isoMidnight(next) }),
  },
  {
    label: "accountStartDate + accountNextInvoice (Unix seconds)",
    create: (next) => ({
      accountStartDate: berlinMidnight(next),
      accountNextInvoice: berlinMidnight(next),
    }),
  },
  {
    label: "accountEndDate as Unix seconds (end in a year)",
    create: (next) => ({ accountEndDate: berlinMidnight(addDays(next, 365)) }),
  },
  {
    label: "accountEndDate as ISO",
    create: (next) => ({ accountEndDate: isoMidnight(addDays(next, 365)) }),
  },
  {
    label: "accountEndDate as dd.mm.yyyy",
    create: (next) => ({ accountEndDate: germanDate(addDays(next, 365)) }),
  },
  {
    label: "invoiceDate on the run date (no schedule date)",
    create: (next) => ({ invoiceDate: germanDate(next) }),
  },
  {
    label: "update with the id: accountStartDate + accountNextInvoice (Unix seconds)",
    create: () => ({}),
    update: {
      via: "saveInvoice",
      fields: (next) => ({
        accountStartDate: berlinMidnight(next),
        accountNextInvoice: berlinMidnight(next),
      }),
    },
  },
  {
    label: "PUT /Invoice/{id}: accountStartDate + accountNextInvoice (Unix seconds)",
    create: () => ({}),
    update: {
      via: "PUT",
      fields: (next) => ({
        accountStartDate: berlinMidnight(next),
        accountNextInvoice: berlinMidnight(next),
      }),
    },
  },
  {
    label: "update with the id: status 200 (starting the subscription?)",
    create: (next) => ({
      accountStartDate: berlinMidnight(next),
      accountNextInvoice: berlinMidnight(next),
    }),
    update: { via: "saveInvoice", fields: () => ({ status: "200" }) },
  },
];

/** The schedule date keys a template row holds a value in. */
function storedDates(row: Row | undefined): string[] {
  return DATE_KEYS.filter((key) => str(row, key) !== "");
}

/**
 * Creates a monthly template with a variant's fields (and its update), then reads it back. The
 * template is registered for cleanup; the caller decides whether to keep it.
 */
async function scheduledTemplate(
  ctx: ProbeContext,
  variant: ScheduleVariant,
  next: string,
): Promise<{
  readonly id: number | undefined;
  readonly row: Row | undefined;
  readonly text: string;
}> {
  const draft = await templateDraft(ctx, {
    accountIntervall: "P0Y1M0W",
    ...variant.create(next),
  });
  if (draft.id === undefined) {
    return { id: undefined, row: undefined, text: `create ${outcomeOf(draft.result)}` };
  }
  const id = draft.id;
  data(ctx).mark("Invoice", id, "recurring template (WKR): delete in the web app");
  let update = "";
  if (variant.update !== undefined) {
    const fields = variant.update.fields(next);
    const result =
      variant.update.via === "PUT"
        ? await ctx.http.write("PUT", `/Invoice/${id}`, { tier: "commit", body: fields })
        : await saveTemplate(ctx, id, fields);
    update = `, update ${outcomeOf(result)}`;
  }
  const row = await ctx.read.byId("Invoice", id);
  return {
    id,
    row,
    text:
      `template ${id}${update}: status ${str(row, "status")}, invoiceDate ${str(row, "invoiceDate").slice(0, 10) || "-"}; ` +
      `${schedule(ctx, row)}; stored dates: ${storedDates(row).join(", ") || "none"}`,
  };
}

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

/**
 * `saveInvoice` with a template's id and these header fields (positions untouched). Commit: a
 * template change, and without `invoiceType` the client cannot tell it from one either.
 */
async function saveTemplate(
  ctx: ProbeContext,
  id: number,
  fields: Readonly<Record<string, unknown>>,
): Promise<HttpResult> {
  return ctx.http.write("POST", "/Invoice/Factory/saveInvoice", {
    tier: "commit",
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
    tier: "commit",
    body: { status: 50 },
  });
  const afterPut = await ctx.read.byId("Invoice", id);
  const text =
    `saveInvoice {status: 50} ${outcomeOf(saved)} → status ${str(afterSave, "status")}; ` +
    `PUT /Invoice/{id} {status: 50} ${outcomeOf(put)} → status ${str(afterPut, "status")}`;
  return { route: str(afterPut, "status") === "50" ? "PUT" : undefined, text };
}

/**
 * Deletes a template the probe made. The first DELETE is part of what a probe observes; when it
 * leaves the template (sevDesk refuses one at status 200 with 409, D-112), the template is ended
 * with status 50 and deleted again, so no active, scheduled template stays behind. One that still
 * stays is marked in the cleanup list with its status. `refused` says the first DELETE left it.
 */
async function deleteTemplate(
  ctx: ProbeContext,
  id: number,
): Promise<{ readonly gone: boolean; readonly refused: boolean; readonly text: string }> {
  const first = await deleteAndCheck(ctx, "Invoice", id);
  if (first.gone) return { gone: true, refused: false, text: first.text };
  const ended = await deactivateTemplate(ctx, id);
  const again = ended.route === undefined ? undefined : await deleteAndCheck(ctx, "Invoice", id);
  if (again?.gone !== true) {
    const status = str(await ctx.read.byId("Invoice", id), "status");
    data(ctx).mark(
      "Invoice",
      id,
      status === "50"
        ? "recurring template (WKR), ended (status 50): delete in the web app"
        : `ACTIVE recurring template (WKR, status ${status || "?"}): end and delete it in the web app`,
    );
  }
  return {
    gone: again?.gone === true,
    refused: true,
    text:
      `${first.text}; cleanup: ${ended.text}` +
      (again === undefined ? "" : `; DELETE again: ${again.gone ? "gone" : again.text}`),
  };
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

/**
 * The `parameters` of a layout answer: under `metaData` (recorded for `changeParameter`),
 * `metadaten` (the spec) or at the top (the spec's `render` answer).
 */
function layoutParameters(objects: unknown): Row[] {
  const root = firstRow(objects);
  const meta = root?.["metaData"] ?? root?.["metadaten"] ?? root;
  const parameters = isRecord(meta) ? meta["parameters"] : undefined;
  return Array.isArray(parameters) ? parameters.filter(isRecord) : [];
}

/** The keys of a layout answer and of its `metaData`, for the finding. */
function layoutAnswerKeys(objects: unknown): string {
  const root = firstRow(objects);
  const meta = root?.["metaData"];
  return `${Object.keys(root ?? {}).join(", ") || "(none)"}${isRecord(meta) ? `; metaData: ${Object.keys(meta).join(", ")}` : ""}`;
}

/** A sevDesk code that may be shown as is (parameter keys, language codes). */
function codeText(value: string): string {
  return /^[A-Za-z][A-Za-z_-]{0,30}$/.test(value) ? value : "(not a plain code)";
}

/**
 * Each parameter of a layout answer: its key, whether its current `value` is the one the probe
 * set last (`sent`), how many choices it offers and whether it is visible. Language values are
 * shown (codes); letterpaper and template ids only as "= the one sent" or "another".
 */
function describeParameters(objects: unknown, sent: Readonly<Record<string, string>>): string {
  const parameters = layoutParameters(objects);
  if (parameters.length === 0) return "no parameters";
  return parameters
    .map((parameter) => {
      const key = str(parameter, "key");
      const value = str(parameter, "value");
      const expected = sent[key];
      const choices = Array.isArray(parameter["values"]) ? parameter["values"].length : 0;
      const shownValue =
        value === ""
          ? "no value"
          : expected !== undefined && value === expected
            ? "= the one sent"
            : key === "language"
              ? codeText(value)
              : expected === undefined
                ? "a value"
                : "ANOTHER value";
      return `${codeText(key)}: ${shownValue}, ${choices} choice(s), visible ${str(parameter, "visible") || "-"}`;
    })
    .join("; ");
}

/** `PUT /<path>/<id>/changeParameter` with one key (commit tier, as `src/sevdesk/paths.ts` wants). */
async function changeParameter(
  ctx: ProbeContext,
  pathKind: string,
  id: number,
  key: string,
  value: string,
): Promise<HttpResult> {
  return ctx.http.write("PUT", `/${pathKind}/${id}/changeParameter`, {
    tier: "commit",
    body: { key, value },
  });
}

/** Where in `row` the values the probe set can be found (`key in field`). */
function chosenValuesIn(row: Row | undefined, sent: Readonly<Record<string, string>>): string {
  const found = Object.entries(sent).flatMap(([key, value]) =>
    fieldsHolding(undefined, row, value).map((field) => `${key} in ${field}`),
  );
  return found.join(", ") || "no field";
}

/**
 * Sets each choice on an invoice draft, repeats the language call without a change, and looks
 * for the chosen values in the answers and in every read that might carry them. Ends with the
 * draft's send state, which must not have changed.
 */
async function invoiceLayoutReadBack(
  ctx: ProbeContext,
  id: number,
  choices: readonly (readonly [string, string])[],
): Promise<string> {
  const sent: Record<string, string> = {};
  const steps: string[] = [];
  const before = await stateOf(ctx, "Invoice", id);
  for (const [key, value] of choices) {
    if (value === "") {
      steps.push(`${key}: no id in the DocServer list`);
      continue;
    }
    const result = await changeParameter(ctx, "Invoice", id, key, value);
    if (result.ok) sent[key] = value;
    steps.push(
      `${key}: ${changeAnswer(result)}; answer keys ${layoutAnswerKeys(result.objects)}; parameters: ${describeParameters(result.objects, sent)}`,
    );
  }
  const again = await changeParameter(ctx, "Invoice", id, "language", "en_US");
  steps.push(
    `language again (no change): ${changeAnswer(again)}; parameters: ${describeParameters(again.objects, sent)}`,
  );
  const plain = await ctx.read.byId("Invoice", id);
  for (const embed of ["document", "letterpaper", "template", "language"]) {
    const result = await ctx.http.get(`/Invoice/${id}`, { embed });
    const row = firstRow(result.objects);
    const extra = Object.keys(row ?? {}).filter((key) => !Object.hasOwn(plain ?? {}, key));
    steps.push(
      `GET /Invoice/{id}?embed=${embed}: ` +
        (result.ok
          ? `extra keys ${extra.join(", ") || "none"}; chosen values in: ${chosenValuesIn(row, sent)}`
          : outcomeOf(result)),
    );
  }
  const pdf = await ctx.http.get(`/Invoice/${id}/getPdf`, { preventSendBy: "true" });
  const pdfRow = firstRow(pdf.objects);
  steps.push(
    `getPdf (preventSendBy=true): ` +
      (pdf.ok
        ? `keys ${Object.keys(pdfRow ?? {}).join(", ") || "(none)"}; chosen values in: ${chosenValuesIn(pdfRow, sent)}`
        : outcomeOf(pdf)),
  );
  const render = await ctx.http.write("POST", `/Invoice/${id}/render`, {
    tier: "write",
    body: { forceReload: false },
  });
  steps.push(
    `POST /Invoice/{id}/render {forceReload: false}: ` +
      (render.ok
        ? `answer keys ${layoutAnswerKeys(render.objects)}; parameters: ${describeParameters(render.objects, sent)}`
        : outcomeOf(render)),
  );
  const after = await stateOf(ctx, "Invoice", id);
  const diff = diffState(before.state, after.state);
  if (diff !== "") data(ctx).mark("Invoice", id, `changed by the layout probe (${diff})`);
  steps.push(
    diff === ""
      ? "status, sendDate, sendType and number unchanged after all of it"
      : `STATE CHANGED: ${diff}`,
  );
  return `Invoice draft ${id}: ${steps.join(" | ")}`;
}

/**
 * Tries `changeParameter` (language en_US) on an order or credit note draft in several forms
 * until one is accepted, then repeats it without a change to read the parameters.
 */
async function layoutVariants(
  ctx: ProbeContext,
  kind: "Order" | "CreditNote",
  id: number,
): Promise<string> {
  const before = await stateOf(ctx, kind, id);
  const alternativePath = kind === "CreditNote" ? "Creditnote" : "order";
  const attempts: readonly {
    readonly label: string;
    readonly run: () => Promise<{ readonly result: HttpResult; readonly pre?: string }>;
  }[] = [
    {
      label: "body {key, value}",
      run: async () => ({ result: await changeParameter(ctx, kind, id, "language", "en_US") }),
    },
    {
      label: "after a getPdf preview (preventSendBy=true)",
      run: async () => {
        const pdf = await ctx.http.get(`/${kind}/${id}/getPdf`, { preventSendBy: "true" });
        return {
          pre: `getPdf ${outcomeOf(pdf)}`,
          result: await changeParameter(ctx, kind, id, "language", "en_US"),
        };
      },
    },
    {
      label: `after POST /${kind}/{id}/render {forceReload: false}`,
      run: async () => {
        const render = await ctx.http.write("POST", `/${kind}/${id}/render`, {
          tier: "write",
          body: { forceReload: false },
        });
        return {
          pre: `render ${render.ok ? `ok, answer keys ${layoutAnswerKeys(render.objects)}` : outcomeOf(render)}`,
          result: await changeParameter(ctx, kind, id, "language", "en_US"),
        };
      },
    },
    {
      label: "key and value in the query",
      run: async () => ({
        result: await ctx.http.write("PUT", `/${kind}/${id}/changeParameter`, {
          tier: "commit",
          query: { key: "language", value: "en_US" },
        }),
      }),
    },
    {
      label: `path /${alternativePath}/{id}/changeParameter`,
      run: async () => ({
        result: await changeParameter(ctx, alternativePath, id, "language", "en_US"),
      }),
    },
  ];
  const steps: string[] = [];
  let accepted: string | undefined;
  for (const attempt of attempts) {
    const { result, pre } = await attempt.run();
    steps.push(
      `${attempt.label}: ${pre === undefined ? "" : `${pre}; `}${changeAnswer(result)}` +
        (result.ok
          ? `; parameters: ${describeParameters(result.objects, { language: "en_US" })}`
          : ""),
    );
    if (result.ok) {
      accepted = attempt.label;
      break;
    }
  }
  const after = await stateOf(ctx, kind, id);
  const diff = diffState(before.state, after.state);
  if (diff !== "") data(ctx).mark(kind, id, `changed by the layout probe (${diff})`);
  return (
    `${kind} draft ${id}: ${accepted === undefined ? "no form was accepted" : `accepted: ${accepted}`}. ${steps.join(" | ")} | ` +
    (diff === "" ? "status, sendDate, sendType and number unchanged" : `STATE CHANGED: ${diff}`)
  );
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
    deviations: ["D-107", "D-027", "D-064"],
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
    deviations: ["D-107", "D-027", "D-064"],
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
    deviations: ["D-108", "D-073"],
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
    deviations: ["D-109", "D-066", "D-074"],
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
      "OPT-IN, reserves one number of the trial's offer sequence and one of its credit note sequence (recorded: given back once the draft is deleted, D-066; " +
      "a run that stops before the delete leaves a gap): after reserving a number with " +
      "useNextNumber=true (as the draft tools do, D-066), saving an offer and a credit note draft with it and deleting the draft, which number comes next: " +
      "the reserved one again, or the one after it (a gap in the Nummernkreis)?",
    deviations: ["D-066", "D-027"],
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
    deviations: ["D-110", "D-054", "D-053", "D-051", "D-064"],
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
    deviations: ["D-111", "D-014", "D-049"],
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
    deviations: ["D-111", "D-014"],
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
    deviations: ["D-112", "D-014", "D-024"],
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
                tier: "commit",
                body: { status: 100 },
              });
        const afterBack = await ctx.read.byId("Invoice", id);
        lines.push(
          `Back to 100 (${deactivated.route}): ${outcomeOf(back)} → status ${str(afterBack, "status")}; ${schedule(ctx, afterBack)}`,
        );
      }
      lines.push(
        `DELETE the template at status ${str(await ctx.read.byId("Invoice", id), "status")}: ${(await deleteTemplate(ctx, id)).text}`,
      );
      const second = await createTemplate(ctx, addDays(ctx.today, 30));
      if ("failure" in second) {
        lines.push(`Second template: ${second.failure}`);
      } else {
        const off = await deactivateTemplate(ctx, second.id);
        const status = str(await ctx.read.byId("Invoice", second.id), "status");
        lines.push(
          `Second template ${second.id}: ${off.text}; DELETE at status ${status}: ${(await deleteTemplate(ctx, second.id)).text}`,
        );
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-recurring-schedule-fields",
    title: "Which fields give a recurring template (WKR) its schedule",
    mode: "write",
    question:
      "accountNextInvoice (Unix seconds or dd.mm.yyyy) was not stored on create, and accountStartDate/EndDate/LastInvoice read back empty. Which input stores a start, " +
      "end or next-run date: accountStartDate and accountEndDate as Unix seconds, ISO or dd.mm.yyyy, accountNextInvoice as ISO, start + next together, invoiceDate alone, " +
      "the dates in an update with the template's id (saveInvoice or PUT /Invoice/{id}), or status 200 in an update? Each template is read back (every account… field) and deleted; " +
      "one that DELETE leaves (sevDesk refuses status 200, D-112) is ended with status 50 and deleted again.",
    deviations: ["D-111", "D-014"],
    async run(ctx) {
      const next = addDays(ctx.today, 30);
      const lines: string[] = [];
      const storing: string[] = [];
      let created = 0;
      for (const variant of SCHEDULE_VARIANTS) {
        const made = await scheduledTemplate(ctx, variant, next);
        if (made.id === undefined) {
          lines.push(`${variant.label}: ${made.text}`);
          continue;
        }
        created += 1;
        const stored = storedDates(made.row);
        if (stored.length > 0) storing.push(`${variant.label} (${stored.join(", ")})`);
        const deleted = await deleteTemplate(ctx, made.id);
        lines.push(
          `${variant.label}: ${made.text}; ${deleted.gone && !deleted.refused ? "deleted" : deleted.text}`,
        );
      }
      if (created === 0) return inconclusive(`No template was saved. ${lines.join(". ")}.`);
      return {
        verdict: "observed",
        finding:
          (storing.length === 0
            ? "NO input stored a start, end or next-run date: the API does not set a template's schedule this way. "
            : `A schedule date was stored by: ${storing.join("; ")}. `) +
          `Run date asked for: ${next} (Unix ${berlinMidnight(next)}). ${lines.join(". ")}.`,
        deviations: { "D-014": "informs" },
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
    deviations: ["D-113", "D-025", "D-023"],
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
    deviations: ["D-115", "D-024"],
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
    deviations: ["D-116", "D-053"],
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
              // An invoice update without invoiceType is a commit step: the client cannot tell
              // it from a change of a recurring template.
              tier: kind === "Invoice" ? "commit" : "write",
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
    id: "write-change-parameter-read-back",
    title: "Where changeParameter choices can be read; changeParameter on orders and credit notes",
    mode: "write",
    question:
      "On an invoice draft changeParameter answered {metaData} and the record showed none of the chosen values. Does metaData.parameters[].value hold the current " +
      "language, letterpaper and template (also on a second call that changes nothing), and can they be read anywhere else: GET /Invoice/{id} with embed, the getPdf " +
      "answer (preventSendBy=true), POST /Invoice/{id}/render {forceReload: false} (the spec declares parameters there)? On order and credit note drafts every call " +
      "was refused with 500 'Syntax error': does it work after a getPdf preview, after render, with key and value in the query, or on the path Creditnote/order?",
    deviations: ["D-113", "D-025", "D-023"],
    async run(ctx) {
      const letterpapers = (
        await readLayouts(ctx, "/DocServer/getLetterpapersWithThumb", "letterpapers")
      ).rows;
      const templates = (
        await readLayouts(ctx, "/DocServer/getTemplatesWithThumb", "templates", "Invoice")
      ).rows;
      // Only one letterpaper exists on the trial: then the default one (no change) is sent.
      const pick = (rows: readonly Row[]) =>
        str(rows.find((row) => !isDefaultLayout(row)) ?? rows[0], "id");
      const choices: readonly (readonly [string, string])[] = [
        ["language", "en_US"],
        ["letterpaper", pick(letterpapers)],
        ["template", pick(templates)],
      ];
      const lines: string[] = [];
      const invoice = await data(ctx).draft("Invoice");
      lines.push(
        invoice.id === undefined
          ? `Invoice draft refused (${outcomeOf(invoice.result)})`
          : await invoiceLayoutReadBack(ctx, invoice.id, choices),
      );
      for (const kind of ["Order", "CreditNote"] as const) {
        const draft = await documentDraft(ctx, kind);
        lines.push(
          draft.id === undefined
            ? `${kind} draft refused (${outcomeOf(draft.result)})`
            : await layoutVariants(ctx, kind, draft.id),
        );
      }
      if (lines.every((line) => line.includes("draft refused"))) {
        return inconclusive(`${lines.join(". ")}.`);
      }
      const changed = lines.some((line) => line.includes("STATE CHANGED"));
      return {
        verdict: changed ? "contradicted" : "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-023": changed ? "contradicts" : "informs" },
      };
    },
  },
  {
    id: "write-recurring-template-due",
    title: "A recurring template whose next run is due (opt-in, stays active)",
    mode: "write",
    optIn: true,
    question:
      "OPT-IN, leaves ONE ACTIVE recurring template on the trial for a day: a monthly WKR template for the tagged contact (no e-mail address, so nothing can be e-mailed) " +
      "whose start or next run is yesterday, or today if a past date is refused. It tries the schedule inputs of write-recurring-schedule-fields in turn, keeps the first " +
      "template that reads back with accountNextInvoice or accountStartDate and deletes the others. What does sevDesk store, and does it generate an invoice at once? " +
      "Run read-recurring-generated the next day to see what sevDesk generated (a draft or a finalized invoice; sent or not).",
    deviations: ["D-111", "D-014"],
    async run(ctx) {
      const tried: string[] = [];
      for (const variant of SCHEDULE_VARIANTS) {
        for (const next of [addDays(ctx.today, -1), ctx.today]) {
          const made = await scheduledTemplate(ctx, variant, next);
          if (made.id === undefined) {
            tried.push(`${variant.label}, run ${next}: ${made.text}`);
            continue;
          }
          const due = DUE_KEYS.filter((key) => str(made.row, key) !== "");
          if (due.length === 0) {
            const deleted = await deleteTemplate(ctx, made.id);
            tried.push(
              `${variant.label}, run ${next}: no start or next-run date stored (${deleted.gone && !deleted.refused ? "deleted" : deleted.text})`,
            );
            break;
          }
          data(ctx).mark(
            "Invoice",
            made.id,
            "ACTIVE recurring template (WKR): end or delete after read-recurring-generated",
          );
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
              `Kept ${made.text} (made with: ${variant.label}, run ${next}). Invoices with this template as origin right after saving: ` +
              `${generated.length}. Run read-recurring-generated tomorrow. Tried before: ${tried.join(". ") || "nothing"}.`,
          };
        }
      }
      return inconclusive(
        `NO input stored a start or next-run date, so no due template was left: the API cannot set a schedule this way. ${tried.join(". ")}.`,
      );
    },
  },
  {
    id: "read-order-get-discounts",
    title: "GET /Order/{id}/getDiscounts",
    mode: "read",
    question:
      "What does GET /Order/{id}/getDiscounts answer (envelope, row keys and types, isNet, the object reference)? Asks up to 10 orders, tagged ones first, " +
      "and describes the first answer with discounts (write-document-discount leaves tagged orders with one).",
    deviations: ["D-116"],
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
    deviations: ["D-114", "D-024", "D-025"],
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
    deviations: ["D-111", "D-112", "D-049"],
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
      // The templates of one run share their header, so a header match is listed under each of
      // them; rows linked to any tagged template belong to that one only. Counted once each.
      const templateIds = new Set(templates.map((row) => str(row, "id")));
      const linkedToTemplate = (row: Row) =>
        templateIds.has(String(refId(row, "origin") ?? str(row, "origin")));
      const generated = new Set<string>();
      const lines: string[] = [];
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
            !linkedToTemplate(row),
        );
        for (const row of [...byOrigin, ...byHeader]) generated.add(str(row, "id"));
        const describe = (row: Row) =>
          `${str(row, "id")}: type ${str(row, "invoiceType")}, status ${str(row, "status")}, ${numberText(ctx, row, "Invoice")}, ` +
          `invoiceDate ${str(row, "invoiceDate").slice(0, 10) || "-"}, created ${str(row, "create").slice(0, 16) || "-"}, ` +
          `sendDate ${str(row, "sendDate") || "-"}, sendType ${str(row, "sendType") || "-"}, origin ${refId(row, "origin") ?? (str(row, "origin") || "-")}`;
        lines.push(
          `Template ${id} (status ${str(template, "status")}, in the default list: ${defaultIds.has(str(template, "id"))}; ${schedule(ctx, template)}): ` +
            `generated with this origin: ${byOrigin.length === 0 ? "none" : byOrigin.map(describe).join("; ")}; ` +
            `same header, not linked to a tagged template: ${byHeader.length === 0 ? "none" : byHeader.map(describe).join("; ")}`,
        );
      }
      return {
        verdict: "observed",
        finding: `${templates.length} tagged template(s), ${generated.size} generated invoice(s) found. ${lines.join(". ")}.`,
        deviations: { "D-049": "informs", "D-014": "informs" },
      };
    },
  },
];
