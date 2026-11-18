/**
 * Probes for issues #86 (contact persons, deleting contacts and their details, custom contact
 * fields) and #87 (tags and cost centres on documents). `write-custom-field-limits` re-checks the
 * custom field facts of D-086 recorded by one-off checks (#135), reports `confirmed` or
 * `contradicted`, and deletes what it made in a `finally`, also when a step fails.
 *
 * The write probes create everything they touch: tagged contacts, addresses, communication ways,
 * custom field settings and values, draft invoices, orders, credit notes and vouchers, tags and,
 * when sevDesk lets the API create one, cost centres. Everything is registered for the cleanup
 * list; what a probe deletes is marked as deleted. Nothing is finalized, e-mailed or enshrined, and
 * no probe deletes or changes a record it did not create in this run. The one exception it reads
 * but never changes: a cost centre named `MCP-E2E…` made by hand in the web app, used only when
 * the API cannot create one (see {@link probeCostCentre}).
 *
 * Findings carry ids, statuses, counts, key names and booleans, never names or values from the
 * account: values such as tag names, custom field values or customer numbers are compared locally
 * and reported as "same"/"changed".
 *
 * Five probes answer open live questions of #136 and #134 on a trial account (cost centres on
 * voucher positions, tag spellings and two tag filters, the paging of the relation list, the
 * contact name search, and what deleting an organisation does to its contact persons). They report
 * `observed` and delete everything they made in a `finally` ({@link withCleanup}), also when a step
 * fails.
 */
import { rowsOf } from "../fixture-plan.js";
import {
  createdId,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  type Query,
  refId,
  type Row,
  str,
} from "./core.js";
import {
  bookingAccounts,
  data,
  firstRow,
  inconclusive,
  isGone,
  keysOf,
  outcomeOf,
  type RecordedCheck,
  recordedOutcome,
  saveVoucherStatus,
  shapeOf,
  voucherHeader,
  voucherPosition,
  voucherPositions,
  withCleanup,
} from "./m4-shared-probes.js";

/** Contact category Kunde (customer), as the tagged test contact uses it. */
const CUSTOMER = { id: 3, objectName: "Category" } as const;
/** Address categories Rechnungsanschrift and Lieferanschrift. */
const BILLING_ADDRESS = 47;
const DELIVERY_ADDRESS = 48;
/** Communication way key Arbeit (work). */
const WORK_KEY = 2;
/** StaticCountry Germany. */
const GERMANY = 1;

type DocumentKind = "Invoice" | "Voucher" | "Order" | "CreditNote";
const DOCUMENT_KINDS: readonly DocumentKind[] = ["Invoice", "Voucher", "Order", "CreditNote"];

const SAVE_KEY: Readonly<Record<Exclude<DocumentKind, "Voucher">, string>> = {
  Invoice: "invoice",
  Order: "order",
  CreditNote: "creditNote",
};

function ref(objectName: string, id: number): { readonly id: number; readonly objectName: string } {
  return { id, objectName };
}

/** Registers a record once (a tag that several calls answer with). */
function registerOnce(ctx: ProbeContext, objectName: string, id: number, state: string): void {
  const known = data(ctx).created.some((item) => item.objectName === objectName && item.id === id);
  if (!known) data(ctx).register(objectName, id, state);
}

/** `deleted by the probe` when a GET by id says the record is gone. */
function markIfGone(ctx: ProbeContext, objectName: string, id: number, after: HttpResult): void {
  if (isGone(after)) data(ctx).mark(objectName, id, "deleted by the probe");
}

/** `gone (…)` or `still there` for a GET by id after a delete. */
function presence(result: HttpResult): string {
  if (isGone(result)) {
    return `gone (${result.ok ? "empty list" : String(result.status ?? result.kind)})`;
  }
  return result.ok ? "still there" : `unreadable (${outcomeOf(result)})`;
}

/** A reference field as `Contact 12`, `null`, `absent` or its type. */
function describeRef(row: Row | undefined, key: string): string {
  if (row === undefined) return "row unreadable";
  if (!Object.hasOwn(row, key)) return "absent";
  const value = row[key];
  if (value === null) return "null";
  if (typeof value === "object") {
    const id = refId(row, key);
    const objectName = str(value as Row, "objectName");
    const extra = Object.keys(value).filter((item) => item !== "id" && item !== "objectName");
    return `${objectName || "?"} ${id ?? "?"}${extra.length > 0 ? ` (+${extra.length} keys)` : ""}`;
  }
  return `a ${typeof value}`;
}

/** The ids of an answer's rows. */
function rowIds(rows: readonly Row[]): number[] {
  return rows.map((row) => Number(row["id"])).filter((id) => Number.isSafeInteger(id));
}

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

/** `POST /Contact` (customer, active) with `body` merged last; registered for cleanup. */
async function createContact(
  ctx: ProbeContext,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const result = await ctx.http.write("POST", "/Contact", {
    tier: "write",
    body: { category: CUSTOMER, status: 1000, ...body },
  });
  const id = createdId(result.objects);
  if (id !== undefined) data(ctx).register("Contact", id, "active (can be deleted in the web app)");
  return { id, result };
}

function organisation(
  ctx: ProbeContext,
  label: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return createContact(ctx, { name: `${data(ctx).tag} ${label}`, ...extra });
}

function person(ctx: ProbeContext, label: string, extra: Readonly<Record<string, unknown>> = {}) {
  return createContact(ctx, {
    surename: "Probe",
    familyname: `${data(ctx).tag} ${label}`,
    ...extra,
  });
}

/** `POST /ContactAddress` for a contact (Germany, the given category). */
async function createAddress(
  ctx: ProbeContext,
  contactId: number,
  category: number,
  label: string,
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const result = await ctx.http.write("POST", "/ContactAddress", {
    tier: "write",
    body: {
      contact: ref("Contact", contactId),
      street: `${data(ctx).tag} ${label}`,
      zip: "10115",
      city: "Berlin",
      country: ref("StaticCountry", GERMANY),
      category: ref("Category", category),
    },
  });
  const id = createdId(result.objects);
  if (id !== undefined) data(ctx).register("ContactAddress", id, "address of a tagged contact");
  return { id, result };
}

/** `POST /CommunicationWay` (key work). E-mails go to `example.com`; nothing is ever sent. */
async function createWay(
  ctx: ProbeContext,
  contactId: number,
  type: "EMAIL" | "PHONE",
  value: string,
  main: boolean,
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const result = await ctx.http.write("POST", "/CommunicationWay", {
    tier: "write",
    body: {
      contact: ref("Contact", contactId),
      type,
      value,
      key: ref("CommunicationWayKey", WORK_KEY),
      main,
    },
  });
  const id = createdId(result.objects);
  if (id !== undefined) data(ctx).register("CommunicationWay", id, "of a tagged contact");
  return { id, result };
}

/** A local-part for probe e-mail addresses: the run tag without spaces, lower case. */
function mailbox(ctx: ProbeContext, label: string): string {
  return `${data(ctx)
    .tag.replace(/[^A-Za-z0-9-]+/g, "-")
    .toLowerCase()}-${label}@example.com`;
}

/** Rows of a contact's addresses or communication ways (filtered again locally, D-032). */
async function detailsOf(
  ctx: ProbeContext,
  path: "/ContactAddress" | "/CommunicationWay",
  contactId: number,
): Promise<Row[]> {
  const page = await ctx.read.page(
    path,
    { "contact[id]": contactId, "contact[objectName]": "Contact" },
    100,
  );
  return page.rows.filter((row) => refId(row, "contact") === contactId);
}

// ---------------------------------------------------------------------------------------------
// Documents and tags
// ---------------------------------------------------------------------------------------------

const orderCounters = new WeakMap<object, { next: number }>();

/**
 * An order number for an offer (AN) draft: `saveOrder` refuses a draft without one (400, D-027).
 * The next number is only peeked (`useNextNumber=false`, D-066), which never advances the
 * sequence, so every order of the run gets the peeked number plus its own `-P<n>` suffix and no
 * two drafts share a number.
 */
async function orderNumber(
  ctx: ProbeContext,
): Promise<{ readonly value: string | undefined; readonly failure: string }> {
  const peek = await ctx.http.get("/Order/Factory/getNextOrderNumber", {
    orderType: "AN",
    useNextNumber: "false",
  });
  const peeked = typeof peek.objects === "string" ? peek.objects : "";
  if (!peek.ok || peeked === "") {
    return { value: undefined, failure: `getNextOrderNumber ${outcomeOf(peek)}` };
  }
  let counter = orderCounters.get(ctx.read);
  if (counter === undefined) {
    counter = { next: 1 };
    orderCounters.set(ctx.read, counter);
  }
  const value = `${peeked}-P${counter.next}`;
  counter.next += 1;
  return { value, failure: "" };
}

/** The last part of the run tag (`MCP-E2E 20261116-2140-r5dr` → `r5dr`). */
function runSuffix(ctx: ProbeContext): string {
  return data(ctx).tag.split("-").at(-1) ?? "run";
}

/**
 * A short name of this run, `E2E <suffix> <label>`, cut to 30 characters: sevDesk refuses longer
 * custom field setting names (400 "Property 'name' is too long. Maximum for this property is 30",
 * recorded 2026-11-16).
 */
function shortName(ctx: ProbeContext, label: string): string {
  return `E2E ${runSuffix(ctx)} ${label}`.slice(0, 30);
}

// ---------------------------------------------------------------------------------------------
// Custom field limits (re-check of D-086)
// ---------------------------------------------------------------------------------------------

/** A record a probe created and deletes at its end. */
interface OwnRecord {
  readonly objectName: string;
  readonly id: number;
}

/**
 * Deletes the records of `own` in the given order that are not marked deleted yet: a GET by id
 * first (a value may already be gone with its contact or setting), a DELETE of what is still
 * there, a GET again. One note per record the cleanup deleted or could not delete.
 */
async function deleteOwn(ctx: ProbeContext, own: readonly OwnRecord[]): Promise<string[]> {
  const notes: string[] = [];
  for (const { objectName, id } of own) {
    const known = data(ctx).created.find(
      (record) => record.objectName === objectName && record.id === id,
    );
    if (known?.state === "deleted by the probe") continue;
    const before = await ctx.http.get(`/${objectName}/${id}`);
    if (isGone(before)) {
      markIfGone(ctx, objectName, id, before);
      continue;
    }
    const deleted = await ctx.http.write("DELETE", `/${objectName}/${id}`, { tier: "write" });
    const after = await ctx.http.get(`/${objectName}/${id}`);
    markIfGone(ctx, objectName, id, after);
    notes.push(
      `${objectName} ${id} ${isGone(after) ? "deleted" : `left (DELETE ${outcomeOf(deleted)})`}`,
    );
  }
  return notes;
}

/** `getReferenceCount` of a setting as a number, `undefined` when refused or not a number. */
async function referenceCount(ctx: ProbeContext, settingId: number): Promise<number | undefined> {
  const result = await ctx.http.get(`/ContactCustomFieldSetting/${settingId}/getReferenceCount`);
  const count = Number(result.objects);
  return result.ok && typeof result.objects !== "object" && Number.isSafeInteger(count)
    ? count
    : undefined;
}

/** Whether a DELETE answered `{objects: [null]}`. */
function answeredNullList(result: HttpResult): boolean {
  return (
    result.ok &&
    Array.isArray(result.objects) &&
    result.objects.length === 1 &&
    result.objects[0] === null
  );
}

/**
 * The body of `write-custom-field-limits`: every step appends to `own` what it created, so that the
 * cleanup finds it also when a later step fails. Values are compared locally, never reported.
 */
