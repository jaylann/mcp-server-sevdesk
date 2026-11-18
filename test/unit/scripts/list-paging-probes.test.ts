import { describe, expect, it } from "vitest";

import { ALL_PROBES } from "../../../scripts/lib/probes/catalog.js";
import { berlinMidnight } from "../../../scripts/lib/probes/core.js";
import {
  ADDRESS_SEED_COUNT,
  LIST_PAGING_BUDGET,
  LIST_PAGING_PROBES,
  LIST_PAGING_SEED_COUNT,
  listPagingCases,
  orderText,
} from "../../../scripts/lib/probes/list-paging-probes.js";
import { renderReport } from "../../../scripts/lib/probes/report.js";
import { type RunOptions, runProbes } from "../../../scripts/lib/probes/runner.js";
import { assertNoSecrets, createScrubber } from "../../../scripts/lib/scrub.js";
import { documentDateFilter } from "../../../src/domain/common.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type ScriptedCall, ScriptedClient } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TAG = "MCP-E2E 20261120-1000-abcd";
const TODAY = "2026-11-20";
const READ = "read-list-paging-order";
const SEED = "write-list-paging-seed";
const ADDRESS_SEED = "write-contact-address-paging-seed";

type Rec = Record<string, unknown>;

/**
 * How a simulated list orders its rows (synthetic; the order is what the probes measure). Every
 * mode lists newest id first for one page of 1000, and an explicit order parameter (documented or
 * `orderBy[0][field]`) lists ascending ids on every page size.
 * - `stable`: every page size gives that order.
 * - `byPageSize`: pages smaller than 1000 swap the first two rows, the same on every read: every
 *   row once, in another order.
 * - `skips`: pages from offset 5 on swap the rows at positions 4 and 5, so a paged read gets one
 *   row twice and never the other.
 */
type PagingMode = "stable" | "byPageSize" | "skips";

interface ListSettings {
  /** Rows per list path (default {@link ListSettings.rows}). */
  readonly rows?: number;
  readonly perPath?: Readonly<Record<string, number>>;
  readonly modes?: Readonly<Record<string, PagingMode>>;
  /** List paths that answer 500. */
  readonly refuse?: readonly string[];
  /** The `saveInvoice` call (1-based) the account refuses. */
  readonly refuseInvoiceAt?: number;
  /** The `POST /ContactAddress` call (1-based) the account refuses. */
  readonly refuseAddressAt?: number;
}

function refuse(status: number, upstreamMessage: string): never {
  throw new SevdeskError({
    kind: status === 404 ? "not_found" : "validation",
    message: "Invalid request",
    status,
    upstreamMessage,
  });
}

const swap = (ids: string[], a: number, b: number): void => {
  const first = ids[a];
  const second = ids[b];
  if (first === undefined || second === undefined) return;
  ids[a] = second;
  ids[b] = first;
};

/** A row with every field the cases look at; dates repeat every 15 rows (ties). */
function row(path: string, id: number, index: number): Rec {
  const date = `2026-11-${String(1 + (index % 15)).padStart(2, "0")}T00:00:00+01:00`;
  return {
    id: String(id),
    objectName: path.slice(1),
    create: date,
    update: date,
    invoiceDate: date,
    creditNoteDate: date,
    orderDate: date,
    voucherDate: date,
    valueDate: date,
    entryDate: date,
    bookingDate: date,
    positionNumber: String(index % 3),
    customerNumber: String(1000 + index),
  };
}

