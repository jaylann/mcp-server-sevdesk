/**
 * Regression (#154, spec/deviations.md D-100): sevDesk sorts its voucher list by date and leaves
 * vouchers of the same date in an order that depends on the page. On the trial account
 * (2026-11-18, probe `read-voucher-paging-order`) 56 vouchers read in pages of 5 missed 12 and
 * repeated 12 against one page of 1,000, with and without `embed=document`. The receipt checks,
 * the duplicates check and the reports read the list through `listDocumentHeaders`; paging it with
 * `offset` past 1,000 vouchers could skip a voucher, and a skipped voucher makes a booked receipt
 * look unbooked. The listing must read every period in requests that are each the first page of
 * their own date window, and see every voucher exactly once.
 */
import { describe, expect, it } from "vitest";

import { documentDateFilter } from "../../src/domain/common.js";
import { duplicatesCheck } from "../../src/domain/reports/audit/duplicates-check.js";
import { recurringGapsCheck } from "../../src/domain/reports/audit/recurring-gaps-check.js";
import { listVoucherRows } from "../../src/domain/reports/audit/supplier-bills.js";
import { pagedRangesNote } from "../../src/domain/reports/positions-scan.js";
import { shiftDays } from "../../src/domain/reports/shared.js";
import { voucherDoc } from "../unit/domain/reports/builders.js";
import { type ScriptedCall, ScriptedClient } from "../unit/scripts/scripted-client.js";

type Raw = Record<string, unknown>;

/**
 * `perDay` vouchers on each day from `from`, `days` days long, ids from `firstId`, spread over 200
 * suppliers (so the duplicates check compares few pairs).
 */
function vouchersOf(from: string, days: number, perDay: number, firstId: number): Raw[] {
  return Array.from({ length: days * perDay }, (_, index) =>
    voucherDoc({
      id: firstId + index,
      date: shiftDays(from, Math.floor(index / perDay)),
      net: "10",
      tax: "1.9",
      contactId: 5000 + (index % 200),
    }),
  );
}

/**
 * `GET /Voucher` as the trial answered it: the date filter applied, newest date first, and
 * vouchers of one date in an order that depends on `limit` and `offset` (synthetic mix; recorded:
 * the order depends on the page and paging loses rows).
 */
function voucherList(vouchers: readonly Raw[]): ScriptedClient {
  const dated = vouchers.map((row) => ({
    row,
    id: Number(row["id"]),
    seconds: Date.parse(String(row["voucherDate"])) / 1000,
  }));
  return new ScriptedClient((call: ScriptedCall) => {
    // Invoices and credit notes (the duplicates check lists them too): none.
    if (call.path !== "/Voucher") return { total: "0", objects: [] };
    const { startDate, endDate, limit, offset } = call.query;
    const seed = Math.imul(Number(limit) * 31 + Number(offset), 0x9e3779b1);
    const tie = (id: number) => Math.imul(id ^ seed, 0x85ebca6b) >>> 0;
    const rows = dated
      .filter((entry) => entry.seconds >= Number(startDate) && entry.seconds <= Number(endDate))
      .sort((a, b) => b.seconds - a.seconds || tie(a.id) - tie(b.id));
    return {
      total: String(rows.length),
      objects: rows.slice(Number(offset), Number(offset) + Number(limit)).map((entry) => entry.row),
    };
  });
}

function context(client: ScriptedClient) {
  return {
    client,
    period: { from: "2026-01-01", to: "2026-03-31", label: "2026-Q1" },
    cacheOwner: {},
    options: {},
    today: "2026-11-18",
  };
}

const ids = (rows: readonly { readonly id: number }[]) => rows.map((row) => row.id);

// Thousands of mapped voucher rows per test: slow on a busy machine, so a generous timeout.
describe("a voucher list longer than one page", { timeout: 30_000 }, () => {
  // 2,430 vouchers in the first quarter, 27 a day: every date is shared.
  const quarter = vouchersOf("2026-01-01", 90, 27, 1);

  it("loses vouchers when read with offset (the trap this guards against)", async () => {
    const client = voucherList(quarter);
    const seen: number[] = [];
    for (let offset = 0; offset < quarter.length; offset += 1000) {
      const page = await client.list(
        "/Voucher",
        documentDateFilter({ from: "2026-01-01", to: "2026-03-31" }).query,
        { limit: 1000, offset },
      );
      seen.push(...page.items.map((row) => Number((row as Raw)["id"])));
    }
    expect(seen).toHaveLength(quarter.length);
    expect(new Set(seen).size).toBeLessThan(quarter.length);
  });

  it("is read in date windows of one page each, every voucher exactly once", async () => {
    const client = voucherList(quarter);
    const rows = await listVoucherRows(context(client), "2026-01-01", "2026-03-31", {
      receipts: true,
    });
    const read = ids(rows.booked);
    expect(read).toHaveLength(quarter.length);
    expect(new Set(read).size).toBe(quarter.length);
    expect(rows.listed).toMatchObject({ truncated: false, pagedRanges: [] });
    expect(pagedRangesNote(rows.listed)).toBeUndefined();
    const calls = client.calls.filter((call) => call.path === "/Voucher");
    for (const call of calls) {
      expect(call.query).toMatchObject({ offset: 0, voucherType: "VOU", embed: "document" });
      expect(Number(call.query["limit"])).toBeLessThanOrEqual(1000);
    }
    // One page set aside, then windows of at most 1,000, each counted first: bounded and few.
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it("names a day with more vouchers than one page and keeps each of its vouchers once", async () => {
    const busy = vouchersOf("2026-02-27", 1, 1200, 100_000);
    const client = voucherList([...quarter, ...busy]);
    const rows = await listVoucherRows(context(client), "2026-01-01", "2026-03-31");
    const read = ids(rows.booked);
    expect(new Set(read).size).toBe(read.length);
    // Every voucher of the other days is there; only the busy day may miss some.
    const busyDate = busy[0]?.["voucherDate"];
    const otherDays = quarter.filter((row) => row["voucherDate"] !== busyDate);
    expect(otherDays.map((row) => Number(row["id"])).every((id) => read.includes(id))).toBe(true);
    expect(rows.listed.pagedRanges).toEqual(["vouchers on 2026-02-27"]);
    expect(pagedRangesNote(rows.listed)).toBe(
      "sevDesk lists more than 1,000 documents of one kind for vouchers on 2026-02-27, so they " +
        "were read page by page; sevDesk's order is not stable between pages, so documents of " +
        "those days may be missing here.",
    );
  });

  it("makes the checks say so and count as incomplete when a day had to be paged", async () => {
    const busy = vouchersOf("2026-02-27", 1, 1200, 100_000);
    const plain = await duplicatesCheck.run(context(voucherList(quarter)));
    expect(plain.coverage.truncated).toBe(false);
    expect(plain.notes.join(" ")).not.toContain("read page by page");

    const duplicates = await duplicatesCheck.run(context(voucherList([...quarter, ...busy])));
    expect(duplicates.coverage.truncated).toBe(true);
    expect(duplicates.notes).toContain(
      pagedRangesNote({ pagedRanges: ["vouchers on 2026-02-27"] }),
    );
    expect(duplicates.notes.join(" ")).not.toContain("stopped at the cap");

    const gaps = await recurringGapsCheck.run(context(voucherList([...quarter, ...busy])));
    expect(gaps.coverage.truncated).toBe(true);
    expect(gaps.drafts).toEqual([]);
    expect(gaps.notes.join(" ")).toContain("so no gaps are reported");
  });
});