async function customFieldLimits(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  const checks: RecordedCheck[] = [];
  const keep = (objectName: string, id: number, state: string) => {
    data(ctx).register(objectName, id, state);
    own.push({ objectName, id });
  };
  const postSetting = async (name: string) => {
    const result = await ctx.http.write("POST", "/ContactCustomFieldSetting", {
      tier: "write",
      body: { objectName: "ContactCustomFieldSetting", name },
    });
    const id = createdId(result.objects);
    if (id !== undefined) {
      keep("ContactCustomFieldSetting", id, "custom field setting (deleted by the probe)");
    }
    return { id, result };
  };

  // 1. The setting name: 31 characters refused, exactly 30 taken.
  const base = shortName(ctx, "Limit");
  const tooLong = await postSetting(`${base} `.padEnd(31, "x"));
  checks.push({
    fact: "a setting name of 31 characters is refused with 400 (maximum 30)",
    holds:
      tooLong.id === undefined &&
      tooLong.result.status === 400 &&
      /Maximum for this property is 30\b/.test(tooLong.result.message ?? ""),
    seen: tooLong.id === undefined ? outcomeOf(tooLong.result) : `created setting ${tooLong.id}`,
  });
  const name = `${base} `.padEnd(30, "x");
  const setting = await postSetting(name);
  checks.push({
    fact: "a setting name of exactly 30 characters is taken",
    holds: setting.id !== undefined,
    seen: setting.id === undefined ? outcomeOf(setting.result) : `setting ${setting.id}`,
  });
  if (setting.id === undefined) return recordedOutcome(checks, "");
  const settingId = setting.id;

  const org = await organisation(ctx, "Zusatzfeld Limit");
  if (org.id !== undefined) own.push({ objectName: "Contact", id: org.id });
  const per = await person(ctx, "Zusatzfeld Limit");
  if (per.id !== undefined) own.push({ objectName: "Contact", id: per.id });
  if (org.id === undefined || per.id === undefined) {
    const partial = recordedOutcome(checks, "", [
      `Could not create the contacts: ${outcomeOf(org.result)} / ${outcomeOf(per.result)}`,
    ]);
    return { ...partial, verdict: "inconclusive" };
  }
  const orgId = org.id;
  const personId = per.id;

  // 2. The value: exactly 100 characters stored in full, 101 refused on PUT.
  const value = `E2E-${runSuffix(ctx)}-LIMIT-`.padEnd(100, "0");
  const postValue = async (contactId: number, fieldValue: string) => {
    const result = await ctx.http.write("POST", "/ContactCustomField", {
      tier: "write",
      body: {
        objectName: "ContactCustomField",
        contact: ref("Contact", contactId),
        contactCustomFieldSetting: ref("ContactCustomFieldSetting", settingId),
        value: fieldValue,
      },
    });
    const id = createdId(result.objects);
    if (id !== undefined) keep("ContactCustomField", id, "custom field value of a tagged contact");
    return { id, result };
  };
  const orgValue = await postValue(orgId, value);
  const stored =
    orgValue.id === undefined
      ? ""
      : str(await ctx.read.byId("ContactCustomField", orgValue.id), "value");
  checks.push({
    fact: "a value of exactly 100 characters is stored in full",
    holds: stored === value,
    seen:
      orgValue.id === undefined
        ? outcomeOf(orgValue.result)
        : `stored ${stored.length} characters, ${stored === value ? "the text sent" : "another text"}`,
  });
  if (orgValue.id === undefined) return recordedOutcome(checks, "");
  const orgValueId = orgValue.id;
  const longer = await ctx.http.write("PUT", `/ContactCustomField/${orgValueId}`, {
    tier: "write",
    body: { objectName: "ContactCustomField", value: `${value}1` },
  });
  const unchanged = str(await ctx.read.byId("ContactCustomField", orgValueId), "value") === value;
  checks.push({
    fact: "a PUT of a 101-character value is refused with 400 (maximum 100), the value stays",
    holds:
      longer.status === 400 &&
      /Maximum for this property is 100\b/.test(longer.message ?? "") &&
      unchanged,
    seen: `${outcomeOf(longer)}; value afterwards ${unchanged ? "unchanged" : "changed"}`,
  });

  // 3. One value per setting and contact.
  const second = await postValue(orgId, `E2E-${runSuffix(ctx)}-ZWEI`);
  const ofOrg = await ctx.read.page(
    "/ContactCustomField",
    { "contact[id]": orgId, "contact[objectName]": "Contact" },
    100,
  );
  const values = ofOrg.rows.filter(
    (row) =>
      refId(row, "contact") === orgId && refId(row, "contactCustomFieldSetting") === settingId,
  ).length;
  checks.push({
    fact: "a second value for the same contact and setting is refused with 400, one value is read",
    holds: second.id === undefined && second.result.status === 400 && values === 1,
    seen: `${second.id === undefined ? outcomeOf(second.result) : `created value ${second.id}`}; a read by contact shows ${ofOrg.result.ok ? `${values} value(s) of the setting` : outcomeOf(ofOrg.result)}`,
  });

  // 4. The search finds persons too and ignores limit and offset.
  const personValue = await postValue(personId, value);
  const pages: string[] = [];
  let bothEverywhere = personValue.id !== undefined;
  for (const offset of [0, 1]) {
    const result = await ctx.http.get("/Contact/Factory/findContactsByCustomFieldValue", {
      value,
      "customFieldSetting[id]": settingId,
      "customFieldSetting[objectName]": "ContactCustomFieldSetting",
      customFieldName: name,
      limit: 1,
      offset,
    });
    const ids =
      result.ok && result.objects !== undefined && result.objects !== null
        ? rowIds(rowsOf(result.objects))
        : [];
    const both = ids.includes(orgId) && ids.includes(personId);
    bothEverywhere &&= both;
    pages.push(
      `limit=1&offset=${offset}: ${result.ok ? `${ids.length} contact(s), organisation ${ids.includes(orgId)}, person ${ids.includes(personId)}` : outcomeOf(result)}`,
    );
  }
  checks.push({
    fact: "findContactsByCustomFieldValue finds the organisation and the person and ignores limit and offset",
    holds: bothEverywhere,
    seen: `${personValue.id === undefined ? `the person's value ${outcomeOf(personValue.result)}; ` : ""}${pages.join("; ")}`,
  });

  // 5. Deleting a contact deletes its value and lowers the setting's reference count.
  if (personValue.id !== undefined) {
    const countBefore = await referenceCount(ctx, settingId);
    const deleted = await ctx.http.write("DELETE", `/Contact/${personId}`, { tier: "write" });
    markIfGone(ctx, "Contact", personId, await ctx.http.get(`/Contact/${personId}`));
    const valueAfter = await ctx.http.get(`/ContactCustomField/${personValue.id}`);
    markIfGone(ctx, "ContactCustomField", personValue.id, valueAfter);
    const countAfter = await referenceCount(ctx, settingId);
    checks.push({
      fact: "deleting a contact deletes its value (404) and lowers getReferenceCount by one",
      holds:
        deleted.ok &&
        valueAfter.status === 404 &&
        countBefore !== undefined &&
        countAfter === countBefore - 1,
      seen: `DELETE ${outcomeOf(deleted)}; value afterwards ${presence(valueAfter)}; getReferenceCount ${String(countBefore)} → ${String(countAfter)}`,
    });
  }

  // 6. Deleting the setting while a value uses it deletes the value too (no 409).
  const settingDeleted = await ctx.http.write("DELETE", `/ContactCustomFieldSetting/${settingId}`, {
    tier: "write",
  });
  const settingAfter = await ctx.http.get(`/ContactCustomFieldSetting/${settingId}`);
  markIfGone(ctx, "ContactCustomFieldSetting", settingId, settingAfter);
  const valueAfter = await ctx.http.get(`/ContactCustomField/${orgValueId}`);
  markIfGone(ctx, "ContactCustomField", orgValueId, valueAfter);
  checks.push({
    fact: "deleting the setting while a value uses it answers [null] and deletes the value",
    holds: answeredNullList(settingDeleted) && isGone(settingAfter) && isGone(valueAfter),
    seen: `DELETE ${outcomeOf(settingDeleted)}${settingDeleted.ok ? `, answer ${shapeOf(settingDeleted.objects)}` : ""}; setting afterwards ${presence(settingAfter)}, value afterwards ${presence(valueAfter)}`,
  });
  return recordedOutcome(checks, "");
}

/**
 * A tagged draft of `kind`: invoices, orders (AN) and credit notes through the test data factory
 * with `fields` merged into the header, vouchers through `saveVoucher` (status 50, one position
 * of 119.00 gross on the expense account the M4 probes use).
 */
async function draftOf(
  ctx: ProbeContext,
  kind: DocumentKind,
  label: string,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly id: number | undefined; readonly failure: string }> {
  if (kind === "Order") {
    const number = await orderNumber(ctx);
    if (number.value === undefined) return { id: undefined, failure: number.failure };
    const draft = await data(ctx).draft(kind, { fields: { orderNumber: number.value, ...fields } });
    return {
      id: draft.id,
      failure: draft.id === undefined ? `Order draft ${outcomeOf(draft.result)}` : "",
    };
  }
  if (kind !== "Voucher") {
    const draft = await data(ctx).draft(kind, Object.keys(fields).length === 0 ? {} : { fields });
    return {
      id: draft.id,
      failure: draft.id === undefined ? `${kind} draft ${outcomeOf(draft.result)}` : "",
    };
  }
  const accounts = await bookingAccounts(ctx);
  if (accounts.expense === undefined) {
    return { id: undefined, failure: `no expense booking account (${accounts.note})` };
  }
  const result = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
    tier: "write",
    body: {
      voucher: { ...voucherHeader(ctx, { label }), ...fields },
      voucherPosSave: [
        voucherPosition(data(ctx).tag, accounts.expense, {
          net: false,
          amount: 119,
          label: `${label} position`,
        }),
      ],
      voucherPosDelete: null,
    },
  });
  const id = createdId(result.objects, "voucher");
  if (id !== undefined) data(ctx).register("Voucher", id, "draft voucher (deletable)");
  return { id, failure: id === undefined ? `saveVoucher ${outcomeOf(result)}` : "" };
}

interface TagResult {
  readonly result: HttpResult;
  readonly tagId: number | undefined;
  readonly relationId: number | undefined;
}

/** `POST /Tag/Factory/create`; registers the tag it names (once). */
async function tagObject(
  ctx: ProbeContext,
  body: Readonly<Record<string, unknown>>,
): Promise<TagResult> {
  const result = await ctx.http.write("POST", "/Tag/Factory/create", { tier: "write", body });
  const row = firstRow(result.objects);
  const tagId = refId(row, "tag");
  const relationId = result.ok ? createdId(result.objects) : undefined;
  if (tagId !== undefined) registerOnce(ctx, "Tag", tagId, "tag (delete it in the web app)");
  return { result, tagId, relationId };
}

/** Tags `kind` `id` with the tag named `name` (created by sevDesk when new). */
function tagByName(ctx: ProbeContext, name: string, kind: DocumentKind, id: number) {
  return tagObject(ctx, { name, object: ref(kind, id) });
}

/** `MCP-E2E … <label>`: a tag name of this run. */
function tagName(ctx: ProbeContext, label: string): string {
  return `${data(ctx).tag} ${label}`;
}

/** Relations of a tag, from the unfiltered list filtered locally (the filter may be ignored). */
async function relationsOf(ctx: ProbeContext, tagId: number): Promise<Row[]> {
  const page = await ctx.read.page("/TagRelation", undefined, 1000);
  return page.rows.filter((row) => refId(row, "tag") === tagId);
}

/** `tag 12 → 3 relations (Invoice 5, …)`. */
function describeRelations(rows: readonly Row[]): string {
  return rows.length === 0
    ? "no relation"
    : `${rows.length} relation(s): ${rows.map((row) => `${str(firstRow(row["object"]), "objectName") || "?"} ${refId(row, "object") ?? "?"}`).join(", ")}`;
}

/**
 * How a list answered a server-side filter: honoured when every expected row is in, no control
 * row is, and every other row `matches` the filter by its own fields (rows of other probes that
 * carry the same cost centre, say). Without `matches`, any other row counts against the filter.
 */
async function filterOutcome(
  ctx: ProbeContext,
  path: string,
  query: Query,
  expected: ReadonlySet<number>,
  control: ReadonlySet<number>,
  matches: (row: Row) => boolean = () => false,
): Promise<{ readonly honoured: boolean; readonly text: string }> {
  const page = await ctx.read.page(path, query, 1000);
  if (!page.result.ok) return { honoured: false, text: outcomeOf(page.result) };
  const ids = rowIds(page.rows);
  const found = ids.filter((id) => expected.has(id)).length;
  const others = ids.length - found;
  const controlShown = ids.some((id) => control.has(id));
  const strays = page.rows.filter((row) => !expected.has(Number(row["id"])) && !matches(row));
  const honoured = found === expected.size && !controlShown && strays.length === 0;
  const text = honoured
    ? others === 0
      ? `honoured (${found} row(s), exactly the expected ones)`
      : `honoured (${ids.length} row(s): the expected one(s) and ${others} other(s) that match, control out)`
    : ids.length === 0
      ? `empty answer (total ${page.total ?? "?"})`
      : controlShown
        ? `ignored (${ids.length} rows incl. the control, total ${page.total ?? "?"})`
        : `unclear (${found} of ${expected.size} expected, ${strays.length} other rows that do not match)`;
  return { honoured, text };
}

// ---------------------------------------------------------------------------------------------
// Cost centres
// ---------------------------------------------------------------------------------------------

interface CostCentreChoice {
  readonly id: number | undefined;
  /** Created by this run (true) or a hand-made `MCP-E2E…` one from the web app (false). */
  readonly created: boolean;
  /** For findings: how it was found, or why there is none. */
  readonly note: string;
  /** The answer of the first `POST /CostCentre`. */
  readonly createResult: HttpResult;
}

/**
 * `POST /CostCentre` (undocumented) with a tagged name (`MCP-E2E <run suffix> <label>`) and a
 * number of 7 letters and digits: sevDesk allows at most 8 characters of
 * `/^[a-zA-Z0-9 äöüßÄÖÜ]+$/u` (422, recorded 2026-11-16).
 */
async function createCostCentre(
  ctx: ProbeContext,
  label: string,
  suffix: string,
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const result = await ctx.http.write("POST", "/CostCentre", {
    tier: "write",
    body: {
      objectName: "CostCentre",
      name: `MCP-E2E ${runSuffix(ctx)} ${label}`,
      number: `M${String(ctx.nowSeconds).slice(-5)}${suffix}`,
    },
  });
  const id = createdId(result.objects);
  if (id !== undefined)
    data(ctx).register("CostCentre", id, "cost centre (delete it in the web app)");
  return { id, result };
}

const costCentreCache = new WeakMap<object, Promise<CostCentreChoice>>();

/**
 * The cost centre the document probes use, chosen once per run: one created through the API, else
 * a cost centre whose name starts with `MCP-E2E` (made by hand in the web app before the run,
 * never changed or deleted by a probe), else none.
 */
function probeCostCentre(ctx: ProbeContext): Promise<CostCentreChoice> {
  let cached = costCentreCache.get(ctx.read);
  if (cached === undefined) {
    cached = chooseCostCentre(ctx);
    costCentreCache.set(ctx.read, cached);
  }
  return cached;
}