/** A whole account: every list path of the cases, and the writes of the seed probe. */
function account(settings: ListSettings = {}) {
  let nextId = 5000;
  let invoiceSaves = 0;
  let addressSaves = 0;
  const lists = new Map<string, Rec[]>();
  const listOf = (path: string): Rec[] => {
    let rows = lists.get(path);
    if (rows === undefined) {
      const count = settings.perPath?.[path] ?? settings.rows ?? 0;
      rows = Array.from({ length: count }, (_, index) => row(path, nextId++, index));
      lists.set(path, rows);
    }
    return rows;
  };
  const add = (path: string): string => {
    const rows = listOf(path);
    const added = row(path, nextId++, rows.length);
    rows.push(added);
    return String(added["id"]);
  };
  const ordered = (path: string, query: Readonly<Record<string, unknown>>): Rec[] => {
    const rows = [...listOf(path)].sort((a, b) => Number(b["id"]) - Number(a["id"]));
    if (Object.keys(query).some((key) => key.startsWith("orderBy"))) return rows.reverse();
    if (Number(query["limit"]) >= 1000) return rows;
    const ids = rows.map((item) => String(item["id"]));
    const mode = settings.modes?.[path] ?? "stable";
    if (mode === "byPageSize") swap(ids, 0, 1);
    if (mode === "skips" && Number(query["offset"]) >= 5) swap(ids, 4, 5);
    return ids.map((id) => rows.find((item) => item["id"] === id) ?? {});
  };
  const handler = (call: ScriptedCall): unknown => {
    const { method, path, query } = call;
    if (path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
    if (path === "/SevUser") return { total: "1", objects: [{ id: "7", objectName: "SevUser" }] };
    if (method === "POST" && path === "/Contact") {
      return { objects: { id: add("/Contact"), objectName: "Contact" } };
    }
    if (method === "POST" && path === "/ContactAddress") {
      addressSaves += 1;
      if (addressSaves === settings.refuseAddressAt)
        refuse(422, "Refused by the simulated account");
      return { objects: { id: add("/ContactAddress"), objectName: "ContactAddress" } };
    }
    if (path === "/Invoice/Factory/saveInvoice") {
      invoiceSaves += 1;
      if (invoiceSaves === settings.refuseInvoiceAt)
        refuse(422, "Refused by the simulated account");
      return { objects: { invoice: { id: add("/Invoice"), objectName: "Invoice" } } };
    }
    if (path === "/CreditNote/Factory/saveCreditNote") {
      return { objects: { creditNote: { id: add("/CreditNote"), objectName: "CreditNote" } } };
    }
    const byId = /^(\/\w+)\/(\d+)$/.exec(path);
    if (byId !== null) {
      const rows = listOf(byId[1] ?? "");
      const index = rows.findIndex((item) => item["id"] === byId[2]);
      if (index === -1) return refuse(404, "not found");
      if (method === "DELETE") {
        rows.splice(index, 1);
        return { objects: [null] };
      }
      return { objects: [rows[index]] };
    }
    if (method !== "GET") return refuse(422, "not simulated");
    if (settings.refuse?.includes(path) === true) refuse(500, "Internal error");
    const rows = ordered(path, query);
    const offset = Number(query["offset"] ?? 0);
    return {
      total: String(rows.length),
      objects: rows.slice(offset, offset + Number(query["limit"] ?? 100)),
    };
  };
  return { client: new ScriptedClient(handler), lists };
}

function options(client: ScriptedClient, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    client,
    scrubber: createScrubber({ secrets: [TOKEN] }),
    probes: ALL_PROBES,
    allowWrites: false,
    tag: TAG,
    today: TODAY,
    nowSeconds: Date.parse(`${TODAY}T09:00:00Z`) / 1000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    ...overrides,
  };
}

async function run(client: ScriptedClient, overrides: Partial<RunOptions> = {}) {
  const report = await runProbes(options(client, { only: [READ], ...overrides }));
  const result = report.results.find((item) => item.id === (overrides.only?.[0] ?? READ));
  return { report, status: result?.status, finding: result?.finding ?? "" };
}

/** The list reads of the probes (every GET but the version, by-id reads and the SevUser lookup). */
function listCalls(client: ScriptedClient): ScriptedCall[] {
  return client.calls.filter(
    (call) =>
      call.method === "GET" &&
      call.path !== "/Tools/bookkeepingSystemVersion" &&
      call.path !== "/SevUser" &&
      !/\/\d+$/.test(call.path),
  );
}

