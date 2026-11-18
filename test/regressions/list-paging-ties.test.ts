/**
 * Regression (#162, spec/deviations.md D-146): sevDesk sorts each list by one field (credit notes,
 * invoices and orders by creation time, positions by position number) and breaks ties on it in an
 * order that depends on `limit` and `offset`. On the trial account (2026-11-18, probes
 * `read-list-paging-order` and `write-list-paging-seed`) pages of 5 lost 2 of 25 credit notes of
 * one creation time and gave 2 others twice, and lost 1 of 49 order positions; two passes with the
 * same page size always agreed. A list read past one page with `offset` can therefore skip rows.
 *
 * - The shared page reader (`listAll`) keeps a row once and says when it read more than one page.
 * - A report over a date range reads date windows of one page each and sees every row once.
 * - A read that has to page says it may be incomplete: the credit note number check and the
 *   positions of an order with more positions than one page.
 */
import { describe, expect, it } from "vitest";

import { listDocumentPositions } from "../../src/domain/document-positions.js";
import { findCreditNotesWithNumber } from "../../src/domain/drafts/numbering.js";
import { agingSentence, receivablesAging } from "../../src/domain/reports/aging.js";
import { pagedReadNote } from "../../src/domain/reports/shared.js";
import { summarizeRecords } from "../../src/domain/reports/summarize.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { createFakeClock, jsonResponse } from "../helpers/fake-fetch.js";
import { creditNoteDoc, invoiceDoc } from "../unit/domain/reports/builders.js";

type Raw = Record<string, unknown>;

/** The same moment for every row: the sort key ties on all of them. */
const CREATED = "2026-02-01T10:00:00+01:00";

/**
 * A sevDesk with one tied list per path: the date filter (`startDate`/`endDate`, Unix seconds) on
 * `dateKey`, `total`, and rows that tie on the sort key in an order that depends on `limit` and
 * `offset` (synthetic mix; recorded: the order depends on the page size and paging loses rows).
 */
function tiedSevdesk(lists: Readonly<Record<string, { rows: readonly Raw[]; dateKey?: string }>>) {
  const requests: URL[] = [];
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const list = lists[path];
    if (list === undefined) return Promise.resolve(jsonResponse({ total: 0, objects: [] }));
    const query = url.searchParams;
    const limit = Number(query.get("limit"));
    const offset = Number(query.get("offset"));
    const start = query.get("startDate");
    const end = query.get("endDate");
    const seed = Math.imul(limit * 31 + offset, 0x9e3779b1);
    const tie = (id: number) => Math.imul(id ^ seed, 0x85ebca6b) >>> 0;
    const parent = [...query.keys()].find((key) => key.endsWith("[id]"));
    const rows = list.rows
      .filter((row) => {
        if (parent !== undefined) {
          const ref = row[parent.slice(0, -4)] as { id?: unknown } | undefined;
          if (String(ref?.id) !== query.get(parent)) return false;
        }
        const status = query.get("status");
        if (status !== null && String(row["status"]) !== status) return false;
        if (list.dateKey === undefined) return true;
        const seconds = Date.parse(String(row[list.dateKey])) / 1000;
        return (
          (start === null || seconds >= Number(start)) && (end === null || seconds <= Number(end))
        );
      })
      .map((row) => ({ row, id: Number(row["id"]) }))
      .sort((a, b) => tie(a.id) - tie(b.id));
    return Promise.resolve(
      jsonResponse({
        total: rows.length,
        objects: rows.slice(offset, offset + limit).map((entry) => entry.row),
      }),
    );
  };
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read"]),
      readOnly: true,
      dryRun: false,
      requestsPerSecond: 100_000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, requests };
}

/** `count` credit notes of one creation time, spread over Q1 2026, ids from 1. */
function creditNotes(count: number): Raw[] {
  return Array.from({ length: count }, (_, index) =>
    creditNoteDoc(
      {
        id: index + 1,
        date: `2026-0${String(1 + (index % 3))}-${String(1 + (index % 28)).padStart(2, "0")}`,
        net: "10",
        tax: "1.9",
      },
      { create: CREATED },
    ),
  );
}

const ids = (rows: readonly unknown[]): number[] =>
  rows.map((row) => Number((row as { id?: unknown }).id));

