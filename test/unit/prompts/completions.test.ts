/**
 * Argument suggestions (`src/prompts/completions.ts`): months, periods and years from the clock, contact
 * and payment account names from the account (gated by the registered read tools, read-only,
 * with an explicit limit, cached per account, failures kept briefly, searches stopped when nobody
 * waits for them, a longer typed name answered from a complete search), and how `completableArgs` attaches them without touching the shared catalog
 * schemas.
 */
import { isCompletable } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PROMPTS } from "../../../src/prompts/catalog.js";
import {
  accountCompleters,
  COMPLETION_CACHE_TTL_MS,
  COMPLETION_FAILURE_TTL_MS,
  MAX_CACHED_SEARCHES,
  monthSuggestions,
  periodCompleters,
  periodSuggestions,
  rankNames,
  yearSuggestions,
} from "../../../src/prompts/completions.js";
import { completableArgs } from "../../../src/prompts/index.js";
import { MONTH_PATTERN, PERIOD_PATTERN, YEAR_PATTERN } from "../../../src/prompts/periods.js";
import type { PromptDefinition } from "../../../src/prompts/types.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../../src/sevdesk/types.js";
import { testConfig } from "../../helpers/config.js";
import { crowdedAccount } from "../../helpers/crowded-contacts.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";

const TODAY = "2026-11-16";
const BOTH_TOOLS = new Set(["sevdesk_contacts_search", "sevdesk_bank_accounts_list"]);
const CONTACTS: FakeRoute = {
  path: "/Contact",
  response: { fixture: "contacts/contacts-list.json" },
};
const ACCOUNTS: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};