async function chooseCostCentre(ctx: ProbeContext): Promise<CostCentreChoice> {
  const created = await createCostCentre(ctx, "KST", "A");
  if (created.id !== undefined) {
    return {
      id: created.id,
      created: true,
      note: `cost centre ${created.id} created through POST /CostCentre`,
      createResult: created.result,
    };
  }
  const list = await ctx.read.page("/CostCentre", undefined, 1000);
  const own = list.rows.find((row) => str(row, "name").startsWith("MCP-E2E"));
  const id = Number(own?.["id"]);
  if (own !== undefined && Number.isSafeInteger(id) && id > 0) {
    return {
      id,
      created: false,
      note: `POST /CostCentre ${outcomeOf(created.result)}; using the hand-made cost centre ${id} named MCP-E2E…`,
      createResult: created.result,
    };
  }
  return {
    id: undefined,
    created: false,
    note:
      `POST /CostCentre ${outcomeOf(created.result)}, and GET /CostCentre ` +
      `${list.result.ok ? `has no cost centre named MCP-E2E… (${list.rows.length} rows)` : outcomeOf(list.result)}: ` +
      "create one named MCP-E2E Kostenstelle in the web app and run again",
    createResult: created.result,
  };
}

/** The document's `costCentre` as `CostCentre 7`, `null` or `absent`, read by id. */
async function costCentreOf(ctx: ProbeContext, kind: DocumentKind, id: number): Promise<string> {
  return describeRef(await ctx.read.byId(kind, id), "costCentre");
}

/**
 * `save<Kind>` of an existing draft with only `header` fields (and the id): the update form the
 * recordings showed to keep omitted fields (D-054). Vouchers send their full probe header. The
 * invoice update sends no `invoiceType`, so it is a commit step: the client cannot tell it from a
 * change of a recurring template, which keeps its stored type the same way (D-112).
 */