describe("lists whose sort key ties, read past one page (#162, D-146)", { timeout: 30_000 }, () => {
  it("the simulated list does lose rows when read in pages, as recorded", async () => {
    const { client } = tiedSevdesk({ "/CreditNote": { rows: creditNotes(25) } });
    const one = await client.list("/CreditNote", {}, { limit: 1000 });
    const paged: number[] = [];
    for (let offset = 0; offset < 25; offset += 5) {
      paged.push(...ids((await client.list("/CreditNote", {}, { limit: 5, offset })).items));
    }
    expect(new Set(paged).size).toBeLessThan(25);
    expect(ids(one.items).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("listAll keeps every row once and says that it read more than one page", async () => {
    const { client } = tiedSevdesk({ "/CreditNote": { rows: creditNotes(2500) } });
    const all = await client.listAll("/CreditNote", undefined, { max: 5000, pageSize: 1000 });
    const read = ids(all.items);
    expect(new Set(read).size).toBe(read.length);
    expect(all.paged).toBe(true);
    expect(all.truncated).toBe(false);
    // One page is not paged.
    const small = tiedSevdesk({ "/CreditNote": { rows: creditNotes(900) } });
    const one = await small.client.listAll("/CreditNote", undefined, { max: 5000, pageSize: 1000 });
    expect(one.items).toHaveLength(900);
    expect(one.paged).toBe(false);
  });

  it("a credit note summary over a range sees all 2,500 exactly once, each read one page", async () => {
    const { client, requests } = tiedSevdesk({
      "/CreditNote": { rows: creditNotes(2500), dateKey: "creditNoteDate" },
    });
    const report = await summarizeRecords(client, {
      subject: "credit_notes",
      groupBy: "none",
      from: "2026-01-01",
      to: "2026-03-31",
      maxGroups: 10,
    });
    expect(report.recordsCounted).toBe(2500);
    expect(report.totals.count).toBe(2500);
    expect(report.truncated).toBe(false);
    expect(report.pagedRead).toBeUndefined();
    // Every kept read is the first page of its window.
    const reads = requests.filter((url) => url.pathname.endsWith("/CreditNote"));
    expect(reads.every((url) => url.searchParams.get("offset") === "0")).toBe(true);
  });

  it("a credit note summary without a range pages, keeps each once and says rows may be missing", async () => {
    const { client } = tiedSevdesk({ "/CreditNote": { rows: creditNotes(2500) } });
    const report = await summarizeRecords(client, {
      subject: "credit_notes",
      groupBy: "none",
      maxGroups: 10,
    });
    expect(report.recordsCounted).toBeLessThanOrEqual(2500);
    expect(report.truncated).toBe(true);
    expect(report.pagedRead).toBe(true);
    expect(report.notes.join(" ")).toContain(
      "sevDesk lists more than 1,000 credit notes, so they were read page by page",
    );
  });

  it("an aging over more open invoices than one page says some may be missing", async () => {
    const invoices = Array.from({ length: 1500 }, (_, index) =>
      invoiceDoc({ id: index + 1, date: "2026-01-15", net: "10", tax: "1.9" }, { create: CREATED }),
    );
    const { client } = tiedSevdesk({ "/Invoice": { rows: invoices } });
    const report = await receivablesAging(client, { top: 5, today: "2026-11-18" });
    expect(report.truncated).toBe(true);
    expect(report.pagedRead).toBe(true);
    expect(report.notes).toContain(pagedReadNote("open invoices"));
    expect(agingSentence("Receivables", report)).toContain(
      "Read page by page: some open items may be missing (see notes).",
    );
  });

  it("the credit note number check says not every credit note was checked", async () => {
    const { client } = tiedSevdesk({ "/CreditNote": { rows: creditNotes(1500) } });
    const found = await findCreditNotesWithNumber(client, "GU-7", 0);
    expect(found.truncated).toBe(true);
  });

  it("an order with more positions than one page is not called complete", async () => {
    const positions = Array.from({ length: 1200 }, (_, index) => ({
      id: String(index + 1),
      objectName: "OrderPos",
      order: { id: "77", objectName: "Order" },
      positionNumber: "0",
      quantity: "1",
      price: "10",
      name: "Position",
      taxRate: "19",
      create: CREATED,
    }));
    const { client } = tiedSevdesk({ "/OrderPos": { rows: positions } });
    const read = await listDocumentPositions(
      client,
      { path: "/OrderPos", parentKey: "order", objectName: "Order", what: "order positions" },
      77,
    );
    expect(read.complete).toBe(false);
    expect(new Set(read.rows.map((row) => row.id)).size).toBe(read.rows.length);
  });
});