function prompt(name: string): PromptDefinition {
  const found = PROMPTS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no prompt ${name}`);
  return found;
}

/** `client` with its `list` replaced. */
function withList(client: SevdeskClient, list: SevdeskClient["list"]): SevdeskClient {
  return {
    request: (request) => client.request(request),
    list,
    listAll: (path, query, options) => client.listAll(path, query, options),
    download: (request) => client.download(request),
  };
}

/** A clock the test moves by hand. */
function clock(start = Date.UTC(2026, 10, 16, 12)): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

/**
 * An account with more contacts than one read returns (1,500, of which a read gets the first
 * 1,000, all named `Kunde …`), whose name search behaves as recorded (spec/deviations.md D-020):
 * the contacts of `named` whose name contains the searched text in any letter case, up to the
 * limit, with the count of all of them. `searches` records every searched name.
 */
function searchableAccount(named: readonly string[]): {
  client: SevdeskClient;
  searches: string[];
} {
  const searches: string[] = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index + 1),
    name: `Kunde ${String(index + 1).padStart(4, "0")}`,
  }));
  const client = withList(new FakeSevdeskClient([]), (_path, query, options) => {
    const name = query?.["name"];
    if (typeof name !== "string") return Promise.resolve({ items: firstPage, total: 1500 });
    searches.push(name);
    const found = named
      .filter((contact) => contact.toLocaleLowerCase("de").includes(name.toLocaleLowerCase("de")))
      .map((contact, index) => ({ id: String(5000 + index), name: contact }));
    return Promise.resolve({ items: found.slice(0, options?.limit), total: found.length });
  });
  return { client, searches };
}

/** Lets every pending promise settle (one macrotask). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("month suggestions", () => {
  it("offers the last 24 months up to the current one, newest first", () => {
    const months = monthSuggestions("", TODAY);
    expect(months).toHaveLength(24);
    expect(months.slice(0, 3)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(months.at(-1)).toBe("2024-12");
    expect(months.every((month) => MONTH_PATTERN.test(month))).toBe(true);
  });

  it("narrows by prefix and crosses the year end", () => {
    expect(monthSuggestions("2025-1", TODAY)).toEqual(["2025-12", "2025-11", "2025-10"]);
    expect(monthSuggestions("2027", TODAY)).toEqual([]);
    expect(monthSuggestions("2026-01", "2026-01-05")).toEqual(["2026-01"]);
    expect(monthSuggestions("", "2026-01-05").slice(0, 2)).toEqual(["2026-01", "2025-12"]);
  });

  it("offers every month of an older year the user typed, never a future one", () => {
    expect(monthSuggestions("2021", TODAY)).toEqual(
      ["12", "11", "10", "09", "08", "07", "06", "05", "04", "03", "02", "01"].map(
        (month) => `2021-${month}`,
      ),
    );
    expect(monthSuggestions("2026", TODAY)[0]).toBe("2026-11");
    expect(monthSuggestions("2026", TODAY)).not.toContain("2026-12");
  });

  it("offers nothing for text that no month starts with", () => {
    for (const value of ["Oktober", " 2026", "2026-13", "1999", "x"]) {
      expect(monthSuggestions(value, TODAY), value).toEqual([]);
    }
  });
});

describe("period suggestions", () => {
  it("offers months and quarters newest first, a month before the quarter it ends", () => {
    expect(periodSuggestions("", TODAY).slice(0, 7)).toEqual([
      "2026-Q4",
      "2026-11",
      "2026-10",
      "2026-09",
      "2026-Q3",
      "2026-08",
      "2026-07",
    ]);
    const all = periodSuggestions("", TODAY);
    expect(all).toHaveLength(24 + 8);
    expect(all.every((period) => PERIOD_PATTERN.test(period))).toBe(true);
  });

  it("completes quarters in either case and a typed year's periods", () => {
    expect(periodSuggestions("2026-q", TODAY)).toEqual([
      "2026-Q4",
      "2026-Q3",
      "2026-Q2",
      "2026-Q1",
    ]);
    expect(periodSuggestions("2020-Q", TODAY)).toEqual([
      "2020-Q4",
      "2020-Q3",
      "2020-Q2",
      "2020-Q1",
    ]);
    expect(periodSuggestions("2020", TODAY)).toHaveLength(16);
  });

  it("leaves out quarters that start after today", () => {
    expect(periodSuggestions("2026-Q", "2026-05-02")).toEqual(["2026-Q2", "2026-Q1"]);
  });

  it("reads today from the injected clock, in Europe/Berlin", async () => {
    // 23:30 UTC on 31 December is already 1 January in Berlin.
    const completers = periodCompleters(() => Date.UTC(2026, 11, 31, 23, 30));
    expect((await completers.month?.(""))?.[0]).toBe("2027-01");
    expect((await completers.period?.(""))?.[0]).toBe("2027-Q1");
    expect(await completers.year?.("")).toEqual(["2027", "2026", "2025", "2024", "2023", "2022"]);
  });
});

describe("year suggestions", () => {
  it("offers the current year and the five before it, newest first", () => {
    const years = yearSuggestions("", TODAY);
    expect(years).toEqual(["2026", "2025", "2024", "2023", "2022", "2021"]);
    expect(years.every((year) => YEAR_PATTERN.test(year))).toBe(true);
  });

  it("narrows them by what was typed and offers an older year typed in full", () => {
    expect(yearSuggestions("202", TODAY)).toEqual(["2026", "2025", "2024", "2023", "2022", "2021"]);
    expect(yearSuggestions("2025", TODAY)).toEqual(["2025"]);
    expect(yearSuggestions("201", TODAY)).toEqual([]);
    expect(yearSuggestions("2014", TODAY)).toEqual(["2014"]);
  });

  it("never offers a future year or anything the argument would refuse", () => {
    for (const value of ["2027", "2099", "1999", "20", " 2025", "x", "2025-"]) {
      expect(
        yearSuggestions(value, TODAY).filter((year) => year > "2026" || !YEAR_PATTERN.test(year)),
        value,
      ).toEqual([]);
    }
    expect(yearSuggestions("2027", TODAY)).toEqual([]);
    expect(yearSuggestions("1999", TODAY)).toEqual([]);
  });

  it("starts at 2000", () => {
    expect(yearSuggestions("", "2002-03-01")).toEqual(["2002", "2001", "2000"]);
  });

  it("is attached to year_end_handoff.year", () => {
    expect(prompt("year_end_handoff").completions).toEqual({ year: "year" });
  });
});

describe("rankNames", () => {
  it("puts names starting with the text first, then the others containing it, each sorted", () => {
    const names = ["Zahlungsdienst Muster", "Musterfirma GmbH", "max mustermann", "Beispiel AG"];
    expect(rankNames(names, " MUST")).toEqual([
      "Musterfirma GmbH",
      "max mustermann",
      "Zahlungsdienst Muster",
    ]);
    expect(rankNames(names, "")).toEqual([
      "Beispiel AG",
      "max mustermann",
      "Musterfirma GmbH",
      "Zahlungsdienst Muster",
    ]);
    expect(rankNames(["A", "A", "B"], "")).toEqual(["A", "B"]);
    expect(rankNames(names, "nothing")).toEqual([]);
  });
});

describe("account completers", () => {
  it("completes contact and account names when their read tools are registered", async () => {
    const fake = new FakeSevdeskClient([CONTACTS, ACCOUNTS]);
    const completers = accountCompleters({ config: testConfig(), client: fake, tools: BOTH_TOOLS });

    expect(await completers.contact?.("mus")).toEqual([
      "Musterfirma GmbH",
      "Dr. Max Mustermann",
      "Erika Musterfrau",
      "Stadtverwaltung Musterstadt",
    ]);
    expect(await completers.checkAccount?.("")).toEqual([
      "Basiskonto",
      "Geschäftskonto Musterbank",
      "Kasse",
      "PayPal USD",
    ]);
    expect(await completers.checkAccount?.("konto")).toEqual([
      "Basiskonto",
      "Geschäftskonto Musterbank",
    ]);
  });

  it("reads with an explicit limit and changes nothing", async () => {
    const fake = new FakeSevdeskClient([CONTACTS, ACCOUNTS]);
    const completers = accountCompleters({ config: testConfig(), client: fake, tools: BOTH_TOOLS });
    await completers.contact?.("");
    await completers.checkAccount?.("");

    expect(fake.calls.map(({ operation, path, query }) => ({ operation, path, query }))).toEqual([
      {
        operation: "list",
        path: "/Contact",
        query: { depth: "1", limit: 1000, offset: 0, countAll: true },
      },
      {
        operation: "list",
        path: "/CheckAccount",
        query: { limit: 1000, offset: 0, countAll: true },
      },
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    ["no read tool", new Set<string>(), []],
    ["contacts only", new Set(["sevdesk_contacts_search"]), ["contact"]],
    ["bank accounts only", new Set(["sevdesk_bank_accounts_list"]), ["checkAccount"]],
  ])("offers only the kinds whose read tool is registered: %s", (_label, tools, kinds) => {
    const completers = accountCompleters({
      config: testConfig(),
      client: new FakeSevdeskClient([]),
      tools,
    });
    expect(Object.keys(completers).sort()).toEqual(kinds);
  });

  it("reuses names within the cache time, also while a read is in flight, and reads again after", async () => {
    const fake = new FakeSevdeskClient([CONTACTS]);
    const time = clock();
    const completers = accountCompleters({
      config: testConfig(),
      client: fake,
      tools: BOTH_TOOLS,
      now: time.now,
    });

    await Promise.all([completers.contact?.("m"), completers.contact?.("e")]);
    await completers.contact?.("x");
    expect(fake.callsTo("/Contact")).toHaveLength(1);

    time.advance(COMPLETION_CACHE_TTL_MS);
    await completers.contact?.("");
    expect(fake.callsTo("/Contact")).toHaveLength(2);
  });

  it("keeps each account's names apart", async () => {
    const first = new FakeSevdeskClient([
      { path: "/Contact", response: { body: { objects: [{ id: "1", name: "Only First GmbH" }] } } },
    ]);
    const second = new FakeSevdeskClient([
      { path: "/Contact", response: { body: { objects: [{ id: "2", name: "Only Second AG" }] } } },
    ]);
    const a = accountCompleters({ config: testConfig(), client: first, tools: BOTH_TOOLS });
    const b = accountCompleters({ config: testConfig(), client: second, tools: BOTH_TOOLS });

    expect(await a.contact?.("")).toEqual(["Only First GmbH"]);
    expect(await b.contact?.("")).toEqual(["Only Second AG"]);
    expect(await a.contact?.("")).toEqual(["Only First GmbH"]);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  it("suggests nothing when sevDesk fails, and keeps the failure for a few seconds", async () => {
    let fail = true;
    let reads = 0;
    const fake = new FakeSevdeskClient([CONTACTS, ACCOUNTS]);
    const flaky = withList(fake, (path, query, options) => {
      reads += 1;
      return fail
        ? Promise.reject(new SevdeskError({ kind: "network", message: "offline" }))
        : fake.list(path, query, options);
    });
    const time = clock();
    const completers = accountCompleters({
      config: testConfig(),
      client: flaky,
      tools: BOTH_TOOLS,
      now: time.now,
    });

    expect(await completers.contact?.("mus")).toEqual([]);
    expect(await completers.contact?.("must")).toEqual([]);
    // sevDesk did not answer: the account's other list waits as well.
    expect(await completers.checkAccount?.("")).toEqual([]);
    expect(reads).toBe(1);

    fail = false;
    time.advance(COMPLETION_FAILURE_TTL_MS - 1);
    expect(await completers.contact?.("mus")).toEqual([]);
    expect(reads).toBe(1);
    time.advance(1);
    expect(await completers.contact?.("mus")).toHaveLength(4);
    expect(await completers.checkAccount?.("")).toHaveLength(4);
    expect(reads).toBe(3);
  });

  it("holds the account's searches back after sevDesk refused the token", async () => {
    const account = crowdedAccount({
      failure: (name) =>
        name === undefined
          ? undefined
          : new SevdeskError({ kind: "auth", message: "The token was refused.", status: 401 }),
    });
    const time = clock();
    const completers = accountCompleters({
      config: testConfig(),
      client: account.client,
      tools: BOTH_TOOLS,
      now: time.now,
    });

    for (const value of ["a", "ab", "abc", "abcd"]) {
      expect(await completers.contact?.(value), value).toEqual([]);
    }
    expect(account.calls).toEqual([undefined, "a"]);
    time.advance(COMPLETION_FAILURE_TTL_MS);
    await completers.contact?.("abcde");
    expect(account.calls).toEqual([undefined, "a", "abcde"]);
  });

  it("does not hold the account back after a failure of one search", async () => {
    const account = crowdedAccount({
      failure: (name) =>
        name === "kaputt"
          ? new SevdeskError({ kind: "validation", message: "Invalid request.", status: 400 })
          : undefined,
    });
    const completers = accountCompleters({
      config: testConfig(),
      client: account.client,
      tools: BOTH_TOOLS,
    });

    expect(await completers.contact?.("kaputt")).toEqual([]);
    expect(await completers.contact?.("Kaputt ")).toEqual([]);
    expect(await completers.contact?.("zebra")).toEqual(["zebra GmbH"]);
    expect(account.calls).toEqual([undefined, "kaputt", "zebra"]);
  });

  it("keeps the full contact list while searches come and go, the least recently used first out", async () => {
    const account = crowdedAccount();
    const completers = accountCompleters({
      config: testConfig(),
      client: account.client,
      tools: BOTH_TOOLS,
    });
    // Of equal length, so that no typed name starts with another (which would reuse its search).
    const typed = Array.from(
      { length: MAX_CACHED_SEARCHES },
      (_, index) => `suche ${String(index).padStart(2, "0")}`,
    );

    for (const value of typed) await completers.contact?.(value);
    expect(await completers.contact?.("suche 00")).toEqual(["suche 00 GmbH"]);
    await completers.contact?.("eine mehr");
    await completers.contact?.("suche 00");
    await completers.contact?.("suche 01");

    expect(account.calls.filter((name) => name === undefined)).toHaveLength(1);
    expect(account.calls.filter((name) => name !== undefined)).toEqual([
      ...typed,
      "eine mehr",
      "suche 01",
    ]);
  });

  it("stops a search when the request waiting for it ends early, and does not keep it", async () => {
    const account = crowdedAccount({ hold: true });
    const config = testConfig();
    const request = new AbortController();
    const completers = accountCompleters({
      config,
      client: account.client,
      tools: BOTH_TOOLS,
      signal: request.signal,
    });

    const answer = completers.contact?.("zebra");
    await vi.waitFor(() => {
      expect(account.held).toHaveLength(1);
    });
    request.abort();
    expect(await answer).toEqual([]);
    expect(account.held[0]?.signal?.aborted).toBe(true);

    const next = accountCompleters({ config, client: account.client, tools: BOTH_TOOLS });
    const again = next.contact?.("zebra");
    await vi.waitFor(() => {
      expect(account.held).toHaveLength(2);
    });
    account.held[1]?.release();
    expect(await again).toEqual(["zebra GmbH"]);
    expect(account.calls).toEqual([undefined, "zebra", "zebra"]);
  });

  it("keeps a search running while another request still waits for it", async () => {
    const account = crowdedAccount({ hold: true });
    const config = testConfig();
    const first = new AbortController();
    const a = accountCompleters({
      config,
      client: account.client,
      tools: BOTH_TOOLS,
      signal: first.signal,
    });
    const b = accountCompleters({
      config,
      client: account.client,
      tools: BOTH_TOOLS,
      signal: new AbortController().signal,
    });

    const fromA = a.contact?.("zebra");
    await vi.waitFor(() => {
      expect(account.held).toHaveLength(1);
    });
    const fromB = b.contact?.("zebra");
    await settle();
    first.abort();
    expect(await fromA).toEqual([]);
    expect(account.held[0]?.signal?.aborted).toBe(false);

    account.held[0]?.release();
    expect(await fromB).toEqual(["zebra GmbH"]);
    const c = accountCompleters({ config, client: account.client, tools: BOTH_TOOLS });
    expect(await c.contact?.("Zebra")).toEqual(["zebra GmbH"]);
    expect(account.calls).toEqual([undefined, "zebra"]);
  });

  it("reads the full lists to the end, also for a request that ended early", async () => {
    const fake = new FakeSevdeskClient([CONTACTS, ACCOUNTS]);
    const signals: (AbortSignal | undefined)[] = [];
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = withList(fake, async (path, query, options) => {
      signals.push(options?.signal);
      await gate;
      return fake.list(path, query, options);
    });
    const request = new AbortController();
    const completers = accountCompleters({
      config: testConfig(),
      client: slow,
      tools: BOTH_TOOLS,
      signal: request.signal,
    });

    const contacts = completers.contact?.("mus");
    const accounts = completers.checkAccount?.("konto");
    request.abort();
    open();
    expect(await contacts).toHaveLength(4);
    expect(await accounts).toEqual(["Basiskonto", "Geschäftskonto Musterbank"]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
  });

  it("does not hide programming errors", async () => {
    const broken = withList(new FakeSevdeskClient([]), () => Promise.reject(new TypeError("bug")));
    const completers = accountCompleters({
      config: testConfig(),
      client: broken,
      tools: BOTH_TOOLS,
    });
    await expect(completers.checkAccount?.("")).rejects.toThrow(TypeError);
  });

  it("leaves out unnamed contacts and archived or unnamed accounts, and sanitizes names", async () => {
    const fake = new FakeSevdeskClient([
      {
        path: "/Contact",
        response: {
          body: {
            objects: [
              { id: "1", name: "Bidi‮ GmbH" },
              { id: "2" },
              { id: "3", surename: "  ", familyname: "​" },
              { id: "4", name: "Bidi GmbH" },
            ],
          },
        },
      },
      {
        path: "/CheckAccount",
        response: {
          body: {
            objects: [
              { id: "1", name: "Aktiv", status: "100" },
              { id: "2", name: "Archiviert", status: "0" },
              { id: "3", name: " ", status: "100" },
            ],
          },
        },
      },
    ]);
    const completers = accountCompleters({ config: testConfig(), client: fake, tools: BOTH_TOOLS });

    expect(await completers.contact?.("")).toEqual(["Bidi GmbH"]);
    expect(await completers.checkAccount?.("")).toEqual(["Aktiv"]);
  });

  it("searches sevDesk by the typed name when the account has more contacts than one read", async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({
      id: String(index + 1),
      name: `Kunde ${String(index + 1).padStart(4, "0")}`,
    }));
    const fake = new FakeSevdeskClient([
      {
        path: "/Contact",
        query: { name: "Zebra" },
        response: { body: { objects: [{ id: "5000", name: "Zebra Logistik GmbH" }] } },
      },
      { path: "/Contact", response: { body: { objects: page, total: 1500 } } },
    ]);
    const completers = accountCompleters({ config: testConfig(), client: fake, tools: BOTH_TOOLS });

    expect(await completers.contact?.(" Zebra ")).toEqual(["Zebra Logistik GmbH"]);
    expect(await completers.contact?.("zebra")).toEqual(["Zebra Logistik GmbH"]);
    expect((await completers.contact?.(""))?.length).toBe(1000);
    expect(await completers.contact?.("Kunde 0001".padEnd(201, "x"))).toEqual([]);
    const searches = fake.callsTo("/Contact").filter((call) => call.query["name"] !== undefined);
    expect(searches.map((call) => call.query)).toEqual([
      { depth: "1", name: "Zebra", limit: 100, offset: 0, countAll: true },
    ]);
  });
});

describe("contact searches reused for a longer typed name", () => {
  const MUELLER = [
    "Müller GmbH",
    "Gebr. Müller KG",
    "Hans Müllermann",
    "Mülheim Stadtwerke",
    "Zahnarzt Mülhausen",
  ];

  function completersOf(
    client: SevdeskClient,
    now?: () => number,
  ): ReturnType<typeof accountCompleters> {
    return accountCompleters({
      config: testConfig(),
      client,
      tools: BOTH_TOOLS,
      ...(now === undefined ? {} : { now }),
    });
  }

  it("answers a longer typed name from a complete search, ranked, without a request", async () => {
    const account = searchableAccount(MUELLER);
    const completers = completersOf(account.client);

    expect(await completers.contact?.("mül")).toEqual([
      "Mülheim Stadtwerke",
      "Müller GmbH",
      "Gebr. Müller KG",
      "Hans Müllermann",
      "Zahnarzt Mülhausen",
    ]);
    expect(await completers.contact?.("müll")).toEqual([
      "Müller GmbH",
      "Gebr. Müller KG",
      "Hans Müllermann",
    ]);
    expect(await completers.contact?.(" Müller G ")).toEqual(["Müller GmbH"]);
    expect(await completers.contact?.("müllerx")).toEqual([]);
    expect(account.searches).toEqual(["mül"]);
  });

  it("compares the typed names in any letter case", async () => {
    const account = searchableAccount(MUELLER);
    const completers = completersOf(account.client);

    await completers.contact?.("Mül");
    expect(await completers.contact?.("müll")).toEqual([
      "Müller GmbH",
      "Gebr. Müller KG",
      "Hans Müllermann",
    ]);
    expect(await completers.contact?.("MÜLLERM")).toEqual(["Hans Müllermann"]);
    expect(account.searches).toEqual(["Mül"]);
  });

  it("reuses only a search for a beginning of the typed name", async () => {
    const account = searchableAccount(MUELLER);
    const completers = completersOf(account.client);

    await completers.contact?.("hans");
    await completers.contact?.("mül");
    expect(await completers.contact?.("hansi")).toEqual([]);
    expect(await completers.contact?.("müll")).toHaveLength(3);
    // Contained in "hans" but not its beginning: "ans" finds more than "hans" did.
    expect(await completers.contact?.("ans")).toEqual(["Hans Müllermann"]);
    expect(await completers.contact?.("ller")).toEqual([
      "Gebr. Müller KG",
      "Hans Müllermann",
      "Müller GmbH",
    ]);
    expect(account.searches).toEqual(["hans", "mül", "ans", "ller"]);
  });

  it("searches again when the search for the shorter name was cut at its limit", async () => {
    const many = Array.from(
      { length: 150 },
      (_, index) => `Mülltonne ${String(index).padStart(3, "0")}`,
    );
    const account = searchableAccount([...many, "Müller GmbH"]);
    const completers = completersOf(account.client);

    // Exactly the limit of 100 rows, of 151: the answer may leave out a longer name's contacts.
    expect(await completers.contact?.("mül")).toHaveLength(100);
    expect(await completers.contact?.("mülle")).toEqual(["Müller GmbH"]);
    expect(account.searches).toEqual(["mül", "mülle"]);
  });

  it("searches again once the search for the shorter name has expired", async () => {
    const account = searchableAccount(MUELLER);
    const time = clock();
    const completers = completersOf(account.client, time.now);

    await completers.contact?.("mül");
    time.advance(COMPLETION_CACHE_TTL_MS - 1);
    expect(await completers.contact?.("müll")).toHaveLength(3);
    expect(account.searches).toEqual(["mül"]);

    time.advance(1);
    expect(await completers.contact?.("mülle")).toHaveLength(3);
    expect(account.searches).toEqual(["mül", "mülle"]);
  });

  it("counts a reuse as a use of the search it reuses, for the least recently used", async () => {
    const account = searchableAccount(MUELLER);
    const completers = completersOf(account.client);
    const others = Array.from(
      { length: MAX_CACHED_SEARCHES - 1 },
      (_, index) => `anders ${String(index).padStart(2, "0")}`,
    );

    await completers.contact?.("mül");
    for (const value of others) await completers.contact?.(value);
    // Reused, "mül" is the most recently used: the next search pushes out "anders 00" instead.
    await completers.contact?.("müll");
    await completers.contact?.("eine mehr");
    await completers.contact?.("mülle");
    await completers.contact?.("anders 00");

    expect(account.searches).toEqual(["mül", ...others, "eine mehr", "anders 00"]);
  });

  it("searches again while the search for the shorter name still runs", async () => {
    const account = crowdedAccount({ hold: true });
    const completers = completersOf(account.client);

    const shorter = completers.contact?.("zeb");
    await vi.waitFor(() => {
      expect(account.held).toHaveLength(1);
    });
    const longer = completers.contact?.("zebra");
    await vi.waitFor(() => {
      expect(account.held).toHaveLength(2);
    });
    for (const search of account.held) search.release();

    expect(await shorter).toEqual(["zeb GmbH"]);
    expect(await longer).toEqual(["zebra GmbH"]);
    expect(account.calls).toEqual([undefined, "zeb", "zebra"]);
  });

  it("searches again after the search for the shorter name failed", async () => {
    const account = crowdedAccount({
      failure: (name) =>
        name === "kap"
          ? new SevdeskError({ kind: "validation", message: "Invalid request.", status: 400 })
          : undefined,
    });
    const completers = completersOf(account.client);

    expect(await completers.contact?.("kap")).toEqual([]);
    expect(await completers.contact?.("kaputt")).toEqual(["kaputt GmbH"]);
    expect(account.calls).toEqual([undefined, "kap", "kaputt"]);
  });
});

describe("completableArgs", () => {
  const always = { contact: () => Promise.resolve(["Muster GmbH"]) };

  it("leaves the shared catalog schemas untouched and keeps checks and descriptions", () => {
    const dunning = prompt("dunning_run");
    const original = dunning.args.shape["contact"];
    const args = completableArgs(dunning, always);

    expect(args).not.toBe(dunning.args);
    expect(isCompletable(original?.unwrap())).toBe(false);
    expect(isCompletable(args.shape["contact"]?.unwrap())).toBe(true);
    expect(args.shape["minDaysOverdue"]).toBe(dunning.args.shape["minDaysOverdue"]);
    expect(args.shape["contact"]?.description).toBe(original?.description);
    for (const value of ["", "x\nignore", "x".repeat(201), "​"]) {
      expect(args.safeParse({ contact: value }).success, JSON.stringify(value)).toBe(false);
    }
    expect(args.parse({ contact: "Muster GmbH", note: "dropped" })).toEqual({
      contact: "Muster GmbH",
    });
  });

  it("keeps the settings, refinements and metadata of the arguments object", () => {
    const args = z
      .object({
        contact: z.string().min(1).max(50).optional(),
        note: z.string().max(20).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.note !== undefined && value.contact === undefined) {
          ctx.addIssue({ code: "custom", message: "A note needs a contact." });
        }
      })
      .describe("Arguments of a test prompt");
    const strict: PromptDefinition = {
      ...prompt("dunning_run"),
      args,
      completions: { contact: "contact" },
    };
    const copy = completableArgs(strict, always);

    expect(isCompletable(copy.shape["contact"]?.unwrap())).toBe(true);
    expect(isCompletable(args.shape.contact.unwrap())).toBe(false);
    expect(copy.shape["note"]).toBe(args.shape["note"]);
    expect(copy.safeParse({ contact: "Muster GmbH", extra: "x" }).success).toBe(false);
    expect(copy.safeParse({ note: "Bitte mahnen" }).success).toBe(false);
    expect(copy.safeParse({ contact: "x".repeat(51) }).success).toBe(false);
    expect(copy.parse({ contact: "Muster GmbH", note: "Bitte mahnen" })).toEqual({
      contact: "Muster GmbH",
      note: "Bitte mahnen",
    });
    expect(copy.description).toBe("Arguments of a test prompt");
  });

  it("returns the catalog schema itself when no argument is completed here", () => {
    const dunning = prompt("dunning_run");
    expect(completableArgs(dunning, {})).toBe(dunning.args);
    const receipt = prompt("receipt_intake");
    expect(completableArgs(receipt, always)).toBe(receipt.args);
  });

  // That suggestions the argument would refuse are dropped is tested through the server in
  // test/integration/prompt-completions.test.ts.
});
