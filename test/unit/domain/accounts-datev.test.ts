import { describe, expect, it } from "vitest";

import {
  accountLabel,
  clearAccountsDatevCache,
  fetchAccountsDatev,
  findAccountDatev,
  isValidOn,
  loadAccountsDatev,
  MAX_ACCOUNTS,
  toAccountDatev,
} from "../../../src/domain/accounts-datev.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import type { Page, SevdeskClient } from "../../../src/sevdesk/types.js";
import { FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";

const RECORDED = "recorded/2026-11-07/meta/account-datev.json";

function recordedRows(): Record<string, unknown>[] {
  return (loadFixture(RECORDED).body as { objects: Record<string, unknown>[] }).objects;
}

const recordedClient = (): FakeSevdeskClient =>
  new FakeSevdeskClient([{ path: "/AccountDatev", response: { fixture: RECORDED } }]);

/** A client whose `/AccountDatev` answers from `pages` by call. */
function pagedClient(pages: readonly Page[]): SevdeskClient & { offsets: number[] } {
  const offsets: number[] = [];
  let call = 0;
  const fake = new FakeSevdeskClient([]);
  return Object.assign(fake, {
    offsets,
    list: (_path: string, _query?: unknown, options?: { offset?: number }) => {
      offsets.push(options?.offset ?? 0);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(page ?? { items: [], total: undefined });
    },
  });
}

const row = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: String(id),
  number: String(id),
  name: `Konto ${String(id)}`,
  ...extra,
});

describe("the recorded GET /AccountDatev (contract)", () => {
  it("parses every recorded row through the production reader", async () => {
    const list = await fetchAccountsDatev(recordedClient());
    expect(list.accounts).toHaveLength(recordedRows().length);
    expect(list.truncated).toBe(false);
    const kinds = new Map<string, number>();
    for (const account of list.accounts) {
      expect(Number.isSafeInteger(account.id)).toBe(true);
      expect(account.number).toMatch(/^\d+$/);
      expect(account.name).toBeDefined();
      kinds.set(account.kind, (kinds.get(account.kind) ?? 0) + 1);
    }
    // 79 expense / 9 revenue / 10 asset accounts on the SKR04 trial (M4 probe).
    expect(kinds.get("expense")).toBe(79);
    expect(kinds.get("revenue")).toBe(9);
    expect(kinds.get("asset")).toBe(10);
    expect(list.accounts.every((account) => account.active)).toBe(true);
  });

  it("names accounts for previews and keeps the validity of the 2020 VAT cut rows", async () => {
    const list = await fetchAccountsDatev(recordedClient());
    expect(accountLabel(list, 4266)).toBe("6815 Bürobedarf");
    expect(findAccountDatev(list, 4266)?.kind).toBe("expense");
    expect(findAccountDatev(list, 5192)).toMatchObject({
      number: "4400",
      kind: "revenue",
      validFrom: "2021-01-01",
      validUntil: "3000-01-01",
    });
    const cut = findAccountDatev(list, 3663);
    expect(cut === undefined ? undefined : isValidOn(cut, "2020-10-01")).toBe(true);
    expect(cut === undefined ? undefined : isValidOn(cut, "2021-01-01")).toBe(false);
    expect(accountLabel(list.accounts, 1)).toBe("account 1");
  });
});

describe("toAccountDatev", () => {
  it("prefers the translated number and name, and reads every flag spelling", () => {
    expect(
      toAccountDatev(
        row(1, {
          translatedNumber: "4930",
          translatedName: "Bürobedarf",
          expenseAccount: "1",
          hidden: false,
        }),
      ),
    ).toEqual({ id: 1, number: "4930", name: "Bürobedarf", kind: "expense", active: true });
    expect(toAccountDatev(row(2, { revenueAccount: 1 })).kind).toBe("revenue");
    expect(toAccountDatev(row(3, { assetAccount: true })).kind).toBe("asset");
    expect(toAccountDatev(row(4, { expenseAccount: "1", revenueAccount: "1" })).kind).toBe("other");
    expect(toAccountDatev(row(5)).kind).toBe("other");
    expect(toAccountDatev(row(6, { deactivated: "1" })).active).toBe(false);
    expect(toAccountDatev(row(7, { deprecated: "1" })).active).toBe(false);
    expect(toAccountDatev(row(8, { hidden: "1" })).active).toBe(false);
  });

  it("sanitizes names and labels only digit numbers", () => {
    const rlo = String.fromCodePoint(0x202e);
    const account = toAccountDatev(row(9, { number: "B-1", name: `Bad${rlo}name` }));
    expect(account.name).not.toContain(rlo);
    expect(accountLabel([account], 9)).toBe(account.name);
    expect(accountLabel([toAccountDatev({ id: "10" })], 10)).toBe("account 10");
  });

  it("refuses a row that does not fit", () => {
    expect(() => toAccountDatev({ id: "x" })).toThrow(SevdeskError);
  });
});

describe("fetchAccountsDatev paging", () => {
  it("pages until sevDesk's total with an explicit limit", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => row(index + 1));
    const client = pagedClient([
      { items: first, total: 1001 },
      { items: [row(1001)], total: 1001 },
    ]);
    const list = await fetchAccountsDatev(client);
    expect(list.accounts).toHaveLength(1001);
    expect(list.truncated).toBe(false);
    expect(client.offsets).toEqual([0, 1000]);
  });

  it("stops at an empty page when there is no total", async () => {
    const client = pagedClient([
      { items: [row(1)], total: undefined },
      { items: [], total: undefined },
    ]);
    expect(await fetchAccountsDatev(client)).toEqual({
      accounts: [toAccountDatev(row(1))],
      truncated: false,
    });
  });

  it("reports an ignored offset (no new ids) as truncated", async () => {
    const client = pagedClient([{ items: [row(1), row(2)], total: undefined }]);
    const list = await fetchAccountsDatev(client);
    expect(list.accounts).toHaveLength(2);
    expect(list.truncated).toBe(true);
    expect(client.offsets).toEqual([0, 2]);
  });

  it("stops at the cap", async () => {
    let next = 0;
    const page = (): Page => ({
      items: Array.from({ length: 1000 }, () => row((next += 1))),
      total: undefined,
    });
    const client = new FakeSevdeskClient([]);
    client.list = () => Promise.resolve(page());
    const list = await fetchAccountsDatev(client);
    expect(list.accounts).toHaveLength(MAX_ACCOUNTS);
    expect(list.truncated).toBe(true);
  });
});

describe("loadAccountsDatev", () => {
  it("caches per owner for the TTL and drops the cache on request", async () => {
    const owner = {};
    const fake = recordedClient();
    let now = 1_000;
    const options = { cacheOwner: owner, now: () => now, ttlMs: 100 };
    await loadAccountsDatev(fake, options);
    await loadAccountsDatev(fake, options);
    expect(fake.calls).toHaveLength(1);
    now += 101;
    await loadAccountsDatev(fake, options);
    expect(fake.calls).toHaveLength(2);
    clearAccountsDatevCache(owner);
    await loadAccountsDatev(fake, options);
    expect(fake.calls).toHaveLength(3);
  });

  it("does not cache failures", async () => {
    const owner = {};
    const failing = new FakeSevdeskClient([
      {
        path: "/AccountDatev",
        response: { error: new SevdeskError({ kind: "server", message: "Down." }) },
      },
    ]);
    await expect(loadAccountsDatev(failing, { cacheOwner: owner })).rejects.toThrow("Down.");
    const list = await loadAccountsDatev(recordedClient(), { cacheOwner: owner });
    expect(list.accounts.length).toBeGreaterThan(0);
  });
});
