/**
 * How the private-transaction rules are searched (#132): the duplicate check, the delete lookup and
 * both read-backs read the list page by page, up to five pages of 1000, each with an explicit
 * `limit`. sevDesk's order of rules is not recorded, so the rule looked for may sit on any page.
 */
import { describe, expect, it } from "vitest";

import {
  executePrivateRuleDelete,
  planPrivateRuleCreate,
  planPrivateRuleDelete,
} from "../../../src/domain/private-transaction-rules.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import type { ListOptions, Page, QueryValue, SevdeskRequest } from "../../../src/sevdesk/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";
import { accountsListRoute, listRoute, type Row } from "./reconciliation/helpers.js";

const RULE_PATH = "/PrivateTransactionRule";

/** A rule as `GET /PrivateTransactionRule` lists it: the recorded keys (D-099), made-up values. */
function ruleRow(id: number, overrides: Row = {}): Row {
  return {
    id: String(id),
    objectName: "PrivateTransactionRule",
    create: "2026-11-16T21:10:00+01:00",
    update: "2026-11-16T21:10:00+01:00",
    sevClient: { id: "1", objectName: "SevClient" },
    paymentPurpose: null,
    counterpartName: null,
    ...overrides,
  };
}

/** `count` rules with distinct counterparty texts, ids from 10 000. */
function otherRules(count: number): Row[] {
  return Array.from({ length: count }, (_, index) =>
    ruleRow(10_000 + index, { counterpartName: `Regel ${String(index)}` }),
  );
}

/**
 * Serves the rules page by page like sevDesk (`offset`/`limit`), with `total` or without it, and
 * records the paging options exactly as the code passed them. A write switches to `after`.
 */
class PagedRulesClient extends FakeSevdeskClient {
  readonly pages: { readonly limit: number | undefined; readonly offset: number | undefined }[] =
    [];
  private wrote = false;

  constructor(
    private readonly rules: readonly Row[],
    private readonly options: {
      readonly total?: "count" | "none" | number;
      readonly after?: readonly Row[];
      readonly routes?: readonly FakeRoute[];
    } = {},
  ) {
    super([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", []),
      {
        method: "DELETE",
        path: "/PrivateTransactionRule/{id}",
        pathPattern: /^\/PrivateTransactionRule\/\d+$/,
        response: { body: { objects: [null] } },
      },
      ...(options.routes ?? []),
    ]);
  }

  override request(request: SevdeskRequest): Promise<unknown> {
    if (request.method !== "GET") this.wrote = true;
    return super.request(request);
  }

  override list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options: ListOptions = {},
  ): Promise<Page> {
    if (path !== RULE_PATH) return super.list(path, query, options);
    this.pages.push({ limit: options.limit, offset: options.offset });
    const rows = this.wrote ? (this.options.after ?? this.rules) : this.rules;
    const offset = options.offset ?? 0;
    const items = rows.slice(offset, offset + (options.limit ?? 0));
    const mode = this.options.total ?? "count";
    const total = mode === "count" ? rows.length : mode === "none" ? undefined : mode;
    return Promise.resolve({ items, total });
  }

  /** The offsets of the rule pages read, in order. */
  offsets(): (number | undefined)[] {
    return this.pages.map((page) => page.offset);
  }
}

async function refusal(promise: Promise<unknown>): Promise<SevdeskError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect(error).toMatchObject({ kind: "validation" });
  return error as SevdeskError;
}

const HUBER = ruleRow(951, { counterpartName: "Vermieter Huber" });

