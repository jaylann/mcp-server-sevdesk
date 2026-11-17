/**
 * Argument suggestions (`src/prompts/completions.ts`): months and periods from the clock, contact
 * and payment account names from the account (gated by the registered read tools, read-only,
 * with an explicit limit, cached per account), and how `completableArgs` attaches them without
 * touching the shared catalog schemas.
 */
import { isCompletable } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PROMPTS } from "../../../src/prompts/catalog.js";
import {
  accountCompleters,
  COMPLETION_CACHE_TTL_MS,
  monthSuggestions,
  periodCompleters,
  periodSuggestions,
  rankNames,
} from "../../../src/prompts/completions.js";
import { completableArgs } from "../../../src/prompts/index.js";
import { MONTH_PATTERN, PERIOD_PATTERN } from "../../../src/prompts/periods.js";
import type { PromptDefinition } from "../../../src/prompts/types.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../../src/sevdesk/types.js";
import { testConfig } from "../../helpers/config.js";
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

  it("suggests nothing when sevDesk fails, and does not cache the failure", async () => {
    let fail = true;
    const fake = new FakeSevdeskClient([CONTACTS]);
    const flaky = withList(fake, (path, query, options) =>
      fail
        ? Promise.reject(new SevdeskError({ kind: "network", message: "offline" }))
        : fake.list(path, query, options),
    );
    const completers = accountCompleters({
      config: testConfig(),
      client: flaky,
      tools: BOTH_TOOLS,
    });

    expect(await completers.contact?.("mus")).toEqual([]);
    fail = false;
    expect(await completers.contact?.("mus")).toHaveLength(4);
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
