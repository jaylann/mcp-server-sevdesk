/**
 * Probes for issues #86 (contact persons, deleting contacts and their details, custom contact
 * fields) and #87 (tags and cost centres on documents).
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
 */
import { rowsOf } from "../fixture-plan.js";
import {
  createdId,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
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
  saveVoucherStatus,
  shapeOf,
  voucherHeader,
  voucherPosition,
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
 * recordings showed to keep omitted fields (D-054). Vouchers send their full probe header.
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
    tier: "write",
    body: {
      [key]: { id, objectName: kind, mapAll: true, ...header },
      [`${key}PosSave`]: [],
      [`${key}PosDelete`]: null,
    },
  });
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