describe("the duplicate check", () => {
  it.each([
    ["with sevDesk's total", "count"],
    ["without a total (a full page is not the end)", "none"],
  ] as const)("finds an equal rule on page 2 %s", async (_label, total) => {
    const client = new PagedRulesClient([...otherRules(1000), HUBER], { total });
    const error = await refusal(planPrivateRuleCreate(client, { counterparty: "vermieter HUBER" }));
    expect(error.message).toContain("Private-transaction rule 951 already has this counterparty");
    expect(client.offsets()).toEqual([0, 1000]);
    expect(client.writes()).toEqual([]);
  });

  it("stops at five pages and says how many rules it read", async () => {
    const client = new PagedRulesClient([...otherRules(5000), HUBER]);
    const plan = await planPrivateRuleCreate(client, { counterparty: "Vermieter Huber" });
    expect(plan.rulesComplete).toBe(false);
    expect(plan.rulesRead).toBe(5000);
    expect(client.offsets()).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("reads the whole list of a long account that ends on page 5", async () => {
    const client = new PagedRulesClient(otherRules(4500));
    const plan = await planPrivateRuleCreate(client, { counterparty: "Vermieter Huber" });
    expect(plan.rulesComplete).toBe(true);
    expect(plan.rulesRead).toBe(4500);
    expect(client.offsets()).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("always sends an explicit limit of 1000, from offset 0", async () => {
    const client = new PagedRulesClient(otherRules(2500));
    await planPrivateRuleCreate(client, { purpose: "Miete privat" });
    expect(client.pages).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ]);
  });
});

describe("the delete lookup", () => {
  it("finds the rule on page 3", async () => {
    const rules = [...otherRules(2100), HUBER, ...otherRules(400)];
    const client = new PagedRulesClient(rules);
    const { rule } = await planPrivateRuleDelete(client, 951);
    expect(rule).toEqual({ id: 951, counterparty: "Vermieter Huber", createdOn: "2026-11-16" });
    expect(client.offsets()).toEqual([0, 1000, 2000]);
  });

  it("names the rules read when the list goes on beyond five pages", async () => {
    const client = new PagedRulesClient(otherRules(6000));
    const error = await refusal(planPrivateRuleDelete(client, 951));
    expect(error.message).toBe(
      "There is no private-transaction rule 951 among the first 5000 rules sevDesk lists; find " +
        "the rules with sevdesk_private_transaction_rules_list. Nothing was sent.",
    );
    expect(client.offsets()).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("stops at a short last page when sevDesk sends no total", async () => {
    const client = new PagedRulesClient(otherRules(1400), { total: "none" });
    const error = await refusal(planPrivateRuleDelete(client, 951));
    expect(error.message).toBe(
      "There is no private-transaction rule 951; find the rules with " +
        "sevdesk_private_transaction_rules_list. Nothing was sent.",
    );
    expect(client.offsets()).toEqual([0, 1000]);
  });

  // 0 is a value, not "missing": a total of 0 ends the list, it does not fall back to page sizes.
  it("takes a total of 0 as an empty list, read once", async () => {
    const client = new PagedRulesClient([], { total: 0 });
    const error = await refusal(planPrivateRuleDelete(client, 951));
    expect(error.message).not.toContain("among the first");
    expect(client.pages).toEqual([{ limit: 1000, offset: 0 }]);
  });

  it("stops at an empty page that the total does not explain", async () => {
    const client = new PagedRulesClient([], { total: 3000 });
    const error = await refusal(planPrivateRuleDelete(client, 951));
    expect(error.message).toContain("among the first 0 rules sevDesk lists");
    expect(client.offsets()).toEqual([0]);
  });
});

describe("the delete read-back", () => {
  it("looks past the first page for a rule that is still listed", async () => {
    const rules = [...otherRules(2100), HUBER];
    const client = new PagedRulesClient(rules, { after: rules });
    const error = await executePrivateRuleDelete(client, 951).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "PrivateTransactionRule", id: "951" }],
    });
    expect(client.offsets()).toEqual([0, 1000, 2000]);
  });

  it("confirms the delete when the rule is gone from every page", async () => {
    const client = new PagedRulesClient([], { after: otherRules(2100) });
    await executePrivateRuleDelete(client, 951);
    expect(client.offsets()).toEqual([0, 1000, 2000]);
  });
});