function saveWithId(
  ctx: ProbeContext,
  kind: DocumentKind,
  id: number,
  header: Readonly<Record<string, unknown>>,
  label: string,
): Promise<HttpResult> {
  if (kind === "Voucher") return saveVoucherStatus(ctx, id, { label, status: 50 }, header);
  const key = SAVE_KEY[kind];
  return ctx.http.write("POST", `/${kind}/Factory/save${kind}`, {
    tier: kind === "Invoice" ? "commit" : "write",
    body: {
      [key]: { id, objectName: kind, mapAll: true, ...header },
      [`${key}PosSave`]: [],
      [`${key}PosDelete`]: null,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Open live questions of #136 and #134 (trial probes)
// ---------------------------------------------------------------------------------------------

/**
 * The cleanup order of the trial probes: tags before the documents they sit on (`DELETE /Tag`
 * removes its relations, D-089), documents before the cost centres and contacts they name (a used
 * cost centre or a referenced contact is not deleted, D-085), contacts last.
 */
const CLEANUP_ORDER = ["Tag", "Invoice", "Voucher", "CostCentre", "Contact"];

/** {@link deleteOwn} of `own` without duplicates, in {@link CLEANUP_ORDER} (stable otherwise). */
function cleanupOwn(ctx: ProbeContext, own: readonly OwnRecord[]): Promise<string[]> {
  const unique = own.filter(
    (record, index) =>
      own.findIndex((item) => item.objectName === record.objectName && item.id === record.id) ===
      index,
  );
  const rank = (record: OwnRecord) => {
    const at = CLEANUP_ORDER.indexOf(record.objectName);
    return at === -1 ? CLEANUP_ORDER.length : at;
  };
  return deleteOwn(
    ctx,
    [...unique].sort((a, b) => rank(a) - rank(b)),
  );
}

/** A tagged draft invoice of {@link draftOf}, kept in `own` for the cleanup. */
async function ownInvoice(
  ctx: ProbeContext,
  label: string,
  own: OwnRecord[],
  fields: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly id: number | undefined; readonly failure: string }> {
  const draft = await draftOf(ctx, "Invoice", label, fields);
  if (draft.id !== undefined) own.push({ objectName: "Invoice", id: draft.id });
  return draft;
}

/** {@link tagByName}, with the tag kept in `own` for the cleanup. */
async function ownTag(
  ctx: ProbeContext,
  name: string,
  invoiceId: number,
  own: OwnRecord[],
): Promise<TagResult> {
  const tagged = await tagByName(ctx, name, "Invoice", invoiceId);
  if (tagged.tagId !== undefined) own.push({ objectName: "Tag", id: tagged.tagId });
  return tagged;
}

/** The ids of a list answer's rows (none when refused or empty). */
function answerIds(result: HttpResult): number[] {
  return result.ok && result.objects !== undefined && result.objects !== null
    ? rowIds(rowsOf(result.objects))
    : [];
}

/** `ascending`, `descending` or `neither` for a list of ids. */
function idOrder(ids: readonly number[]): string {
  if (ids.length < 2) return "too few rows to tell";
  const pairs = ids.slice(1).map((id, index) => id - (ids[index] ?? id));
  if (pairs.every((step) => step > 0)) return "ascending";
  if (pairs.every((step) => step < 0)) return "descending";
  return "neither ascending nor descending";
}

/**
 * A draft voucher (`saveVoucher`, status 50, one position of 119.00 gross) whose head carries the
 * cost centre `head` and whose position carries `position` (`undefined`: none), kept in `own`.
 */
async function voucherWithCostCentres(
  ctx: ProbeContext,
  label: string,
  centres: { readonly head: number | undefined; readonly position: number },
  own: OwnRecord[],
): Promise<{ readonly id: number | undefined; readonly failure: string }> {
  const accounts = await bookingAccounts(ctx);
  if (accounts.expense === undefined) {
    return { id: undefined, failure: `no expense booking account (${accounts.note})` };
  }
  const position = voucherPosition(data(ctx).tag, accounts.expense, {
    net: false,
    amount: 119,
    label: `${label} position`,
  });
  const result = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
    tier: "write",
    body: {
      voucher: {
        ...voucherHeader(ctx, { label }),
        ...(centres.head === undefined ? {} : { costCentre: ref("CostCentre", centres.head) }),
      },
      voucherPosSave: [{ ...position, costCentre: ref("CostCentre", centres.position) }],
      voucherPosDelete: null,
    },
  });
  const id = createdId(result.objects, "voucher");
  if (id !== undefined) {
    data(ctx).register("Voucher", id, "draft voucher (deletable)");
    own.push({ objectName: "Voucher", id });
  }
  return { id, failure: id === undefined ? `saveVoucher ${outcomeOf(result)}` : "" };
}

/** The body of `write-voucher-position-cost-centre`. */
async function positionCostCentres(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  const head = await createCostCentre(ctx, "KST Kopf", "D");
  if (head.id !== undefined) own.push({ objectName: "CostCentre", id: head.id });
  const position = await createCostCentre(ctx, "KST Position", "E");
  if (position.id !== undefined) own.push({ objectName: "CostCentre", id: position.id });
  if (head.id === undefined || position.id === undefined) {
    return inconclusive(
      `POST /CostCentre ${outcomeOf(head.result)} / ${outcomeOf(position.result)}: the probe needs two cost centres of its own.`,
    );
  }
  const names = new Map([
    [head.id, "the head's"],
    [position.id, "the position's"],
  ]);
  const which = (row: Row | undefined) => {
    const id = refId(row, "costCentre");
    return `${describeRef(row, "costCentre")}${id === undefined ? "" : ` (${names.get(id) ?? "another"})`}`;
  };
  const lines = [`Cost centres ${head.id} (sent on the head) and ${position.id} (on the position)`];
  for (const variant of [
    { label: "head and position", head: head.id },
    { label: "position only", head: undefined },
  ]) {
    const voucher = await voucherWithCostCentres(
      ctx,
      `cost centre ${variant.label}`,
      { head: variant.head, position: position.id },
      own,
    );
    if (voucher.id === undefined) {
      lines.push(`${variant.label}: ${voucher.failure}`);
      continue;
    }
    const row = await ctx.read.byId("Voucher", voucher.id);
    const positions = await voucherPositions(ctx, voucher.id);
    lines.push(
      `${variant.label} (voucher ${voucher.id}): the head reads ${which(row)}; ${positions.length} position(s) read ${positions.map(which).join(", ") || "nothing"}`,
    );
  }
  return { verdict: "observed", finding: `${lines.join(". ")}.` };
}

/**
 * Pairs of tag names that differ in one way sevDesk may or may not fold when it looks for an
 * existing tag (#105; only case and é/e are recorded, D-088). The base is sent first, the variant
 * second, both after the run tag. The special characters are built from their code points, so
 * that none hides in the source.
 */
const TAG_SPELLINGS: readonly {
  readonly label: string;
  readonly base: string;
  readonly variant: string;
}[] = [
  { label: "ß then ss", base: "Maß", variant: "Mass" },
  {
    label: "fi then the ligature U+FB01",
    base: "Profil",
    variant: `Pro${String.fromCodePoint(0xfb01)}l`,
  },
  {
    label: "a zero-width space inside",
    base: "Nullbreite",
    variant: `Null${String.fromCodePoint(0x200b)}breite`,
  },
  {
    label: "a soft hyphen inside",
    base: "Trennung",
    variant: `Tren${String.fromCodePoint(0xad)}nung`,
  },
  { label: "a doubled inner space", base: "Zwei Teile", variant: "Zwei  Teile" },
];

/** How a stored tag name compares with the names sent; never the name itself. */
function spelledAs(stored: string, sent: string, base: string): string {
  if (stored === "") return "unreadable";
  if (stored === sent) return `as sent (${stored.length} characters)`;
  if (stored === base) return `as the base (${stored.length} characters)`;
  return `another text (${stored.length} characters for ${sent.length} sent)`;
}

/** Which of three drafts a list filtered by two tags answered, as a rule. */
function twoTagRule(found: {
  readonly onlyFirst: boolean;
  readonly onlySecond: boolean;
  readonly both: boolean;
  readonly control: boolean;
}): string {
  if (found.control) return "ignored (an untagged draft is listed)";
  if (found.onlyFirst && found.onlySecond && found.both) return "either tag (OR)";
  if (!found.onlyFirst && !found.onlySecond && found.both) return "both tags (AND)";
  if (found.onlyFirst && !found.onlySecond && found.both) return "the first tag only";
  if (!found.onlyFirst && found.onlySecond && found.both) return "the second tag only";
  if (!found.onlyFirst && !found.onlySecond && !found.both) return "no draft listed";
  return "unclear";
}

/** The body of `write-tag-name-matching`. */
async function tagNameMatching(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  const baseDoc = await ownInvoice(ctx, "tag spelling base", own);
  const variantDoc = await ownInvoice(ctx, "tag spelling variant", own);
  if (baseDoc.id === undefined || variantDoc.id === undefined) {
    return inconclusive(`Could not prepare: ${baseDoc.failure || variantDoc.failure}.`);
  }
  const lines: string[] = [];
  for (const spelling of TAG_SPELLINGS) {
    const baseName = tagName(ctx, spelling.base);
    const variantName = tagName(ctx, spelling.variant);
    const base = await ownTag(ctx, baseName, baseDoc.id, own);
    const variant = await ownTag(ctx, variantName, variantDoc.id, own);
    if (base.tagId === undefined || variant.tagId === undefined) {
      lines.push(`${spelling.label}: ${outcomeOf(base.result)} / ${outcomeOf(variant.result)}`);
      continue;
    }
    const stored = str(await ctx.read.byId("Tag", variant.tagId), "name");
    const named = await ctx.read.page("/Tag", { name: variantName }, 100);
    const ids = rowIds(named.rows);
    lines.push(
      `${spelling.label}: ${variant.tagId === base.tagId ? "reuses the base's tag" : "a new tag"}, named ${spelledAs(stored, variantName, baseName)}; ` +
        `GET /Tag?name=<variant> ${named.result.ok ? `${ids.length} row(s), the base's tag ${ids.includes(base.tagId)}, the variant's ${ids.includes(variant.tagId)}` : outcomeOf(named.result)}`,
    );
  }

  // Two tags at once on the invoice list (D-090 recorded only tags[0]).
  const onlyFirst = await ownInvoice(ctx, "two tags first", own);
  const onlySecond = await ownInvoice(ctx, "two tags second", own);
  const both = await ownInvoice(ctx, "two tags both", own);
  if (onlyFirst.id === undefined || onlySecond.id === undefined || both.id === undefined) {
    lines.push(
      `two tags: could not prepare (${onlyFirst.failure || onlySecond.failure || both.failure})`,
    );
    return { verdict: "observed", finding: `${lines.join(". ")}.` };
  }
  const first = tagName(ctx, "Filter Erster");
  const second = tagName(ctx, "Filter Zweiter");
  const a = await ownTag(ctx, first, onlyFirst.id, own);
  const b = await ownTag(ctx, second, onlySecond.id, own);
  const bothA = await ownTag(ctx, first, both.id, own);
  const bothB = await ownTag(ctx, second, both.id, own);
  if (a.tagId === undefined || b.tagId === undefined || !bothA.result.ok || !bothB.result.ok) {
    lines.push(
      `two tags: tagging ${[a, b, bothA, bothB].map((item) => outcomeOf(item.result)).join(" / ")}`,
    );
    return { verdict: "observed", finding: `${lines.join(". ")}.` };
  }
  const page = await ctx.read.page(
    "/Invoice",
    {
      "tags[0][id]": a.tagId,
      "tags[0][objectName]": "Tag",
      "tags[1][id]": b.tagId,
      "tags[1][objectName]": "Tag",
    },
    1000,
  );
  const ids = rowIds(page.rows);
  const found = {
    onlyFirst: ids.includes(onlyFirst.id),
    onlySecond: ids.includes(onlySecond.id),
    both: ids.includes(both.id),
    control: ids.includes(baseDoc.id) || ids.includes(variantDoc.id),
  };
  lines.push(
    `GET /Invoice with tags[0] and tags[1]: ${
      page.result.ok
        ? `${twoTagRule(found)} (first only ${found.onlyFirst}, second only ${found.onlySecond}, both ${found.both}, untagged ${found.control}; ${ids.length} row(s), total ${page.total ?? "none"})`
        : outcomeOf(page.result)
    }`,
  );
  return { verdict: "observed", finding: `${lines.join(". ")}.` };
}

/** Page size and reach of the paged reads of `write-tag-relation-paging`. */
const RELATION_PAGE = 3;
const RELATION_PAGED_ROWS = 60;

/** The body of `write-tag-relation-paging`. */
async function tagRelationPaging(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  // Six relations of this run: two tags on three drafts each.
  const relations: number[] = [];
  const failures: string[] = [];
  for (const label of ["paging 1", "paging 2", "paging 3"]) {
    const draft = await ownInvoice(ctx, label, own);
    if (draft.id === undefined) {
      failures.push(draft.failure);
      continue;
    }
    for (const name of [tagName(ctx, "Seite A"), tagName(ctx, "Seite B")]) {
      const tagged = await ownTag(ctx, name, draft.id, own);
      if (tagged.relationId === undefined) failures.push(`tagging ${outcomeOf(tagged.result)}`);
      else relations.push(tagged.relationId);
    }
  }
  if (relations.length < 2) {
    return inconclusive(
      `Only ${relations.length} relation(s) could be made: ${failures.join("; ") || "no reason"}.`,
    );
  }
  const full = await ctx.http.get("/TagRelation", { limit: 1000, offset: 0, countAll: true });
  if (!full.ok) return inconclusive(`GET /TagRelation ${outcomeOf(full)}.`);
  const fullIds = answerIds(full);
  const rawTotal = (full.json as { total?: unknown } | undefined)?.total;
  const again = answerIds(await ctx.http.get("/TagRelation", { limit: 1000, offset: 0 }));
  const covered = Math.min(fullIds.length, RELATION_PAGED_ROWS);
  const paged: number[] = [];
  let pageFailure: string | undefined;
  for (let offset = 0; offset < covered; offset += RELATION_PAGE) {
    const page = await ctx.http.get("/TagRelation", { limit: RELATION_PAGE, offset });
    if (!page.ok) {
      pageFailure = `the page at offset ${offset} ${outcomeOf(page)}`;
      break;
    }
    paged.push(...answerIds(page));
  }
  const expected = fullIds.slice(0, covered);
  const shown = paged.slice(0, covered);
  const sameOrder = JSON.stringify(shown) === JSON.stringify(expected);
  const missing = expected.filter((id) => !paged.includes(id)).length;
  const twice = paged.length - new Set(paged).size;
  const positions = relations.map((id) => fullIds.indexOf(id));
  const where = positions.some((at) => at === -1)
    ? "not all among the rows read"
    : positions.every((at) => at >= fullIds.length - relations.length)
      ? "the last rows"
      : positions.every((at) => at < relations.length)
        ? "the first rows"
        : "in between";
  const paging =
    pageFailure ??
    (sameOrder
      ? `the same ids in the same order`
      : `differ (${missing} missing, ${twice} listed twice, ${shown.length} row(s) read)`);
  return {
    verdict: "observed",
    finding:
      `GET /TagRelation (limit 1000): ${fullIds.length} row(s), total ${rawTotal === undefined || rawTotal === null ? "none" : str({ total: rawTotal }, "total")}; ids ${idOrder(fullIds)}; ` +
      `a second read ${JSON.stringify(again) === JSON.stringify(fullIds) ? "the same ids in the same order" : "differs"}; ` +
      `pages of ${RELATION_PAGE} over the first ${covered}: ${paging}; this run's ${relations.length} relations are ${where}` +
      `${failures.length === 0 ? "" : ` (not made: ${failures.join("; ")})`}.`,
  };
}

/** The body of `write-contact-name-search`. */
async function contactNameSearch(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  const tag = data(ctx).tag;
  const org = await organisation(ctx, "Namensuche Holding");
  if (org.id !== undefined) own.push({ objectName: "Contact", id: org.id });
  const per = await person(ctx, "Suchperson");
  if (per.id !== undefined) own.push({ objectName: "Contact", id: per.id });
  if (org.id === undefined || per.id === undefined) {
    return inconclusive(
      `Could not create the contacts: ${outcomeOf(org.result)} / ${outcomeOf(per.result)}.`,
    );
  }
  const orgName = `${tag} Namensuche Holding`;
  const familyname = `${tag} Suchperson`;
  const variants: readonly {
    readonly label: string;
    readonly name: string;
    readonly target: number;
    readonly depth?: false;
  }[] = [
    { label: "organisation, full name", name: orgName, target: org.id },
    { label: "organisation, lower case", name: orgName.toLowerCase(), target: org.id },
    { label: "organisation, upper case", name: orgName.toUpperCase(), target: org.id },
    { label: "organisation, a middle part", name: "ensuche Hold", target: org.id },
    {
      label: "organisation, full name without depth=1",
      name: orgName,
      target: org.id,
      depth: false,
    },
    { label: "person, familyname", name: familyname, target: per.id },
    { label: "person, shown name (first last)", name: `Probe ${familyname}`, target: per.id },
    { label: "person, familyname in lower case", name: familyname.toLowerCase(), target: per.id },
    { label: "person, a middle part of the familyname", name: "uchperso", target: per.id },
    { label: "person, first name only", name: "Probe", target: per.id },
    { label: "person, familyname without depth=1", name: familyname, target: per.id, depth: false },
  ];
  const lines: string[] = [];
  for (const variant of variants) {
    const page = await ctx.read.page(
      "/Contact",
      { ...(variant.depth === false ? {} : { depth: 1 }), name: variant.name },
      1000,
    );
    lines.push(
      `${variant.label}: ${page.result.ok ? `${rowIds(page.rows).includes(variant.target) ? "found" : "not found"} (${page.rows.length} row(s))` : outcomeOf(page.result)}`,
    );
  }
  return {
    verdict: "observed",
    finding: `GET /Contact?name=… for organisation ${org.id} and person ${per.id} (depth=1 unless said): ${lines.join("; ")}.`,
  };
}

/** A contact read by id after a delete: presence, and its parent when still there. */
async function contactAfter(ctx: ProbeContext, id: number): Promise<string> {
  const after = await ctx.http.get(`/Contact/${id}`);
  markIfGone(ctx, "Contact", id, after);
  return `${presence(after)}${after.ok && !isGone(after) ? `, parent ${describeRef(firstRow(after.objects), "parent")}` : ""}`;
}

/**
 * The body of `write-contact-delete-cascade`. Persons go into `persons` and organisations into
 * `orgs`, so that the cleanup deletes the draft, then the persons, then the organisations.
 */
async function contactDeleteCascade(
  ctx: ProbeContext,
  documents: OwnRecord[],
  persons: OwnRecord[],
  orgs: OwnRecord[],
): Promise<ProbeOutcome> {
  const lines: string[] = [];

  // (a) An organisation with two contact persons and no document.
  const plain = await organisation(ctx, "Kaskade Firma");
  if (plain.id === undefined) {
    lines.push(`organisation with persons: ${outcomeOf(plain.result)}`);
  } else {
    orgs.push({ objectName: "Contact", id: plain.id });
    const children: number[] = [];
    for (const label of ["Kaskade Person 1", "Kaskade Person 2"]) {
      const child = await person(ctx, label, { parent: ref("Contact", plain.id) });
      if (child.id === undefined) continue;
      persons.push({ objectName: "Contact", id: child.id });
      children.push(child.id);
    }
    const deleted = await ctx.http.write("DELETE", `/Contact/${plain.id}`, { tier: "write" });
    const states: string[] = [];
    for (const id of children) states.push(`person ${id} ${await contactAfter(ctx, id)}`);
    lines.push(
      `organisation ${plain.id} with ${children.length} contact person(s), no document: DELETE ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; ` +
        `organisation afterwards ${await contactAfter(ctx, plain.id)}; ${states.join("; ") || "no person made"}`,
    );
  }

  // (b) An organisation whose contact person a draft invoice names as its contact.
  const referenced = await organisation(ctx, "Kaskade Referenz");
  if (referenced.id === undefined) {
    lines.push(`organisation with a referenced person: ${outcomeOf(referenced.result)}`);
    return { verdict: "observed", finding: `${lines.join(". ")}.` };
  }
  orgs.push({ objectName: "Contact", id: referenced.id });
  const child = await person(ctx, "Kaskade Referenzperson", {
    parent: ref("Contact", referenced.id),
  });
  if (child.id === undefined) {
    lines.push(`the referenced person: ${outcomeOf(child.result)}`);
    return { verdict: "observed", finding: `${lines.join(". ")}.` };
  }
  persons.push({ objectName: "Contact", id: child.id });
  const draft = await ownInvoice(ctx, "cascade", documents, {
    contact: ref("Contact", child.id),
  });
  if (draft.id === undefined) {
    lines.push(`the draft naming the person: ${draft.failure}`);
    return { verdict: "observed", finding: `${lines.join(". ")}.` };
  }
  const before = await ctx.read.byId("Invoice", draft.id);
  const deleted = await ctx.http.write("DELETE", `/Contact/${referenced.id}`, { tier: "write" });
  const orgState = await contactAfter(ctx, referenced.id);
  const personState = await contactAfter(ctx, child.id);
  const invoice = await ctx.http.get(`/Invoice/${draft.id}`);
  if (isGone(invoice)) data(ctx).mark("Invoice", draft.id, "deleted by the probe");
  const row = firstRow(invoice.objects);
  lines.push(
    `organisation ${referenced.id} whose contact person ${child.id} draft invoice ${draft.id} names (read contact ${describeRef(before, "contact")}): ` +
      `DELETE ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; organisation afterwards ${orgState}; person afterwards ${personState}; ` +
      `invoice afterwards ${presence(invoice)}${invoice.ok && !isGone(invoice) ? `, status ${str(row, "status")}, contact ${describeRef(row, "contact")}` : ""}`,
  );
  return { verdict: "observed", finding: `${lines.join(". ")}.` };
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export const GAPS_CONTACTS_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-contact-parent",
    title: "Contact persons: parent on POST and PUT /Contact",
    mode: "write",
    question:
      "Does POST /Contact take `parent` (an organisation) for a person, and does PUT /Contact/{id} set, change and clear it (parent null)? " +
      "How does a read show it (plain and with embed=parent), and does GET /Contact?depth=1 filter by parent[id] on the server?",
    deviations: ["D-083", "D-062"],
    async run(ctx) {
      const first = await organisation(ctx, "Firma A");
      const second = await organisation(ctx, "Firma B");
      if (first.id === undefined || second.id === undefined) {
        return inconclusive(
          `Could not create the organisations: ${outcomeOf(first.result)} / ${outcomeOf(second.result)}.`,
        );
      }
      const lines: string[] = [];
      const withParent = await person(ctx, "Ansprechpartner 1", {
        parent: ref("Contact", first.id),
      });
      if (withParent.id === undefined) {
        lines.push(`POST person with parent: ${outcomeOf(withParent.result)}`);
      } else {
        const plain = await ctx.read.byId("Contact", withParent.id);
        const embedded = await ctx.read.byId("Contact", withParent.id, { embed: "parent" });
        const otherKeys = Object.keys(plain ?? {}).filter(
          (key) => /parent/i.test(key) && key !== "parent",
        );
        lines.push(
          `POST person ${withParent.id} with parent ${first.id}: ok; read: parent ${describeRef(plain, "parent")}, ` +
            `with embed=parent ${describeRef(embedded, "parent")}; other parent keys: ${otherKeys.join(", ") || "none"}`,
        );
      }
      const later = await person(ctx, "Ansprechpartner 2");
      if (later.id === undefined) {
        lines.push(`POST person without parent: ${outcomeOf(later.result)}`);
        return { verdict: "observed", finding: `${lines.join(". ")}.` };
      }
      const personId = later.id;
      const steps: readonly { readonly label: string; readonly parent: number | null }[] = [
        { label: "set", parent: first.id },
        { label: "change", parent: second.id },
        { label: "clear (null)", parent: null },
      ];
      for (const step of steps) {
        const put = await ctx.http.write("PUT", `/Contact/${personId}`, {
          tier: "write",
          body: { parent: step.parent === null ? null : ref("Contact", step.parent) },
        });
        const row = await ctx.read.byId("Contact", personId);
        lines.push(
          `PUT ${step.label}${step.parent === null ? "" : ` to ${step.parent}`}: ${outcomeOf(put)}, answer ${shapeOf(put.objects)}; read parent ${describeRef(row, "parent")}`,
        );
        if (step.label === "change") {
          const filtered = await ctx.read.page(
            "/Contact",
            { depth: 1, "parent[id]": second.id, "parent[objectName]": "Contact" },
            1000,
          );
          const ids = rowIds(filtered.rows);
          const foreign = filtered.rows.filter((item) => refId(item, "parent") !== second.id);
          lines.push(
            `GET /Contact?depth=1&parent[id]=${second.id}: ${filtered.result.ok ? `${ids.length} row(s), person included: ${ids.includes(personId)}, rows with another parent: ${foreign.length} (${foreign.length === 0 && ids.includes(personId) ? "honoured" : "ignored"})` : outcomeOf(filtered.result)}`,
          );
        }
      }
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-062": "informs" },
      };
    },
  },
  {
    id: "write-contact-parent-invalid",
    title: "Contact persons: a person or an organisation as the wrong side of parent",
    mode: "write",
    question:
      "What does sevDesk answer when the parent is a person (POST and PUT), or when an organisation gets a parent? Accepted and stored, accepted and dropped, or refused?",
    deviations: ["D-083"],
    async run(ctx) {
      const parentPerson = await person(ctx, "Elternperson");
      const parentOrg = await organisation(ctx, "Elternfirma");
      if (parentPerson.id === undefined || parentOrg.id === undefined) {
        return inconclusive(
          `Could not create the parents: ${outcomeOf(parentPerson.result)} / ${outcomeOf(parentOrg.result)}.`,
        );
      }
      const personParent = parentPerson.id;
      const orgParent = parentOrg.id;
      const lines: string[] = [];
      const cases = [
        {
          label: "POST person with a person as parent",
          make: () => person(ctx, "Kind von Person", { parent: ref("Contact", personParent) }),
        },
        {
          label: "POST organisation with an organisation as parent",
          make: () => organisation(ctx, "Tochterfirma", { parent: ref("Contact", orgParent) }),
        },
      ] as const;
      for (const item of cases) {
        const created = await item.make();
        const row =
          created.id === undefined ? undefined : await ctx.read.byId("Contact", created.id);
        lines.push(
          `${item.label}: ${outcomeOf(created.result)}${created.id === undefined ? "" : ` (contact ${created.id}, read parent ${describeRef(row, "parent")})`}`,
        );
      }
      const plain = await person(ctx, "Person ohne Eltern");
      if (plain.id !== undefined) {
        const put = await ctx.http.write("PUT", `/Contact/${plain.id}`, {
          tier: "write",
          body: { parent: ref("Contact", personParent) },
        });
        const row = await ctx.read.byId("Contact", plain.id);
        lines.push(
          `PUT a person's parent to a person: ${outcomeOf(put)}; read parent ${describeRef(row, "parent")}`,
        );
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-contact-delete",
    title: "DELETE /Contact/{id} on an unreferenced contact",
    mode: "write",
    question:
      "What does DELETE /Contact/{id} answer for a contact no document references, are its address and communication way deleted with it, and is a second DELETE a 404?",
    deviations: ["D-084"],
    async run(ctx) {
      const contact = await organisation(ctx, "Loeschen");
      if (contact.id === undefined) {
        return inconclusive(`Could not create the contact: ${outcomeOf(contact.result)}.`);
      }
      const address = await createAddress(ctx, contact.id, BILLING_ADDRESS, "Loeschstrasse 1");
      const way = await createWay(ctx, contact.id, "EMAIL", mailbox(ctx, "delete"), true);
      const deleted = await ctx.http.write("DELETE", `/Contact/${contact.id}`, { tier: "write" });
      const after = await ctx.http.get(`/Contact/${contact.id}`);
      markIfGone(ctx, "Contact", contact.id, after);
      const lines = [
        `DELETE contact ${contact.id}: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; GET afterwards ${presence(after)}`,
      ];
      for (const [label, objectName, id] of [
        ["address", "ContactAddress", address.id],
        ["communication way", "CommunicationWay", way.id],
      ] as const) {
        if (id === undefined) {
          lines.push(`${label}: not created`);
          continue;
        }
        const detail = await ctx.http.get(`/${objectName}/${id}`);
        markIfGone(ctx, objectName, id, detail);
        const row = firstRow(detail.objects);
        lines.push(
          `${label} ${id}: ${presence(detail)}${detail.ok && !isGone(detail) ? `, contact ${describeRef(row, "contact")}` : ""}`,
        );
      }
      const again = await ctx.http.write("DELETE", `/Contact/${contact.id}`, { tier: "write" });
      lines.push(`second DELETE: ${outcomeOf(again)}`);
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-contact-delete-referenced",
    title: "DELETE /Contact/{id} on a contact a draft invoice references",
    mode: "write",
    question:
      "Does DELETE /Contact/{id} refuse a contact that a draft invoice references (status, message), or delete it, and what happens to the draft and its contact reference?",
    deviations: ["D-085", "D-084"],
    async run(ctx) {
      const contact = await organisation(ctx, "Referenziert");
      if (contact.id === undefined) {
        return inconclusive(`Could not create the contact: ${outcomeOf(contact.result)}.`);
      }
      const draft = await draftOf(ctx, "Invoice", "referenced", {
        contact: ref("Contact", contact.id),
      });
      if (draft.id === undefined) return inconclusive(`Could not prepare: ${draft.failure}.`);
      const before = await ctx.read.byId("Invoice", draft.id);
      const deleted = await ctx.http.write("DELETE", `/Contact/${contact.id}`, { tier: "write" });
      const after = await ctx.http.get(`/Contact/${contact.id}`);
      markIfGone(ctx, "Contact", contact.id, after);
      const invoice = await ctx.http.get(`/Invoice/${draft.id}`);
      const row = firstRow(invoice.objects);
      if (isGone(invoice)) data(ctx).mark("Invoice", draft.id, "deleted together with its contact");
      else if (isGone(after))
        data(ctx).mark("Invoice", draft.id, "draft whose contact was deleted");
      return {
        verdict: "observed",
        finding:
          `Draft invoice ${draft.id} of contact ${contact.id} (read contact ${describeRef(before, "contact")}). ` +
          `DELETE contact: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; contact afterwards ${presence(after)}; ` +
          `invoice afterwards ${presence(invoice)}${invoice.ok && !isGone(invoice) ? `, status ${str(row, "status")}, contact ${describeRef(row, "contact")}` : ""}.`,
      };
    },
  },
  {
    id: "write-contact-address-delete",
    title: "DELETE /ContactAddress/{id}: the billing address and the last address",
    mode: "write",
    question:
      "What does DELETE /ContactAddress/{id} answer, may the billing address (category 47) and the last remaining address be deleted, and is a second DELETE a 404?",
    deviations: ["D-084"],
    async run(ctx) {
      const contact = await organisation(ctx, "Adressen");
      if (contact.id === undefined) {
        return inconclusive(`Could not create the contact: ${outcomeOf(contact.result)}.`);
      }
      const billing = await createAddress(ctx, contact.id, BILLING_ADDRESS, "Rechnungsweg 1");
      const delivery = await createAddress(ctx, contact.id, DELIVERY_ADDRESS, "Lieferweg 2");
      if (billing.id === undefined || delivery.id === undefined) {
        return inconclusive(
          `Could not create the addresses: ${outcomeOf(billing.result)} / ${outcomeOf(delivery.result)}.`,
        );
      }
      const lines: string[] = [];
      for (const [label, id] of [
        ["billing address (one of two)", billing.id],
        ["last address", delivery.id],
      ] as const) {
        const deleted = await ctx.http.write("DELETE", `/ContactAddress/${id}`, { tier: "write" });
        const after = await ctx.http.get(`/ContactAddress/${id}`);
        markIfGone(ctx, "ContactAddress", id, after);
        const left = await detailsOf(ctx, "/ContactAddress", contact.id);
        lines.push(
          `DELETE ${label} ${id}: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; GET afterwards ${presence(after)}; the contact has ${left.length} address(es) left`,
        );
      }
      const again = await ctx.http.write("DELETE", `/ContactAddress/${delivery.id}`, {
        tier: "write",
      });
      const contactAfter = await ctx.http.get(`/Contact/${contact.id}`);
      lines.push(`second DELETE: ${outcomeOf(again)}; the contact is ${presence(contactAfter)}`);
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-communication-way-delete",
    title: "DELETE /CommunicationWay/{id}: the main entry and the last one of a type",
    mode: "write",
    question:
      "What does DELETE /CommunicationWay/{id} answer, may the main e-mail be deleted (does another e-mail become main), may the last e-mail be deleted, and is a second DELETE a 404?",
    deviations: ["D-084"],
    async run(ctx) {
      const contact = await organisation(ctx, "Kommunikation");
      if (contact.id === undefined) {
        return inconclusive(`Could not create the contact: ${outcomeOf(contact.result)}.`);
      }
      const main = await createWay(ctx, contact.id, "EMAIL", mailbox(ctx, "main"), true);
      const other = await createWay(ctx, contact.id, "EMAIL", mailbox(ctx, "other"), false);
      const phone = await createWay(ctx, contact.id, "PHONE", "+49 30 0000000", true);
      if (main.id === undefined || other.id === undefined) {
        return inconclusive(
          `Could not create the e-mails: ${outcomeOf(main.result)} / ${outcomeOf(other.result)}.`,
        );
      }
      const lines: string[] = [];
      const first = await ctx.http.write("DELETE", `/CommunicationWay/${main.id}`, {
        tier: "write",
      });
      const firstAfter = await ctx.http.get(`/CommunicationWay/${main.id}`);
      markIfGone(ctx, "CommunicationWay", main.id, firstAfter);
      const remaining = await ctx.read.byId("CommunicationWay", other.id);
      lines.push(
        `DELETE the main e-mail ${main.id}: ${outcomeOf(first)}, answer ${shapeOf(first.objects)}; GET afterwards ${presence(firstAfter)}; ` +
          `the other e-mail ${other.id} now has main ${JSON.stringify(remaining?.["main"] ?? null)}`,
      );
      const last = await ctx.http.write("DELETE", `/CommunicationWay/${other.id}`, {
        tier: "write",
      });
      const lastAfter = await ctx.http.get(`/CommunicationWay/${other.id}`);
      markIfGone(ctx, "CommunicationWay", other.id, lastAfter);
      const left = await detailsOf(ctx, "/CommunicationWay", contact.id);
      lines.push(
        `DELETE the last e-mail ${other.id}: ${outcomeOf(last)}; GET afterwards ${presence(lastAfter)}; ` +
          `left: ${left.map((row) => `${str(row, "type")} main ${str(row, "main")}`).join(", ") || "none"}${phone.id === undefined ? " (the phone was not created)" : ""}`,
      );
      const again = await ctx.http.write("DELETE", `/CommunicationWay/${other.id}`, {
        tier: "write",
      });
      lines.push(`second DELETE: ${outcomeOf(again)}`);
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-custom-field-settings",
    title: "Custom contact field settings: list, create, read, rename, count, delete",
    mode: "write",
    question:
      "What do GET/POST /ContactCustomFieldSetting, GET/PUT/DELETE /ContactCustomFieldSetting/{id} and getReferenceCount answer (shapes, identifier), is a second setting with the same name accepted, and is a second DELETE a 404? " +
      "Where is the name's length limit (31 characters refused on POST, exactly 30 taken on PUT)?",
    deviations: ["D-086"],
    async run(ctx) {
      const before = await ctx.read.page("/ContactCustomFieldSetting", undefined, 100);
      const name = shortName(ctx, "Feld");
      const lines = [
        `GET /ContactCustomFieldSetting: ${before.result.ok ? `${before.rows.length} row(s), total ${before.total ?? "none"}, keys ${keysOf(before.rows).join(", ") || "none"}` : outcomeOf(before.result)}`,
      ];
      const tooLong = await ctx.http.write("POST", "/ContactCustomFieldSetting", {
        tier: "write",
        body: { objectName: "ContactCustomFieldSetting", name: `${name} `.padEnd(31, "x") },
      });
      const tooLongId = createdId(tooLong.objects);
      if (tooLongId !== undefined) {
        data(ctx).register(
          "ContactCustomFieldSetting",
          tooLongId,
          "custom field setting (delete it in the web app)",
        );
      }
      lines.push(`POST with a 31-character name: ${outcomeOf(tooLong)}`);
      const created = await ctx.http.write("POST", "/ContactCustomFieldSetting", {
        tier: "write",
        body: {
          objectName: "ContactCustomFieldSetting",
          name,
          description: shortName(ctx, "Beschreibung"),
        },
      });
      const id = createdId(created.objects);
      lines.push(`POST: ${outcomeOf(created)}, answer ${shapeOf(created.objects)}`);
      if (id === undefined) return { verdict: "observed", finding: `${lines.join(". ")}.` };
      data(ctx).register(
        "ContactCustomFieldSetting",
        id,
        "custom field setting (delete it in the web app)",
      );
      const row = await ctx.read.byId("ContactCustomFieldSetting", id);
      lines.push(
        `GET by id: keys ${keysOf(row).join(", ") || "none"}; name as sent ${str(row, "name") === name}, identifier ${str(row, "identifier") === "" ? "empty" : "set"}`,
      );
      // Exactly 30 characters: the longest name the POST refusal allows.
      const newName = `${name} neu `.padEnd(30, "x");
      const renamed = await ctx.http.write("PUT", `/ContactCustomFieldSetting/${id}`, {
        tier: "write",
        body: { objectName: "ContactCustomFieldSetting", name: newName },
      });
      const afterRename = await ctx.read.byId("ContactCustomFieldSetting", id);
      lines.push(
        `PUT a 30-character name: ${outcomeOf(renamed)}, answer ${shapeOf(renamed.objects)}; renamed ${str(afterRename, "name") === newName}, description kept ${str(afterRename, "description") === shortName(ctx, "Beschreibung")}`,
      );
      const count = await ctx.http.get(`/ContactCustomFieldSetting/${id}/getReferenceCount`);
      lines.push(
        `getReferenceCount: ${count.ok ? `answer ${JSON.stringify(count.objects ?? null)}` : outcomeOf(count)}`,
      );
      const duplicate = await ctx.http.write("POST", "/ContactCustomFieldSetting", {
        tier: "write",
        body: { objectName: "ContactCustomFieldSetting", name: newName },
      });
      const duplicateId = createdId(duplicate.objects);
      if (duplicateId !== undefined) {
        data(ctx).register(
          "ContactCustomFieldSetting",
          duplicateId,
          "duplicate-name setting (delete it)",
        );
      }
      lines.push(`POST a second setting with the same name: ${outcomeOf(duplicate)}`);
      const deleted = await ctx.http.write("DELETE", `/ContactCustomFieldSetting/${id}`, {
        tier: "write",
      });
      const after = await ctx.http.get(`/ContactCustomFieldSetting/${id}`);
      markIfGone(ctx, "ContactCustomFieldSetting", id, after);
      const again = await ctx.http.write("DELETE", `/ContactCustomFieldSetting/${id}`, {
        tier: "write",
      });
      lines.push(
        `DELETE: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; GET afterwards ${presence(after)}; second DELETE ${outcomeOf(again)}`,
      );
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-custom-field-values",
    title: "Custom contact field values: set, read, search, change, delete",
    mode: "write",
    question:
      "How is a custom field value set on a contact (POST /ContactCustomField) and changed (PUT), which reads show it (GET /ContactCustomField with contact[id] and embed, GET /Contact/{id} with embed), " +
      "how does findContactsByCustomFieldValue match (exact, prefix, case, which parameters it needs), and what does deleting the value, or the setting while a value uses it, do?",
    deviations: ["D-086"],
    async run(ctx) {
      const settingName = shortName(ctx, "Kundennr extern");
      const setting = await ctx.http.write("POST", "/ContactCustomFieldSetting", {
        tier: "write",
        body: { objectName: "ContactCustomFieldSetting", name: settingName },
      });
      const settingId = createdId(setting.objects);
      if (settingId === undefined) {
        return inconclusive(`Could not create the setting: ${outcomeOf(setting)}.`);
      }
      data(ctx).register(
        "ContactCustomFieldSetting",
        settingId,
        "custom field setting (delete it in the web app)",
      );
      const contact = await organisation(ctx, "Zusatzfeld");
      if (contact.id === undefined) {
        return inconclusive(`Could not create the contact: ${outcomeOf(contact.result)}.`);
      }
      const contactId = contact.id;
      // Short like the setting name: the value's own length limit is unknown.
      const value = `E2E-${runSuffix(ctx)}-EXT-4711`;
      const fieldBody = (fieldValue: string) => ({
        objectName: "ContactCustomField",
        contact: ref("Contact", contactId),
        contactCustomFieldSetting: ref("ContactCustomFieldSetting", settingId),
        value: fieldValue,
      });
      const created = await ctx.http.write("POST", "/ContactCustomField", {
        tier: "write",
        body: fieldBody(value),
      });
      const fieldId = createdId(created.objects);
      const lines = [
        `POST /ContactCustomField: ${outcomeOf(created)}, answer ${shapeOf(created.objects)}`,
      ];
      if (fieldId === undefined) return { verdict: "observed", finding: `${lines.join(". ")}.` };
      data(ctx).register("ContactCustomField", fieldId, "custom field value of a tagged contact");

      const byContact = { "contact[id]": contactId, "contact[objectName]": "Contact" };
      const unfiltered = await ctx.read.page("/ContactCustomField", undefined, 1000);
      const filtered = await ctx.read.page("/ContactCustomField", byContact, 1000);
      const embedded = await ctx.read.page(
        "/ContactCustomField",
        { ...byContact, embed: "contactCustomFieldSetting" },
        1000,
      );
      const own = (rows: readonly Row[]) =>
        rows.filter((row) => refId(row, "contact") === contactId);
      const nested = (rows: readonly Row[]) =>
        keysOf(firstRow(own(rows)[0]?.["contactCustomFieldSetting"])).join(", ") || "none";
      lines.push(
        `GET /ContactCustomField: ${unfiltered.rows.length} row(s), keys ${keysOf(unfiltered.rows).join(", ") || "none"}, setting keys ${nested(unfiltered.rows)}; ` +
          `with contact[id]: ${filtered.result.ok ? `${filtered.rows.length} row(s), ${own(filtered.rows).length} of this contact (${filtered.rows.length === own(filtered.rows).length && own(filtered.rows).length > 0 ? "honoured" : "ignored or empty"})` : outcomeOf(filtered.result)}; ` +
          `with embed=contactCustomFieldSetting: setting keys ${nested(embedded.rows)}`,
      );
      const plain = await ctx.read.byId("Contact", contactId);
      const plainKeys = new Set(Object.keys(plain ?? {}));
      const embeds: string[] = [];
      for (const embed of ["contactCustomFields", "customFields", "contactCustomField"]) {
        const result = await ctx.http.get(`/Contact/${contactId}`, { embed });
        const row = firstRow(result.objects);
        const added = Object.keys(row ?? {}).filter((key) => !plainKeys.has(key));
        embeds.push(
          `embed=${embed} ${result.ok ? (added.length === 0 ? "adds nothing" : `adds ${added.join(", ")}`) : outcomeOf(result)}`,
        );
      }
      lines.push(
        `GET /Contact/{id}: custom-field keys ${[...plainKeys].filter((key) => /custom|field/i.test(key)).join(", ") || "none"}; ${embeds.join("; ")}`,
      );
      const count = await ctx.http.get(`/ContactCustomFieldSetting/${settingId}/getReferenceCount`);
      lines.push(
        `getReferenceCount with one value: ${count.ok ? JSON.stringify(count.objects ?? null) : outcomeOf(count)}`,
      );

      const changed = `${value}-B`;
      const put = await ctx.http.write("PUT", `/ContactCustomField/${fieldId}`, {
        tier: "write",
        body: { objectName: "ContactCustomField", value: changed },
      });
      const afterPut = await ctx.read.byId("ContactCustomField", fieldId);
      lines.push(
        `PUT value only: ${outcomeOf(put)}, answer ${shapeOf(put.objects)}; value changed ${str(afterPut, "value") === changed}, contact kept ${refId(afterPut, "contact") === contactId}, setting kept ${refId(afterPut, "contactCustomFieldSetting") === settingId}`,
      );

      const settingRef = {
        "customFieldSetting[id]": settingId,
        "customFieldSetting[objectName]": "ContactCustomFieldSetting",
      };
      const searches: readonly { readonly label: string; readonly query: Query }[] = [
        {
          label: "exact, setting id + name",
          query: { value: changed, ...settingRef, customFieldName: settingName },
        },
        { label: "exact, name only", query: { value: changed, customFieldName: settingName } },
        { label: "exact, setting id only", query: { value: changed, ...settingRef } },
        {
          label: "prefix",
          query: { value: value.slice(0, 12), ...settingRef, customFieldName: settingName },
        },
        {
          label: "lower case",
          query: { value: changed.toLowerCase(), ...settingRef, customFieldName: settingName },
        },
      ];
      const found: string[] = [];
      for (const search of searches) {
        const result = await ctx.http.get(
          "/Contact/Factory/findContactsByCustomFieldValue",
          search.query,
        );
        const ids =
          result.ok && result.objects !== undefined && result.objects !== null
            ? rowIds(rowsOf(result.objects))
            : [];
        found.push(
          `${search.label}: ${result.ok ? `${ids.length} contact(s), ours ${ids.includes(contactId)}` : outcomeOf(result)}`,
        );
      }
      lines.push(`findContactsByCustomFieldValue: ${found.join("; ")}`);

      const deleted = await ctx.http.write("DELETE", `/ContactCustomField/${fieldId}`, {
        tier: "write",
      });
      const fieldAfter = await ctx.http.get(`/ContactCustomField/${fieldId}`);
      markIfGone(ctx, "ContactCustomField", fieldId, fieldAfter);
      lines.push(
        `DELETE the value: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; GET afterwards ${presence(fieldAfter)}`,
      );

      const second = await ctx.http.write("POST", "/ContactCustomField", {
        tier: "write",
        body: fieldBody(`${value}-C`),
      });
      const secondId = createdId(second.objects);
      if (secondId !== undefined) {
        data(ctx).register(
          "ContactCustomField",
          secondId,
          "custom field value of a tagged contact",
        );
        const settingDeleted = await ctx.http.write(
          "DELETE",
          `/ContactCustomFieldSetting/${settingId}`,
          {
            tier: "write",
          },
        );
        const settingAfter = await ctx.http.get(`/ContactCustomFieldSetting/${settingId}`);
        const valueAfter = await ctx.http.get(`/ContactCustomField/${secondId}`);
        markIfGone(ctx, "ContactCustomFieldSetting", settingId, settingAfter);
        markIfGone(ctx, "ContactCustomField", secondId, valueAfter);
        lines.push(
          `DELETE the setting while value ${secondId} uses it: ${outcomeOf(settingDeleted)}; setting afterwards ${presence(settingAfter)}, value afterwards ${presence(valueAfter)}`,
        );
      } else {
        lines.push(`second value: ${outcomeOf(second)}`);
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-custom-field-limits",
    title: "Custom contact fields: the limits and deletes recorded on 2026-11-16/17",
    mode: "write",
    question:
      'Do the custom field facts of D-086 still hold? A setting name of 31 characters is refused with 400 ("Maximum for this property is 30") and one of exactly 30 is taken; a value of exactly 100 characters is stored in full, and a PUT of 101 characters is refused with 400 ("Maximum for this property is 100") and leaves the value; a second POST /ContactCustomField for the same contact and setting is refused with 400 and a read by contact shows one value; ' +
      "findContactsByCustomFieldValue finds an organisation and a person with the same value and ignores limit and offset (limit=1 with offset 0 and 1 both answer both); deleting a contact deletes its value (404) and lowers getReferenceCount by one; deleting the setting while a value uses it answers [null] and deletes the value (no 409). Everything it creates is deleted at the end, also when a step fails.",
    deviations: ["D-086"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      // Values first, then settings, then contacts, so that no cleanup delete relies on a cascade.
      const order = ["ContactCustomField", "ContactCustomFieldSetting", "Contact"];
      return withCleanup(
        () => customFieldLimits(ctx, own),
        () =>
          deleteOwn(
            ctx,
            [...own].sort((a, b) => order.indexOf(a.objectName) - order.indexOf(b.objectName)),
          ),
      );
    },
  },
  {
    id: "write-tag-create-on-documents",
    title: "Tag/Factory/create on an invoice, voucher, order and credit note",
    mode: "write",
    question:
      "Does POST /Tag/Factory/create tag a draft invoice, voucher, order (AN) and credit note, does a second call with the same name reuse the tag (same tag id), " +
      "what do the same name in other case, the same tag twice on one document and a tag given as {tag: {id}} without a name do, and what is the answer's shape?",
    deviations: ["D-088"],
    async run(ctx) {
      const name = tagName(ctx, "Projekt");
      const lines: string[] = [];
      const tagIds = new Map<DocumentKind, number>();
      const documents = new Map<DocumentKind, number>();
      for (const kind of DOCUMENT_KINDS) {
        const draft = await draftOf(ctx, kind, "tag create");
        if (draft.id === undefined) {
          lines.push(`${kind}: ${draft.failure}`);
          continue;
        }
        documents.set(kind, draft.id);
        const tagged = await tagByName(ctx, name, kind, draft.id);
        if (tagged.tagId !== undefined) tagIds.set(kind, tagged.tagId);
        lines.push(
          `${kind} ${draft.id}: ${outcomeOf(tagged.result)}, answer ${shapeOf(tagged.result.objects)}, tag ${tagged.tagId ?? "none"}, relation ${tagged.relationId ?? "none"}`,
        );
      }
      const distinct = new Set(tagIds.values());
      lines.push(
        distinct.size === 0
          ? "no tag id in any answer"
          : `${tagIds.size} documents tagged by name, ${distinct.size} distinct tag id(s) (${distinct.size === 1 ? "the name reuses the tag" : "the name created several tags"})`,
      );
      const invoice = documents.get("Invoice");
      const firstTag = tagIds.get("Invoice") ?? [...distinct][0];
      if (invoice !== undefined) {
        const twice = await tagByName(ctx, name, "Invoice", invoice);
        lines.push(
          `the same name again on invoice ${invoice}: ${outcomeOf(twice.result)}, tag ${twice.tagId ?? "none"}, relation ${twice.relationId ?? "none"}`,
        );
      }
      const order = documents.get("Order");
      if (order !== undefined) {
        const upper = await tagByName(ctx, name.toUpperCase(), "Order", order);
        lines.push(
          `the name in upper case on order ${order}: ${outcomeOf(upper.result)}, ${upper.tagId === undefined ? "no tag id" : upper.tagId === firstTag ? "the same tag" : "a new tag"}`,
        );
      }
      if (firstTag !== undefined) {
        const second = await draftOf(ctx, "Invoice", "tag by id");
        if (second.id !== undefined) {
          const byId = await tagObject(ctx, {
            tag: ref("Tag", firstTag),
            object: ref("Invoice", second.id),
          });
          lines.push(
            `{tag: {id}, object} without a name on invoice ${second.id}: ${outcomeOf(byId.result)}, ${byId.tagId === undefined ? "no tag id" : byId.tagId === firstTag ? "the same tag" : `another tag ${byId.tagId}`}`,
          );
        }
        const named = await ctx.read.page("/Tag", { name }, 100);
        lines.push(
          `GET /Tag?name=…: ${named.result.ok ? `${named.rows.length} row(s), ${named.rows.filter((row) => str(row, "name") === name).length} with exactly that name` : outcomeOf(named.result)}`,
        );
      }
      return {
        verdict: distinct.size === 0 ? "inconclusive" : "observed",
        finding: `${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "write-tag-relation-filters",
    title: "GET /TagRelation and /Tag: filters, paging and a usage count",
    mode: "write",
    question:
      "Does GET /TagRelation honour tag[id] and object[id]/object[objectName] filters and limit, which keys does a relation have, and does GET /Tag or the relation list give a usage count per tag?",
    deviations: ["D-088"],
    async run(ctx) {
      const name = tagName(ctx, "Filter");
      const invoice = await draftOf(ctx, "Invoice", "relation filter");
      const voucher = await draftOf(ctx, "Voucher", "relation filter");
      if (invoice.id === undefined) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const first = await tagByName(ctx, name, "Invoice", invoice.id);
      if (first.tagId === undefined) {
        return inconclusive(`Tag/Factory/create ${outcomeOf(first.result)}.`);
      }
      const tagId = first.tagId;
      const expected = new Set<number>(first.relationId === undefined ? [] : [first.relationId]);
      if (voucher.id !== undefined) {
        const second = await tagByName(ctx, name, "Voucher", voucher.id);
        if (second.relationId !== undefined) expected.add(second.relationId);
      }
      const all = await ctx.read.page("/TagRelation", undefined, 1000);
      const local = all.rows.filter((row) => refId(row, "tag") === tagId);
      const lines = [
        `GET /TagRelation: ${all.rows.length} row(s), total ${all.total ?? "none"}, keys ${keysOf(all.rows).join(", ") || "none"}, object keys ${keysOf(firstRow(all.rows[0]?.["object"])).join(", ") || "none"}; ${describeRelations(local)} of tag ${tagId}`,
      ];
      const byTag = await ctx.read.page(
        "/TagRelation",
        { "tag[id]": tagId, "tag[objectName]": "Tag" },
        1000,
      );
      lines.push(
        `tag[id] filter: ${byTag.result.ok ? `${byTag.rows.length} row(s), ${byTag.rows.filter((row) => refId(row, "tag") === tagId).length} of this tag (${byTag.rows.length === local.length && byTag.rows.every((row) => refId(row, "tag") === tagId) ? "honoured" : "ignored"}), total ${byTag.total ?? "none"}` : outcomeOf(byTag.result)}`,
      );
      const byObject = await ctx.read.page(
        "/TagRelation",
        { "object[id]": invoice.id, "object[objectName]": "Invoice" },
        1000,
      );
      const ofInvoice = byObject.rows.filter((row) => refId(row, "object") === invoice.id);
      lines.push(
        `object[id] filter: ${byObject.result.ok ? `${byObject.rows.length} row(s), ${ofInvoice.length} of invoice ${invoice.id} (${ofInvoice.length > 0 && ofInvoice.length === byObject.rows.length ? "honoured" : "ignored or empty"})` : outcomeOf(byObject.result)}`,
      );
      const one = await ctx.http.get("/TagRelation", { limit: 1, offset: 0 });
      lines.push(
        `limit=1: ${one.ok ? `${one.objects === undefined || one.objects === null ? 0 : rowsOf(one.objects).length} row(s)` : outcomeOf(one)}`,
      );
      const tagRow = await ctx.read.byId("Tag", tagId);
      const counting = Object.keys(tagRow ?? {}).filter((key) =>
        /count|usage|amount|relation/i.test(key),
      );
      lines.push(
        `GET /Tag/{id}: keys ${keysOf(tagRow).join(", ") || "none"}; count-like keys ${counting.join(", ") || "none"} (relations made: ${expected.size})`,
      );
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-tag-relation-remove",
    title: "Removing one tag from one document (undocumented DELETE /TagRelation/{id})",
    mode: "write",
    question:
      "The spec documents no way to remove a tag from a document: does the undocumented DELETE /TagRelation/{id} remove one relation and keep the tag and its other relations, " +
      "does removing the last relation delete the tag too, and is a second DELETE a 404?",
    deviations: ["D-024", "D-089"],
    async run(ctx) {
      const name = tagName(ctx, "Entfernen");
      const first = await draftOf(ctx, "Invoice", "tag remove 1");
      const second = await draftOf(ctx, "Invoice", "tag remove 2");
      if (first.id === undefined || second.id === undefined) {
        return inconclusive(`Could not prepare: ${first.failure || second.failure}.`);
      }
      const a = await tagByName(ctx, name, "Invoice", first.id);
      const b = await tagByName(ctx, name, "Invoice", second.id);
      if (a.tagId === undefined || a.relationId === undefined || b.relationId === undefined) {
        return inconclusive(`Tag/Factory/create ${outcomeOf(a.result)} / ${outcomeOf(b.result)}.`);
      }
      const tagId = a.tagId;
      const lines: string[] = [];
      const removed = await ctx.http.write("DELETE", `/TagRelation/${a.relationId}`, {
        tier: "write",
      });
      const relationAfter = await ctx.http.get(`/TagRelation/${a.relationId}`);
      const left = await relationsOf(ctx, tagId);
      const tagAfter = await ctx.http.get(`/Tag/${tagId}`);
      lines.push(
        `DELETE relation ${a.relationId} (invoice ${first.id}): ${outcomeOf(removed)}, answer ${shapeOf(removed.objects)}; GET /TagRelation/{id} afterwards ${presence(relationAfter)}; ` +
          `tag ${tagId} ${presence(tagAfter)} with ${describeRelations(left)}; the other relation ${b.relationId} kept: ${left.some((row) => Number(row["id"]) === b.relationId)}`,
      );
      if (!removed.ok) {
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}.`,
          deviations: { "D-024": "informs" },
        };
      }
      const last = await ctx.http.write("DELETE", `/TagRelation/${b.relationId}`, {
        tier: "write",
      });
      const tagAfterLast = await ctx.http.get(`/Tag/${tagId}`);
      markIfGone(ctx, "Tag", tagId, tagAfterLast);
      const again = await ctx.http.write("DELETE", `/TagRelation/${a.relationId}`, {
        tier: "write",
      });
      lines.push(
        `DELETE the last relation ${b.relationId}: ${outcomeOf(last)}; the tag afterwards ${presence(tagAfterLast)}; second DELETE of ${a.relationId}: ${outcomeOf(again)}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
  {
    id: "write-tag-update-delete",
    title: "PUT and DELETE /Tag/{id}: renaming, a duplicate name, deleting a used tag",
    mode: "write",
    question:
      "What do PUT /Tag/{id} (rename; rename to another tag's name) and DELETE /Tag/{id} on a tag two documents use answer, what happens to its relations and documents, and is a second DELETE a 404?",
    deviations: ["D-089"],
    async run(ctx) {
      const name = tagName(ctx, "Umbenennen");
      const otherName = tagName(ctx, "Andere");
      const first = await draftOf(ctx, "Invoice", "tag update 1");
      const second = await draftOf(ctx, "Order", "tag update 2");
      if (first.id === undefined) return inconclusive(`Could not prepare: ${first.failure}.`);
      const tagged = await tagByName(ctx, name, "Invoice", first.id);
      if (tagged.tagId === undefined)
        return inconclusive(`Tag/Factory/create ${outcomeOf(tagged.result)}.`);
      const tagId = tagged.tagId;
      if (second.id !== undefined) await tagByName(ctx, name, "Order", second.id);
      const other = await tagByName(ctx, otherName, "Invoice", first.id);
      const lines: string[] = [];
      const renamed = await ctx.http.write("PUT", `/Tag/${tagId}`, {
        tier: "write",
        body: { name: `${name} neu` },
      });
      const afterRename = await ctx.read.byId("Tag", tagId);
      const relations = await relationsOf(ctx, tagId);
      lines.push(
        `PUT name: ${outcomeOf(renamed)}, answer ${shapeOf(renamed.objects)}; renamed ${str(afterRename, "name") === `${name} neu`}; ${describeRelations(relations)} kept`,
      );
      if (other.tagId !== undefined) {
        const duplicate = await ctx.http.write("PUT", `/Tag/${tagId}`, {
          tier: "write",
          body: { name: otherName },
        });
        const afterDuplicate = await ctx.read.byId("Tag", tagId);
        lines.push(
          `PUT to another tag's name: ${outcomeOf(duplicate)}; name now that of the other tag ${str(afterDuplicate, "name") === otherName}`,
        );
      }
      const deleted = await ctx.http.write("DELETE", `/Tag/${tagId}`, { tier: "write" });
      const tagAfter = await ctx.http.get(`/Tag/${tagId}`);
      markIfGone(ctx, "Tag", tagId, tagAfter);
      const relationsAfter = await relationsOf(ctx, tagId);
      const invoiceAfter = await ctx.http.get(`/Invoice/${first.id}`);
      const again = await ctx.http.write("DELETE", `/Tag/${tagId}`, { tier: "write" });
      lines.push(
        `DELETE the used tag: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; tag afterwards ${presence(tagAfter)}; ${describeRelations(relationsAfter)} left; ` +
          `invoice ${first.id} ${presence(invoiceAfter)}; second DELETE ${outcomeOf(again)}`,
      );
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-tag-list-filters",
    title: "Tag filters on the invoice, voucher, order and credit note lists",
    mode: "write",
    question:
      "Do GET /Invoice, /Voucher, /Order and /CreditNote filter by tag on the server, and with which parameters (tag[id]+tag[objectName], tags[0][id]+tags[0][objectName], tags, tag)? " +
      "Each list is checked against one tagged and one untagged draft of this run.",
    deviations: ["D-090"],
    async run(ctx) {
      const name = tagName(ctx, "Liste");
      const lines: string[] = [];
      let honouredAny = false;
      for (const kind of DOCUMENT_KINDS) {
        const tagged = await draftOf(ctx, kind, "tag filter");
        const control = await draftOf(ctx, kind, "tag filter control");
        if (tagged.id === undefined || control.id === undefined) {
          lines.push(`${kind}: ${tagged.failure || control.failure}`);
          continue;
        }
        const result = await tagByName(ctx, name, kind, tagged.id);
        const tagId = result.tagId;
        if (tagId === undefined) {
          lines.push(`${kind}: Tag/Factory/create ${outcomeOf(result.result)}`);
          continue;
        }
        const candidates: readonly { readonly label: string; readonly query: Query }[] = [
          { label: "tag[id]", query: { "tag[id]": tagId, "tag[objectName]": "Tag" } },
          { label: "tags[0][id]", query: { "tags[0][id]": tagId, "tags[0][objectName]": "Tag" } },
          { label: "tags", query: { tags: tagId } },
          { label: "tag", query: { tag: tagId } },
        ];
        const outcomes: string[] = [];
        for (const candidate of candidates) {
          const outcome = await filterOutcome(
            ctx,
            `/${kind}`,
            candidate.query,
            new Set([tagged.id]),
            new Set([control.id]),
          );
          if (outcome.honoured) honouredAny = true;
          outcomes.push(`${candidate.label} ${outcome.text}`);
        }
        lines.push(`${kind} (tagged ${tagged.id}, control ${control.id}): ${outcomes.join("; ")}`);
      }
      return {
        verdict: lines.length === 0 ? "inconclusive" : "observed",
        finding: `${lines.join(". ")}.${honouredAny ? "" : " No parameter was honoured."}`,
      };
    },
  },
  {
    id: "write-cost-centre-create",
    title: "Creating a cost centre through the undocumented POST /CostCentre",
    mode: "write",
    question:
      "Can a cost centre be created through POST /CostCentre (name, number), what does the answer and a read of it look like, and does it appear in GET /CostCentre? " +
      "(Without it the cost-centre probes use a hand-made cost centre named MCP-E2E….)",
    deviations: ["D-024", "D-091"],
    async run(ctx) {
      const choice = await probeCostCentre(ctx);
      const lines = [
        `POST /CostCentre: ${outcomeOf(choice.createResult)}, answer ${shapeOf(choice.createResult.objects)}`,
        choice.note,
      ];
      if (choice.id !== undefined) {
        const row = await ctx.read.byId("CostCentre", choice.id);
        const list = await ctx.read.page("/CostCentre", undefined, 1000);
        lines.push(
          `GET /CostCentre/{id}: keys ${keysOf(row).join(", ") || "none (unreadable)"}; listed in GET /CostCentre: ${rowIds(list.rows).includes(choice.id)}`,
        );
      }
      return {
        verdict: choice.id === undefined ? "inconclusive" : "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
  {
    id: "write-cost-centre-documents",
    title: "costCentre on saveInvoice, saveVoucher, saveOrder and saveCreditNote",
    mode: "write",
    question:
      "Do saveInvoice, saveVoucher, saveOrder (AN) and saveCreditNote keep costCentre on create, take it on an update with the id, and keep it on a later update with the id that leaves it out (invoices, orders and credit notes: only the id and a new header; vouchers: the full probe header, as the voucher tools send it)? How does a read show it?",
    deviations: ["D-052", "D-092"],
    async run(ctx) {
      const choice = await probeCostCentre(ctx);
      if (choice.id === undefined) return inconclusive(choice.note);
      const costCentre = ref("CostCentre", choice.id);
      const lines = [
        `Using ${choice.created ? "the run's" : "the hand-made"} cost centre ${choice.id}`,
      ];
      let keptOnCreate = 0;
      for (const kind of DOCUMENT_KINDS) {
        const withCentre = await draftOf(ctx, kind, "cost centre create", { costCentre });
        let created = withCentre.failure;
        if (withCentre.id !== undefined) {
          const row = await ctx.read.byId(kind, withCentre.id);
          if (refId(row, "costCentre") === choice.id) keptOnCreate += 1;
          created = `created with it → ${describeRef(row, "costCentre")}`;
        }
        const plain = await draftOf(ctx, kind, "cost centre update");
        if (plain.id === undefined) {
          lines.push(`${kind}: ${created}; update: ${plain.failure}`);
          continue;
        }
        const set = await saveWithId(ctx, kind, plain.id, { costCentre }, "cost centre update");
        const afterSet = await costCentreOf(ctx, kind, plain.id);
        const omit = await saveWithId(
          ctx,
          kind,
          plain.id,
          kind === "Voucher" ? {} : { header: `${data(ctx).tag} ${kind} cost centre omitted` },
          "cost centre update",
        );
        const afterOmit = await costCentreOf(ctx, kind, plain.id);
        lines.push(
          `${kind}: ${created}; update with id setting it ${outcomeOf(set)} → ${afterSet}; update with id leaving it out ${outcomeOf(omit)} → ${afterOmit}`,
        );
      }
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}. Kept on create: ${keptOnCreate} of ${DOCUMENT_KINDS.length}.`,
        deviations: { "D-052": "informs" },
      };
    },
  },
  {
    id: "write-cost-centre-list-filters",
    title: "Cost-centre filters on the invoice and voucher lists",
    mode: "write",
    question:
      "Do GET /Invoice and /Voucher filter by cost centre on the server, and with which parameters (costCentre[id]+costCentre[objectName], costCentre)? " +
      "Each list is checked against one draft with the cost centre and one without.",
    deviations: ["D-092"],
    async run(ctx) {
      const choice = await probeCostCentre(ctx);
      if (choice.id === undefined) return inconclusive(choice.note);
      const centreId = choice.id;
      const lines: string[] = [];
      for (const kind of ["Invoice", "Voucher"] as const) {
        const withCentre = await draftOf(ctx, kind, "cost centre filter", {
          costCentre: ref("CostCentre", centreId),
        });
        const control = await draftOf(ctx, kind, "cost centre filter control");
        if (withCentre.id === undefined || control.id === undefined) {
          lines.push(`${kind}: ${withCentre.failure || control.failure}`);
          continue;
        }
        const stored = await costCentreOf(ctx, kind, withCentre.id);
        const outcomes: string[] = [];
        for (const candidate of [
          {
            label: "costCentre[id]",
            query: { "costCentre[id]": centreId, "costCentre[objectName]": "CostCentre" },
          },
          { label: "costCentre", query: { costCentre: centreId } },
        ] as const) {
          const outcome = await filterOutcome(
            ctx,
            `/${kind}`,
            candidate.query,
            new Set([withCentre.id]),
            new Set([control.id]),
            // Other drafts of the run carry the same cost centre: they belong in the answer.
            (row) => refId(row, "costCentre") === centreId,
          );
          outcomes.push(`${candidate.label} ${outcome.text}`);
        }
        lines.push(
          `${kind} (with ${withCentre.id}, stored ${stored}; control ${control.id}): ${outcomes.join("; ")}`,
        );
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-cost-centre-delete",
    title: "DELETE /CostCentre/{id}: an unused one and one a draft voucher uses",
    mode: "write",
    question:
      "Can a cost centre the probe created itself be deleted through DELETE /CostCentre/{id}, unused and while a draft voucher uses it (refused, or the voucher's costCentre cleared), and is a second DELETE a 404? " +
      "Never touches a cost centre made in the web app.",
    deviations: ["D-024", "D-091", "D-085"],
    async run(ctx) {
      const unused = await createCostCentre(ctx, "KST frei", "B");
      if (unused.id === undefined) {
        return inconclusive(
          `POST /CostCentre ${outcomeOf(unused.result)}: nothing of the probe's own to delete.`,
        );
      }
      const lines: string[] = [];
      const deleted = await ctx.http.write("DELETE", `/CostCentre/${unused.id}`, { tier: "write" });
      const after = await ctx.http.get(`/CostCentre/${unused.id}`);
      markIfGone(ctx, "CostCentre", unused.id, after);
      const again = await ctx.http.write("DELETE", `/CostCentre/${unused.id}`, { tier: "write" });
      lines.push(
        `DELETE unused cost centre ${unused.id}: ${outcomeOf(deleted)}, answer ${shapeOf(deleted.objects)}; GET afterwards ${presence(after)}; second DELETE ${outcomeOf(again)}`,
      );
      const used = await createCostCentre(ctx, "KST belegt", "C");
      if (used.id === undefined) {
        lines.push(`second POST /CostCentre ${outcomeOf(used.result)}`);
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}.`,
          deviations: { "D-024": "informs" },
        };
      }
      const voucher = await draftOf(ctx, "Voucher", "cost centre delete", {
        costCentre: ref("CostCentre", used.id),
      });
      if (voucher.id === undefined) {
        lines.push(`voucher with the cost centre: ${voucher.failure}`);
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}.`,
          deviations: { "D-024": "informs" },
        };
      }
      const before = await costCentreOf(ctx, "Voucher", voucher.id);
      const usedDeleted = await ctx.http.write("DELETE", `/CostCentre/${used.id}`, {
        tier: "write",
      });
      const usedAfter = await ctx.http.get(`/CostCentre/${used.id}`);
      markIfGone(ctx, "CostCentre", used.id, usedAfter);
      const voucherAfter = await costCentreOf(ctx, "Voucher", voucher.id);
      lines.push(
        `DELETE cost centre ${used.id} used by voucher ${voucher.id} (${before}): ${outcomeOf(usedDeleted)}; cost centre afterwards ${presence(usedAfter)}; voucher costCentre now ${voucherAfter}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
  {
    id: "write-voucher-position-cost-centre",
    title: "A cost centre on a voucher position, other than the head's",
    mode: "write",
    question:
      "Can a voucher position carry a cost centre of its own (#119)? Two tagged cost centres; a draft voucher (saveVoucher, status 50) with cost centre A on the head and B on its one position, and a second one with B on the position only. " +
      "Which cost centre do the voucher and GET /VoucherPos read back (B, A, none)? Both vouchers and both cost centres are deleted at the end, also when a step fails.",
    deviations: ["D-092", "D-091"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      return withCleanup(
        () => positionCostCentres(ctx, own),
        () => cleanupOwn(ctx, own),
      );
    },
  },
  {
    id: "write-tag-name-matching",
    title:
      "Tag names sevDesk may fold (ß, ligatures, invisible characters, spaces) and two tag filters",
    mode: "write",
    question:
      "Does Tag/Factory/create reuse a tag whose name differs only by ß/ss, the ligature U+FB01 for fi, a zero-width space, a soft hyphen or a doubled inner space (#105; case and é/e are recorded, D-088)? " +
      "Per pair: the same tag id or a new one, the variant's stored name compared with both names sent (as sent, as the base, other; lengths only), and whether GET /Tag?name=<variant> finds either tag. " +
      "Then GET /Invoice with tags[0] and tags[1] (D-090 recorded tags[0] only) against three drafts (first tag only, second only, both) and two untagged ones: AND, OR, one of them, or ignored? Every tag and draft is deleted at the end, also when a step fails.",
    deviations: ["D-088", "D-090"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      return withCleanup(
        () => tagNameMatching(ctx, own),
        () => cleanupOwn(ctx, own),
      );
    },
  },
  {
    id: "write-tag-relation-paging",
    title: "Is the unfiltered GET /TagRelation stable across offsets?",
    mode: "write",
    question:
      "Is an unfiltered GET /TagRelation stable across offsets (#119: the tag breakdown reads it in pages)? After six tagged relations (two tags on three drafts), the list is read with limit 1000 twice and in pages of 3 over its first 60 rows: " +
      "do the pages give the same ids in the same order (none missing, none twice), are the ids ascending, and where do the run's relations sit? Ids and counts only; every tag and draft is deleted at the end, also when a step fails.",
    deviations: ["D-088", "D-090"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      return withCleanup(
        () => tagRelationPaging(ctx, own),
        () => cleanupOwn(ctx, own),
      );
    },
  },
  {
    id: "write-contact-name-search",
    title: "GET /Contact?name=: case, parts of a name, persons",
    mode: "write",
    question:
      "Is the name filter of GET /Contact a case-insensitive search for a part of the shown name (#102)? For a tagged organisation and a tagged person: the full name, lower and upper case, a middle part, the person's familyname, " +
      "its shown name (first last), its first name alone, each with depth=1, and the full names without depth (D-020: organisations only). Found or not per variant; both contacts are deleted at the end, also when a step fails.",
    deviations: ["D-020"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      return withCleanup(
        () => contactNameSearch(ctx, own),
        () => cleanupOwn(ctx, own),
      );
    },
  },
  {
    id: "write-contact-delete-cascade",
    title: "Deleting an organisation: its contact persons, and a person a draft names",
    mode: "write",
    question:
      "What does DELETE /Contact/{id} do to an organisation's contact persons (#134, #108)? (a) An organisation with two persons under it (parent) and no document: the answer, and whether the persons are still there (and their parent). " +
      "(b) An organisation with one person under it whom a draft invoice names as its contact: is the delete refused (D-085: possibly inside HTTP 200), or does it go through, and what happens to the organisation, the person and the draft? " +
      "Everything left is deleted at the end (the draft, then the persons, then the organisations), also when a step fails.",
    deviations: ["D-084", "D-085", "D-083"],
    async run(ctx) {
      const documents: OwnRecord[] = [];
      const persons: OwnRecord[] = [];
      const orgs: OwnRecord[] = [];
      return withCleanup(
        () => contactDeleteCascade(ctx, documents, persons, orgs),
        () => deleteOwn(ctx, [...documents, ...persons, ...orgs]),
      );
    },
  },
  {
    id: "read-customer-number-availability",
    title: "checkCustomerNumberAvailability: a used, a changed-case and a free number",
    mode: "read",
    question:
      "What does GET /Contact/Mapper/checkCustomerNumberAvailability answer (shape) for a customer number a contact has, the same in lower case, a free number, and no number?",
    deviations: ["D-087"],
    async run(ctx) {
      const taken = (await ctx.read.page("/Contact", { depth: 1 }, 100)).rows
        .map((row) => str(row, "customerNumber"))
        .find((number) => number !== "");
      const path = "/Contact/Mapper/checkCustomerNumberAvailability";
      const describe = (result: HttpResult) =>
        result.ok
          ? typeof result.objects === "boolean" || result.objects === null
            ? `answers ${JSON.stringify(result.objects)}`
            : `answers ${shapeOf(result.objects)}`
          : outcomeOf(result);
      const lines: string[] = [];
      if (taken !== undefined) {
        lines.push(
          `a used number: ${describe(await ctx.http.get(path, { customerNumber: taken }))}`,
        );
        if (taken.toLowerCase() !== taken) {
          lines.push(
            `the same in lower case: ${describe(await ctx.http.get(path, { customerNumber: taken.toLowerCase() }))}`,
          );
        }
      }
      lines.push(
        `a free number: ${describe(await ctx.http.get(path, { customerNumber: `MCP-FREE-${ctx.nowSeconds}` }))}`,
      );
      lines.push(`no number: ${describe(await ctx.http.get(path))}`);
      return {
        verdict: taken === undefined ? "inconclusive" : "observed",
        finding: `${taken === undefined ? "No contact with a customer number. " : ""}${lines.join("; ")}.`,
      };
    },
  },
  {
    id: "read-tag-lists",
    title: "GET /Tag and /TagRelation: shape, paging, name filter",
    mode: "read",
    question:
      "Which keys do GET /Tag and GET /TagRelation rows have (a usage count?), do they honour limit and the documented name filter, and which object types do relations point to?",
    deviations: ["D-088"],
    async run(ctx) {
      const tags = await ctx.read.page("/Tag", undefined, 1000);
      if (!tags.result.ok) {
        return { verdict: "observed", finding: `GET /Tag ${outcomeOf(tags.result)}.` };
      }
      const lines = [
        `GET /Tag: ${tags.rows.length} row(s), total ${tags.total ?? "none"}, keys ${keysOf(tags.rows).join(", ") || "none"}`,
      ];
      const one = await ctx.read.page("/Tag", undefined, 1);
      lines.push(`limit=1: ${one.rows.length} row(s)`);
      const first = tags.rows[0];
      const firstName = str(first, "name");
      if (first !== undefined && firstName !== "") {
        const named = await ctx.read.page("/Tag", { name: firstName }, 1000);
        const same = named.rows.filter((row) => str(row, "name") === firstName).length;
        lines.push(
          `name filter: ${named.result.ok ? `${named.rows.length} row(s), ${same} with that name (${same === named.rows.length && same > 0 ? "honoured" : "ignored"})` : outcomeOf(named.result)}`,
        );
      }
      const relations = await ctx.read.page("/TagRelation", undefined, 1000);
      const kinds = new Map<string, number>();
      for (const row of relations.rows) {
        const kind = str(firstRow(row["object"]), "objectName") || "?";
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      const oneRelation = await ctx.read.page("/TagRelation", undefined, 1);
      lines.push(
        `GET /TagRelation: ${relations.result.ok ? `${relations.rows.length} row(s), total ${relations.total ?? "none"}, keys ${keysOf(relations.rows).join(", ") || "none"}, objects ${[...kinds].map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}; limit=1: ${oneRelation.rows.length} row(s)` : outcomeOf(relations.result)}`,
      );
      return {
        verdict: tags.rows.length === 0 ? "inconclusive" : "observed",
        finding: `${tags.rows.length === 0 ? "No tags on the account. " : ""}${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "read-cost-centre-list",
    title: "GET /CostCentre (undocumented): shape and paging",
    mode: "read",
    question:
      "Does the undocumented GET /CostCentre answer, with which row keys and total, does it honour limit and offset, and does GET /CostCentre/{id} answer one row?",
    deviations: ["D-024", "D-091"],
    async run(ctx) {
      const all = await ctx.read.page("/CostCentre", undefined, 1000);
      if (!all.result.ok) {
        return {
          verdict: "observed",
          finding: `GET /CostCentre ${outcomeOf(all.result)}.`,
          deviations: { "D-024": "informs" },
        };
      }
      const lines = [
        `GET /CostCentre: ${all.rows.length} row(s), total ${all.total ?? "none"}, keys ${keysOf(all.rows).join(", ") || "none"}`,
      ];
      const one = await ctx.read.page("/CostCentre", undefined, 1);
      const second = await ctx.http.get("/CostCentre", { limit: 1, offset: 1 });
      const secondIds =
        second.ok && second.objects !== undefined && second.objects !== null
          ? rowIds(rowsOf(second.objects))
          : [];
      lines.push(
        `limit=1: ${one.rows.length} row(s); offset=1: ${second.ok ? `row ${secondIds[0] ?? "none"} (the second of the full list: ${secondIds[0] !== undefined && secondIds[0] === rowIds(all.rows)[1]})` : outcomeOf(second)}`,
      );
      const id = rowIds(all.rows)[0];
      if (id !== undefined) {
        const byId = await ctx.http.get(`/CostCentre/${id}`);
        lines.push(`GET /CostCentre/{id}: ${byId.ok ? shapeOf(byId.objects) : outcomeOf(byId)}`);
      }
      return {
        verdict: all.rows.length === 0 ? "inconclusive" : "observed",
        finding: `${all.rows.length === 0 ? "No cost centres on the account. " : ""}${lines.join(". ")}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
];