describe("list paging probe catalog (#162)", () => {
  it("registers every probe once, opt-in, the seeds as the writes", () => {
    const ids = ALL_PROBES.map((probe) => probe.id);
    for (const probe of LIST_PAGING_PROBES) {
      expect(
        ids.filter((id) => id === probe.id),
        probe.id,
      ).toHaveLength(1);
      expect(probe.id.startsWith(`${probe.mode}-`), probe.id).toBe(true);
      expect(probe.optIn, probe.id).toBe(true);
      expect(probe.deviations, probe.id).toContain("D-100");
    }
    expect(LIST_PAGING_PROBES.map((probe) => [probe.id, probe.mode])).toEqual([
      [READ, "read"],
      [SEED, "write"],
      [ADDRESS_SEED, "write"],
    ]);
  });

  it("runs only when selected", async () => {
    const { client } = account({ rows: 30 });
    // A run without --only, writes allowed: every one is left out.
    const report = await runProbes(
      options(client, { probes: LIST_PAGING_PROBES, allowWrites: true }),
    );
    expect(report.results.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
    const result = report.results.find((item) => item.id === READ);
    expect(result).toMatchObject({ status: "skipped", finding: `opt-in: run with --only ${READ}` });
    expect(listCalls(client)).toEqual([]);
  });

  it("sends each reader's own query: filters, embed and depth as the code does", () => {
    const cases = listPagingCases(TODAY);
    const names = cases.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    const byName = (name: string) => cases.find((item) => item.name === name);
    expect(byName("invoices_list")).toMatchObject({
      path: "/Invoice",
      query: { embed: "contact" },
    });
    expect(byName("open invoices (aging, reconcile_suggest)")?.query).toEqual({
      embed: "contact",
      status: 200,
    });
    expect(byName("records_summarize invoices (range)")?.query).toEqual({
      embed: "contact",
      ...documentDateFilter({ from: "2024-11-20", to: "2026-12-21" }).query,
    });
    expect(byName("contacts_search")?.query).toEqual({ depth: "1" });
    expect(byName("open transactions (rule estimate)")?.query).toEqual({ status: 100 });
    expect(byName("open expense vouchers (aging, reconcile_suggest)")?.query).toEqual({
      status: 100,
      creditDebit: "C",
      voucherType: "VOU",
    });
    expect(byName("changed_since invoices")?.query).toEqual({
      showAll: "true",
      updateAfter: berlinMidnight("2024-11-20") - 1,
    });
    expect(byName("transaction log (readWholeLog)")).toMatchObject({
      path: "/CheckAccountTransactionLog",
      query: {},
    });
    // The client adds limit, offset and countAll; a case never carries them itself.
    for (const item of cases) {
      expect(item.query, item.name).not.toHaveProperty("limit");
      expect(item.query, item.name).not.toHaveProperty("offset");
      expect(item.query, item.name).not.toHaveProperty("countAll");
    }
    // Every list #162 names is among the paths.
    expect(new Set(cases.map((item) => item.path))).toEqual(
      new Set([
        "/Invoice",
        "/CreditNote",
        "/Order",
        "/Voucher",
        "/CheckAccountTransaction",
        "/CheckAccountTransactionLog",
        "/Contact",
        "/ContactAddress",
        "/CommunicationWay",
        "/Part",
        "/Tag",
        "/TagRelation",
        "/InvoicePos",
        "/CreditNotePos",
        "/OrderPos",
        "/VoucherPos",
        "/AccountDatev",
        "/PrivateTransactionRule",
      ]),
    );
  });

  it("names the field a page runs by and the rows that tie on it", () => {
    const rows = [
      { id: "9", voucherDate: "2026-11-03", create: "2026-11-01" },
      { id: "4", voucherDate: "2026-11-03", create: "2026-11-02" },
      { id: "7", voucherDate: "2026-11-01", create: "2026-11-02" },
    ];
    expect(orderText(rows, [{ field: "voucherDate", kind: "date" }])).toBe(
      "order: voucherDate descending (2 rows tie), create ascending (2 rows tie), id mixed (1 steps up, 1 down); apparent sort key voucherDate descending, 2 rows tie on it",
    );
    expect(orderText([{ id: "1" }, { id: "2" }], [])).toBe(
      "order: id ascending; apparent sort key id ascending, 0 rows tie on it (a total order)",
    );
    expect(orderText([{ id: "2" }, { id: "1" }, { id: "3" }], [])).toBe(
      "order: id mixed (1 steps up, 1 down); no field here runs one way",
    );
  });
});

describe("read-list-paging-order (#162)", () => {
  it("compares every list with explicit limits and says plainly when all are stable", async () => {
    const { client } = account({ rows: 30 });
    const { report, status, finding } = await run(client);
    expect(status).toBe("observed");
    expect(client.writes()).toEqual([]);
    expect(finding).toMatch(
      /^Answer per list, pages of 5 against one page of 1000: stable \(the same rows in the same order, both passes\): invoices_list, open invoices/,
    );
    expect(finding).not.toMatch(/NOT stable|too few|not compared/);
    expect(finding).toContain(
      "invoices_list: GET /Invoice (embed=contact; read by sevdesk_invoices_list",
    );
    expect(finding).toContain(
      "one page (limit 1000) 30 rows, total 30, order: invoiceDate mixed (1 steps up, 28 down) (30 rows tie), create mixed (1 steps up, 28 down) (30 rows tie), update mixed (1 steps up, 28 down) (30 rows tie), id descending; apparent sort key id descending, 0 rows tie on it (a total order); ",
    );
    expect(finding).toContain(
      "pages of 5 over all 30 rows: first pass 30 rows, the same rows in the same order as the one page; second pass 30 rows, the same rows in the same order as the one page; the two passes gave the same ids in the same order",
    );
    const calls = listCalls(client);
    const cases = listPagingCases(TODAY);
    // One page and two passes of 6 pages per case; no explicit order while every list is stable.
    expect(calls).toHaveLength(cases.length * 13);
    expect(finding).toContain(`${cases.length * 13} GETs of a budget of ${LIST_PAGING_BUDGET}`);
    for (const call of calls) {
      expect([5, 1000]).toContain(call.query["limit"]);
      expect(Number(call.query["offset"]) % 5).toBe(0);
      expect(call.query["countAll"]).toBe(true);
      expect(Object.keys(call.query).some((key) => key.startsWith("orderBy"))).toBe(false);
    }
    for (const item of cases) {
      const own = calls.filter(
        (call) =>
          call.path === item.path &&
          Object.entries(item.query).every(([key, value]) => call.query[key] === value) &&
          Object.keys(call.query).length === Object.keys(item.query).length + 3,
      );
      expect(own.length, item.name).toBe(13);
    }
    const markdown = renderReport(report);
    assertNoSecrets(markdown, [TOKEN]);
  });

  it("tells a page-size order that keeps every row from paging that skips rows, and tries the documented orders", async () => {
    const { client } = account({
      rows: 30,
      modes: { "/Invoice": "byPageSize", "/CheckAccountTransaction": "skips" },
    });
    const { status, finding } = await run(client);
    expect(status).toBe("observed");
    expect(finding).toMatch(
      /^Answer per list, pages of 5 against one page of 1000: NOT stable \(rows skipped or repeated\): transactions_list, open transactions \(rule estimate\); every row once, but not in the order of one page: invoices_list, open invoices \(aging, reconcile_suggest\), records_summarize invoices \(range\), partially paid invoices \(aging, reconcile_suggest\), changed_since invoices; stable/,
    );
    expect(finding).toContain(
      "first pass 30 rows, NOT the rows of the one page: 1 missing, 1 repeated, 0 not on the one page",
    );
    expect(finding).toContain(
      "first pass 30 rows, every row of the one page exactly once, but in another order (from position 1 on)",
    );
    // The documented order of invoices and the generic one, each with one page and one pass.
    expect(finding).toContain(
      "orderByInvoiceNumber=ASC (documented in the spec): one page 30 rows, order: invoiceDate mixed",
    );
    expect(finding).toMatch(
      /orderByInvoiceNumber=ASC \(documented in the spec\): [^.]*apparent sort key id ascending[^.]*another order than without it; pages of 5: the same rows in the same order as the one page/,
    );
    expect(finding).toMatch(
      /orderBy\[0\]\[field\]=id, orderBy\[0\]\[arrangement\]=asc \(not in the spec\): one page 30 rows/,
    );
    const ordered = listCalls(client).filter((call) =>
      Object.keys(call.query).some((key) => key.startsWith("orderBy")),
    );
    // 5 invoice cases × 2 orders and 2 transaction cases × 1, each one page and 6 pages of 5.
    expect(ordered).toHaveLength((5 * 2 + 2) * 7);
    expect(ordered.filter((call) => call.query["orderByInvoiceNumber"] === "ASC")).toHaveLength(
      5 * 7,
    );
  });

  it("marks short lists as too few to tell, and is inconclusive when no list could be compared", async () => {
    const { client } = account({ rows: 11 });
    const { status, finding } = await run(client);
    expect(status).toBe("inconclusive");
    expect(finding).toMatch(
      /^Answer per list, pages of 5 against one page of 1000: too few rows to tell: invoices_list, /,
    );
    expect(finding).toContain(
      "one page (limit 1000) 11 rows, total 11: too few rows to tell (the comparison needs 12)",
    );
    expect(finding).toContain("write-list-paging-seed creates 25 tagged contacts");
    expect(listCalls(client)).toHaveLength(listPagingCases(TODAY).length);
  });

  it("reports a refused list as not compared and goes on with the others", async () => {
    const { client } = account({ rows: 30, refuse: ["/Contact"] });
    const { status, finding } = await run(client);
    expect(status).toBe("observed");
    expect(finding).toMatch(
      /not compared \(refused, stopped or over the request budget\): contacts_search, changed_since contacts\./,
    );
    expect(finding).toContain(
      "contacts_search: GET /Contact (depth=1; read by sevdesk_contacts_search (nextOffset), audit parties (scanPages), e-invoice voucher-suggestion loadContactIndex (listAll, pages of 1000); contacts-write and contacts-delete send this with name or parent[id]): one page (limit 1000) refused (500: Internal error)",
    );
  });

  it("pages long lists over their first 60 rows and stays within the request budget", async () => {
    const { client } = account({ rows: 400 });
    const { status, finding } = await run(client);
    expect(status).toBe("observed");
    expect(finding).toContain("one page (limit 1000) 400 rows, total 400");
    expect(finding).toContain(
      "pages of 5 over the first 60 of 400 rows: first pass 60 rows, the same rows in the same order as the one page",
    );
    // 25 GETs per case: 20 cases fit into 500; the rest are reported, not read.
    const calls = listCalls(client);
    expect(calls.length).toBeLessThanOrEqual(LIST_PAGING_BUDGET);
    expect(calls).toHaveLength(LIST_PAGING_BUDGET);
    expect(Math.max(...calls.map((call) => Number(call.query["offset"])))).toBe(55);
    expect(finding).toContain(`${LIST_PAGING_BUDGET} GETs of a budget of ${LIST_PAGING_BUDGET}`);
    expect(finding).toMatch(/: not read, the request budget was used up/);
    expect(finding).toMatch(/not compared \(refused, stopped or over the request budget\): /);
  });
});

describe("write-list-paging-seed (#162)", () => {
  it(`seeds ${LIST_PAGING_SEED_COUNT} tagged contacts, invoices and credit notes, compares them and deletes them all`, async () => {
    const { client, lists } = account({
      modes: { "/Invoice": "skips", "/Contact": "byPageSize" },
    });
    const { report, status, finding } = await run(client, { only: [SEED], allowWrites: true });
    expect(status).toBe("observed");
    expect(finding).toMatch(
      /^Answer per list, pages of 5 against one page of 1000: NOT stable \(rows skipped or repeated\): seeded draft invoices; every row once, but not in the order of one page: seeded contacts; stable \(the same rows in the same order, both passes\): seeded draft credit notes\. The probe created 25 tagged contacts, 25 draft invoices and 25 draft credit notes dated 2026-11-20\. /,
    );
    // The run tag never reaches the finding; the seeded contacts plus the run's own contact.
    expect(finding).not.toContain(TAG);
    expect(finding).toContain(
      "seeded contacts: GET /Contact (depth=1&name=<the run tag>; read by contacts_search",
    );
    expect(finding).toContain("one page (limit 1000) 26 rows");
    expect(finding).toMatch(/Cleanup: 75 records deleted\.$/);
    const writes = client.writes();
    expect(
      writes.filter((call) => call.method === "POST" && call.path === "/Contact"),
    ).toHaveLength(LIST_PAGING_SEED_COUNT + 1);
    expect(writes.filter((call) => call.path === "/Invoice/Factory/saveInvoice")).toHaveLength(
      LIST_PAGING_SEED_COUNT,
    );
    expect(
      writes.filter((call) => call.path === "/CreditNote/Factory/saveCreditNote"),
    ).toHaveLength(LIST_PAGING_SEED_COUNT);
    for (const call of writes) expect(call.tier).toBe("write");
    const day = documentDateFilter({ from: TODAY, to: TODAY }).query;
    for (const call of listCalls(client)) {
      if (call.path === "/Contact") expect(call.query).toMatchObject({ depth: "1", name: TAG });
      else expect(call.query).toMatchObject({ embed: "contact", ...day });
    }
    // Every seeded record is gone; only the run's own contact stays (as in every write probe).
    expect(lists.get("/Invoice")).toEqual([]);
    expect(lists.get("/CreditNote")).toEqual([]);
    expect(lists.get("/Contact")).toHaveLength(1);
    const seeded = report.created.filter((record) => record.state === "deleted by the probe");
    expect(seeded).toHaveLength(3 * LIST_PAGING_SEED_COUNT);
  });

  it("deletes what it made when sevDesk refuses a later draft, and compares nothing", async () => {
    const { client, lists } = account({ refuseInvoiceAt: 3 });
    const { status, finding } = await run(client, { only: [SEED], allowWrites: true });
    expect(status).toBe("inconclusive");
    expect(finding).toBe(
      "Draft Invoice 3 of 25: refused (422: Refused by the simulated account). Cleanup: 27 records deleted.",
    );
    expect(lists.get("/Invoice")).toEqual([]);
    expect(lists.get("/Contact")).toHaveLength(1);
    expect(listCalls(client)).toEqual([]);
  });
});

describe("write-contact-address-paging-seed (#164)", () => {
  it(`seeds ${ADDRESS_SEED_COUNT} contacts with an address each, compares GET /ContactAddress as audit parties reads it, and deletes them all`, async () => {
    const { client, lists } = account({
      perPath: { "/ContactAddress": 3 },
      modes: { "/ContactAddress": "skips" },
    });
    const { report, status, finding } = await run(client, {
      only: [ADDRESS_SEED],
      allowWrites: true,
    });
    expect(status).toBe("observed");
    expect(finding).toMatch(
      /^Answer per list, pages of 5 against one page of 1000: NOT stable \(rows skipped or repeated\): contact addresses \(audit parties\)\. The probe created 25 tagged contacts with one German billing address each; /,
    );
    expect(finding).toContain(
      "contact addresses (audit parties): GET /ContactAddress (no filter; read by audit parties listContactAddressLocations (scanPages)): one page (limit 1000) 28 rows, total 28, order: ",
    );
    expect(finding).toMatch(/apparent sort key id descending, 0 rows tie on it \(a total order\)/);
    expect(finding).toContain(
      "first pass 28 rows, NOT the rows of the one page: 1 missing, 1 repeated, 0 not on the one page",
    );
    expect(finding).toMatch(
      /orderBy\[0\]\[field\]=id, orderBy\[0\]\[arrangement\]=asc \(not in the spec\): one page 28 rows, .*another order than without it; pages of 5: the same rows in the same order as the one page/,
    );
    expect(finding).toMatch(/Cleanup: 50 records deleted\.$/);
    expect(finding).not.toContain(TAG);
    // One page and two passes of 6 pages, then the id order with one page and one pass.
    const calls = listCalls(client);
    expect(calls).toHaveLength(13 + 7);
    for (const call of calls) {
      expect(call.path).toBe("/ContactAddress");
      expect([5, 1000]).toContain(call.query["limit"]);
      expect(call.query["countAll"]).toBe(true);
      const filters = Object.keys(call.query).filter(
        (key) => !["limit", "offset", "countAll"].includes(key) && !key.startsWith("orderBy"),
      );
      expect(filters).toEqual([]);
    }
    const writes = client.writes();
    for (const call of writes) expect(call.tier).toBe("write");
    const posts = writes.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.path)).toEqual(
      Array.from({ length: ADDRESS_SEED_COUNT }, () => ["/Contact", "/ContactAddress"]).flat(),
    );
    expect(posts[1]?.body).toEqual({
      contact: { id: expect.any(Number) as unknown, objectName: "Contact" },
      street: `${TAG} Adresse 01`,
      zip: "10115",
      city: "Berlin",
      country: { id: 1, objectName: "StaticCountry" },
      category: { id: 47, objectName: "Category" },
    });
    // Addresses are deleted before their contacts; only the three that were there stay.
    const deletes = writes.filter((call) => call.method === "DELETE").map((call) => call.path);
    expect(deletes).toHaveLength(2 * ADDRESS_SEED_COUNT);
    expect(
      deletes.slice(0, ADDRESS_SEED_COUNT).every((path) => path.startsWith("/ContactAddress/")),
    ).toBe(true);
    expect(lists.get("/ContactAddress")).toHaveLength(3);
    expect(lists.get("/Contact")).toEqual([]);
    expect(report.created.every((record) => record.state === "deleted by the probe")).toBe(true);
    assertNoSecrets(renderReport(report), [TOKEN]);
  });

  it("deletes what it made when sevDesk refuses an address, and compares nothing", async () => {
    const { client, lists } = account({ refuseAddressAt: 3 });
    const { status, finding } = await run(client, { only: [ADDRESS_SEED], allowWrites: true });
    expect(status).toBe("inconclusive");
    expect(finding).toBe(
      "Address 3 of 25: POST /ContactAddress refused (422: Refused by the simulated account). Cleanup: 5 records deleted.",
    );
    expect(lists.get("/ContactAddress")).toEqual([]);
    expect(lists.get("/Contact")).toEqual([]);
    expect(listCalls(client)).toEqual([]);
  });
});
