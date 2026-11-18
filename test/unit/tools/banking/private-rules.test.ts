import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import {
  privateRuleCreateTool as createTool,
  privateRuleDeleteTool as deleteTool,
  privateRulesListTool as listTool,
} from "../../../../src/tools/banking/private-rules.js";
import { ACCOUNT_PRIVATE_TRANSACTION_RULES } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsListRoute,
  listRoute,
  type Row,
  StagedClient,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

/** A rule as `GET /PrivateTransactionRule` lists it: the recorded keys (D-099), made-up values. */
function ruleRow(id: number, overrides: Row = {}): Row {
  return {
    id: String(id),
    objectName: "PrivateTransactionRule",
    additionalInformation: null,
    create: "2026-11-16T21:10:00+01:00",
    update: "2026-11-16T21:10:00+01:00",
    sevClient: { id: "1", objectName: "SevClient" },
    paymentPurpose: null,
    counterpartName: null,
    ...overrides,
  };
}

function rulesRoute(rows: readonly Row[]): FakeRoute {
  return listRoute("/PrivateTransactionRule", rows);
}

/** An open (unbooked) transaction on account 4002 with this counterparty and purpose. */
function open(id: number, counterparty: string, purpose: string, overrides: Row = {}): Row {
  return transactionRow({
    id: String(id),
    amount: "-850",
    status: "100",
    valueDate: "2026-11-03T00:00:00+01:00",
    payeePayerName: counterparty,
    paymtPurpose: purpose,
    ...overrides,
  });
}

/** Reads of a create: the rules, then the open transactions (with the account names). */
function createReads(rules: readonly Row[], transactions: readonly Row[]): FakeRoute[] {
  return [
    rulesRoute(rules),
    accountsListRoute(),
    listRoute("/CheckAccountTransaction", transactions),
  ];
}

const EXISTING = ruleRow(951, { counterpartName: "Vermieter Huber" });
const NEW_RULE = ruleRow(952, { counterpartName: "Netflix" });

const POST: FakeRoute = {
  method: "POST",
  path: "/PrivateTransactionRule",
  response: { body: { objects: NEW_RULE } },
};

function callList(args: Record<string, unknown>, client: FakeSevdeskClient) {
  return listTool.handler(listTool.input.parse(args), testContext(client));
}

const TRANSACTIONS = [
  open(5101, "NETFLIX INTERNATIONAL B.V.", "Abo November"),
  open(5102, "Stadtwerke", "Netflix-Gutschein"),
  open(5103, "netflix.com", "Abo Jahr", { amount: "-12.99" }),
  open(5104, "Netflix", "Abo", { status: "400" }),
];

describe("sevdesk_private_transaction_rules_list", () => {
  it("is a read tool in the banking toolset", () => {
    expect(listTool.tier).toBe("read");
    expect(listTool.toolset).toBe("banking");
    expect(listTool.annotations.readOnlyHint).toBe(true);
  });

  it("lists the rules with cleaned texts and their day, with an explicit limit", async () => {
    const client = new FakeSevdeskClient([
      rulesRoute([
        EXISTING,
        ruleRow(960, { paymentPurpose: "Privat​ Entnahme", create: "2026-11-17T00:30:00+01:00" }),
      ]),
    ]);
    const result = await callList({}, client);
    expect(result.data.items).toEqual([
      { id: 951, counterparty: "Vermieter Huber", createdOn: "2026-11-16" },
      { id: 960, purpose: "Privat Entnahme", createdOn: "2026-11-17" },
    ]);
    expect(result.data).toMatchObject({ offset: 0, limit: 50, hasMore: false, total: 2 });
    expect(client.calls[0]?.query).toMatchObject({ limit: 50, offset: 0 });
    // The summary is trusted text: counts and where rules act (untested, so not as a fact), never
    // a rule's text.
    expect(result.summary).toBe(
      "Private-transaction rules 1–2 of 2. sevDesk is expected to apply them when it imports " +
        "bank transactions (not testable on a trial account).",
    );
    expect(result.summary).not.toContain("Huber");
  });

  it("says when there are no rules", async () => {
    const client = new FakeSevdeskClient([rulesRoute([])]);
    const result = await callList({ limit: 10 }, client);
    expect(result.data.items).toEqual([]);
    expect(result.summary).toBe("No private-transaction rules found.");
  });

  it("refuses a limit above 200", () => {
    expect(() => listTool.input.parse({ limit: 201 })).toThrow();
  });
});

describe("sevdesk_private_transaction_rule_create", () => {
  it("is a commit tool with commit annotations that locks the account's rules", () => {
    expect(createTool.tier).toBe("commit");
    expect(createTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(createTool.locks?.({ counterparty: "Netflix" })).toEqual([
      ACCOUNT_PRIVATE_TRANSACTION_RULES,
    ]);
  });

  it("previews the rule and labels the open transactions it may touch as an estimate", async () => {
    const client = new StagedClient(createReads([EXISTING], TRANSACTIONS), []);
    const plan = await prepareWrite(createTool, { counterparty: " Netflix " }, client);
    expect(plan.preview.action).toBe(
      "Create a private-transaction rule on the counterparty (Auftraggeber/Empfänger): sevDesk " +
        "is to mark bank transactions it imports as private by the text below.",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Rule matches on", value: "counterparty (Auftraggeber/Empfänger)" },
      { label: "Text", value: "Netflix" },
      { label: "Open transactions examined", value: "3 (all open transactions)" },
      { label: "Look like what the rule is meant for (estimate)", value: "2" },
      {
        label: "Estimate: bank transaction 5101",
        value: "2026-11-03, -850.00 EUR, NETFLIX INTERNATIONAL B.V.",
      },
      { label: "Estimate: bank transaction 5103", value: "2026-11-03, -12.99 EUR, netflix.com" },
    ]);
    expect(plan.preview.warnings).toEqual([
      "sevDesk is expected to apply a rule on its own when it imports bank transactions: a " +
        "matching transaction is then marked private (Privatentnahme for money out, Privateinlage " +
        "for money in) and counts as neither business expense nor income. This could not be " +
        "tested: a trial account imports no bank transactions.",
      "The transactions listed are an estimate made here, not sevDesk's matching: open " +
        "(unbooked) transactions whose counterparty (Auftraggeber/Empfänger) contains the text, " +
        "ignoring case. How sevDesk matches a rule (whole text, part of it, case) is not known, " +
        "and when measured it changed neither existing transactions nor ones entered by hand. " +
        "Creating the rule changes none of the transactions listed; " +
        "sevdesk_transaction_mark_private marks one private.",
      "Corporations (GmbH, UG, AG) have no private withdrawals or deposits; for them such a " +
        "rule books wrongly.",
      "Undo: sevdesk_private_transaction_rule_delete. Transactions sevDesk has marked private " +
        "by then stay private (when measured, deleting rules changed no transaction); " +
        "sevdesk_transaction_reset sets one back.",
    ]);
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.previewDe.action).toBe(
      "Eine Regel für private Umsätze zum Auftraggeber/Empfänger anlegen: sevDesk soll " +
        "Kontoumsätze, die es von der Bank importiert, anhand des Textes unten als privat " +
        "markieren.",
    );
    expect(plan.previewDe.facts.map((fact) => fact.label)).toEqual([
      "Regel prüft",
      "Text",
      "Geprüfte offene Umsätze",
      "Vermutlich gemeint (Schätzung)",
      "Schätzung: Kontoumsatz 5101",
      "Schätzung: Kontoumsatz 5103",
    ]);
    expect(plan.previewDe.facts[4]?.value).toBe(
      "03.11.2026, -850,00 EUR, NETFLIX INTERNATIONAL B.V.",
    );
    expect(plan.previewDe.warnings[1]).toContain("eine Schätzung dieses Servers");
    // Only the text is sent: the field the user did not give is left out (recorded: null then).
    expect(plan.state.payload).toEqual({
      objectName: "PrivateTransactionRule",
      counterpartName: "Netflix",
    });
    expect(client.writes()).toEqual([]);
  });

  it("estimates a purpose rule on the purpose only", async () => {
    const client = new StagedClient(createReads([], TRANSACTIONS), []);
    const plan = await prepareWrite(createTool, { purpose: "netflix" }, client);
    expect(plan.preview.facts.slice(2)).toEqual([
      { label: "Open transactions examined", value: "3 (all open transactions)" },
      { label: "Look like what the rule is meant for (estimate)", value: "1" },
      {
        label: "Estimate: bank transaction 5102",
        value: "2026-11-03, -850.00 EUR, Netflix-Gutschein",
      },
    ]);
    expect(plan.preview.warnings[1]).toContain(
      "whose purpose (Verwendungszweck) contains the text",
    );
    expect(plan.state.payload).toEqual({
      objectName: "PrivateTransactionRule",
      paymentPurpose: "netflix",
    });
  });

  it("says none when no open transaction contains the text", async () => {
    const client = new StagedClient(createReads([], TRANSACTIONS), []);
    const plan = await prepareWrite(createTool, { counterparty: "Spotify" }, client);
    expect(plan.preview.facts[3]).toEqual({
      label: "Look like what the rule is meant for (estimate)",
      value: "none",
    });
    expect(plan.previewDe.facts[3]?.value).toBe("keiner");
  });

  it("bounds the estimate and says that the list was cut", async () => {
    const many = Array.from({ length: 501 }, (_, index) =>
      open(6000 + index, "Netflix", `Abo ${String(index)}`),
    );
    const client = new StagedClient(createReads([], many), []);
    const plan = await prepareWrite(createTool, { counterparty: "Netflix" }, client);
    expect(plan.preview.facts[2]).toEqual({
      label: "Open transactions examined",
      value: "500 (the newest 500 by value date; the list was cut)",
    });
    expect(plan.preview.facts[3]?.value).toBe("500, the first 10 listed below");
    expect(plan.preview.facts.filter((fact) => fact.label.startsWith("Estimate:"))).toHaveLength(
      10,
    );
    expect(plan.preview.warnings).toContain(
      "Only 500 open transactions were examined, the newest by value date: the list was cut, " +
        "and older ones may look like what the rule is meant for too.",
    );
    expect(plan.preview.warnings).toContain("Only the first 10 of 500 matches are listed by id.");
    expect(plan.previewDe.facts[2]?.value).toBe(
      "500 (die 500 neuesten nach Wertstellung; die Liste wurde gekürzt)",
    );
  });

  // The transaction scan also stops after 5000 rows read (MAX_SCAN_ROWS), e.g. when sevDesk
  // ignores status=100 and most rows are booked: then fewer than 500 open ones were examined.
  it("names the number examined when the row scan stops before 500 open transactions", async () => {
    const rows = Array.from({ length: 6000 }, (_, index) =>
      index < 30
        ? open(7000 + index, "Netflix", `Abo ${String(index)}`)
        : open(7000 + index, "Stadtwerke", "Strom", { status: "400" }),
    );
    const client = new StagedClient(createReads([], rows), []);
    const plan = await prepareWrite(createTool, { counterparty: "Netflix" }, client);
    expect(plan.preview.facts[2]).toEqual({
      label: "Open transactions examined",
      value: "30 (the newest 30 by value date; the list was cut)",
    });
    expect(plan.preview.warnings).toContain(
      "Only 30 open transactions were examined, the newest by value date: the list was cut, and " +
        "older ones may look like what the rule is meant for too.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Nur 30 offene Umsätze wurden geprüft, die neuesten nach Wertstellung: Die Liste wurde " +
        "gekürzt, und ältere können ebenfalls gemeint scheinen.",
    );
    expect(plan.preview.warnings.join(" ")).not.toContain("500");
  });

  it("names a single examined transaction without 'the newest 1'", async () => {
    const rows = Array.from({ length: 6000 }, (_, index) =>
      index === 0
        ? open(7000, "Netflix", "Abo")
        : open(7000 + index, "Stadtwerke", "Strom", { status: "400" }),
    );
    const client = new StagedClient(createReads([], rows), []);
    const plan = await prepareWrite(createTool, { counterparty: "Netflix" }, client);
    expect(plan.preview.facts[2]?.value).toBe("1 (the list was cut)");
    expect(plan.previewDe.facts[2]?.value).toBe("1 (die Liste wurde gekürzt)");
    expect(plan.preview.warnings).toContain(
      "Only 1 open transaction was examined, the newest by value date: the list was cut, and " +
        "older ones may look like what the rule is meant for too.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Nur 1 offener Umsatz wurde geprüft, der neueste nach Wertstellung: Die Liste wurde " +
        "gekürzt, und ältere können ebenfalls gemeint scheinen.",
    );
  });

  it.each([
    ["no text", {}, "Give the text the rule matches"],
    [
      "both texts",
      { counterparty: "Netflix", purpose: "Abo" },
      "sevDesk would store a rule with both, but whether it then needs both texts to match or " +
        "only one is not known",
    ],
    // Where rules act was never measured (D-099): the reason is hedged, not stated as a fact.
    [
      "a two-letter text",
      { counterparty: "AG" },
      "too short: it needs at least 4 letters or digits. sevDesk is expected to mark every bank " +
        "import a rule matches as private",
    ],
    ["three letters with spaces and dots", { purpose: "d. m. x" }, "at least 4 letters or digits"],
    ["an equal counterparty rule", { counterparty: "  vermieter   HUBER " }, "rule 951 already"],
    [
      "an equal purpose rule",
      { purpose: "MIETE privat" },
      "Private-transaction rule 970 already has this purpose text",
    ],
  ])("refuses %s before anything is sent", async (_label, args, text) => {
    const client = new StagedClient(
      createReads([EXISTING, ruleRow(970, { paymentPurpose: "Miete Privat" })], TRANSACTIONS),
      [POST],
    );
    const error = await prepareWrite(createTool, args, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as SevdeskError).message).toContain(text);
    expect((error as SevdeskError).message).toContain("Nothing was sent");
    expect(client.writes()).toEqual([]);
  });

  it("takes the same text on the other field for a different rule", async () => {
    const client = new StagedClient(createReads([EXISTING], TRANSACTIONS), []);
    const plan = await prepareWrite(createTool, { purpose: "Vermieter Huber" }, client);
    expect(plan.state.payload).toEqual({
      objectName: "PrivateTransactionRule",
      paymentPurpose: "Vermieter Huber",
    });
  });

  it.each([
    ["a line break", { counterparty: "Net\nflix" }],
    ["a text over 100 characters", { counterparty: "x".repeat(101) }],
    ["an empty text", { purpose: "   " }],
  ])("refuses %s in its arguments", (_label, args) => {
    expect(() => createTool.input.parse(args)).toThrow();
  });

  it("creates the rule once and confirms it in the list read afterwards", async () => {
    const client = new StagedClient(createReads([EXISTING], TRANSACTIONS), [
      POST,
      rulesRoute([EXISTING, NEW_RULE]),
    ]);
    const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/PrivateTransactionRule",
        tier: "commit",
        body: { objectName: "PrivateTransactionRule", counterpartName: "Netflix" },
      }),
    ]);
    expect(output.data.rule).toEqual({ id: 952, counterparty: "Netflix", createdOn: "2026-11-16" });
    expect(output.summary).toBe(
      "Private-transaction rule 952 created. sevDesk is expected to apply it when it imports " +
        "bank transactions (not testable on a trial account). When measured, rules did not " +
        "change existing transactions.",
    );
    expect(output.affected).toEqual([{ objectName: "PrivateTransactionRule", id: "952" }]);
  });

  describe("on an account with more than 1000 rules", () => {
    const others = Array.from({ length: 1000 }, (_, index) =>
      ruleRow(10_000 + index, { counterpartName: `Regel ${String(index)}` }),
    );

    it("refuses a duplicate found on page 2 of the rules", async () => {
      const client = new StagedClient(createReads([...others, EXISTING], TRANSACTIONS), [POST]);
      const error = await prepareWrite(
        createTool,
        { counterparty: "Vermieter Huber" },
        client,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: "validation" });
      expect((error as SevdeskError).message).toContain("rule 951 already");
      expect(client.writes()).toEqual([]);
    });

    // A recorded single page with a larger total: each read answers the same 1000 rules, so the
    // check reads five pages and then says that it stopped.
    it("names the rules read when the list goes on beyond five pages", async () => {
      const client = new StagedClient(
        [
          { path: "/PrivateTransactionRule", response: { body: { objects: others, total: 6000 } } },
          accountsListRoute(),
          listRoute("/CheckAccountTransaction", TRANSACTIONS),
        ],
        [],
      );
      const plan = await prepareWrite(createTool, { counterparty: "Netflix" }, client);
      expect(plan.preview.warnings).toContain(
        "sevDesk lists more than 5000 rules: the check for an equal rule read the oldest 5000 " +
          "only (sevDesk lists rules oldest first).",
      );
      expect(plan.previewDe.warnings).toContain(
        "sevDesk listet mehr als 5000 Regeln: Die Prüfung auf eine gleiche Regel las nur die " +
          "ältesten 5000 (sevDesk listet die ältesten Regeln zuerst).",
      );
      const offsets = client.before.calls
        .filter((call) => call.path === "/PrivateTransactionRule")
        .map((call) => call.query["offset"]);
      expect(offsets).toEqual([0, 1000, 2000, 3000, 4000]);
    });

    it("says nothing about the rules read when the list ends", async () => {
      const client = new StagedClient(createReads(others, TRANSACTIONS), []);
      const plan = await prepareWrite(createTool, { counterparty: "Netflix" }, client);
      expect(plan.preview.warnings.join(" ")).not.toContain("rules:");
    });

    /** The offsets of the rule reads after the POST. */
    function readBackOffsets(client: StagedClient): unknown[] {
      return client.after.calls
        .filter((call) => call.method === "GET" && call.path === "/PrivateTransactionRule")
        .map((call) => call.query["offset"]);
    }

    it("finds the new rule on a later page of the read-back", async () => {
      const client = new StagedClient(createReads([], []), [
        POST,
        rulesRoute([...others, NEW_RULE]),
      ]);
      const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
      expect(output.data.rule).toEqual({
        id: 952,
        counterparty: "Netflix",
        createdOn: "2026-11-16",
      });
      expect(output.summary).not.toContain("Note:");
      expect(readBackOffsets(client)).toEqual([0, 1000]);
    });

    it("still reports a rule missing from the whole list as created", async () => {
      const client = new StagedClient(createReads([], []), [
        POST,
        rulesRoute([...others, ruleRow(953, { counterpartName: "Spotify" })]),
      ]);
      const error = await executeWrite(createTool, { counterparty: "Netflix" }, client).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        kind: "unexpected_response",
        completedWrites: [{ objectName: "PrivateTransactionRule", id: "952" }],
      });
      expect(readBackOffsets(client)).toEqual([0, 1000]);
    });

    // sevDesk's order of rules is not recorded, so beyond the pages read the rule may well exist:
    // no "not in the list" error for a good write, but a note that the read-back did not reach it.
    it("takes the rule from the answer when the read-back does not reach it", async () => {
      const client = new StagedClient(createReads([], []), [
        POST,
        { path: "/PrivateTransactionRule", response: { body: { objects: others, total: 6000 } } },
      ]);
      const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
      expect(output.data.rule).toEqual({
        id: 952,
        counterparty: "Netflix",
        createdOn: "2026-11-16",
      });
      expect(output.summary).toContain(
        "Note: Rule 952 is not among the first 5000 rules sevDesk lists, so it is shown as " +
          "sevDesk answered the create and the text it stored was not checked; check it with " +
          "sevdesk_private_transaction_rules_list.",
      );
      expect(readBackOffsets(client)).toEqual([0, 1000, 2000, 3000, 4000]);
      expect(client.writes()).toHaveLength(1);
    });
  });

  it("reads the id from an answer that wraps the rule in an array", async () => {
    const client = new StagedClient(createReads([], []), [
      { ...POST, response: { body: { objects: [NEW_RULE] } } },
      rulesRoute([NEW_RULE]),
    ]);
    const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
    expect(output.data.rule.id).toBe(952);
  });

  it("notes when sevDesk stored another text than was sent", async () => {
    const client = new StagedClient(createReads([], []), [
      POST,
      rulesRoute([ruleRow(952, { counterpartName: "Netfli" })]),
    ]);
    const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
    expect(output.summary).toContain(
      "Note: sevDesk stored rule 952 with other texts than were sent",
    );
  });

  // sevDesk stores a text exactly as sent, spaces included (D-099): the tool sends it trimmed and
  // checks the stored text against the trimmed one.
  it("sends the text trimmed and finds it stored as sent", async () => {
    const client = new StagedClient(createReads([], []), [POST, rulesRoute([NEW_RULE])]);
    const { output } = await executeWrite(createTool, { counterparty: "  Netflix " }, client);
    expect(client.writes()[0]?.body).toEqual({
      objectName: "PrivateTransactionRule",
      counterpartName: "Netflix",
    });
    expect(output.summary).not.toContain("Note:");
  });

  it.each([
    ["with the spaces of an untrimmed text", "  Netflix "],
    ["cut short, as sevDesk cuts texts over 255 characters", "Netfl"],
  ])("notes a stored text %s", async (_label, stored) => {
    const client = new StagedClient(createReads([], []), [
      POST,
      rulesRoute([ruleRow(952, { counterpartName: stored })]),
    ]);
    const { output } = await executeWrite(createTool, { counterparty: "Netflix" }, client);
    expect(output.summary).toContain("Note: sevDesk stored rule 952 with other texts");
  });

  it("does not repeat the POST when the answer names no rule", async () => {
    const client = new StagedClient(createReads([], []), [
      { ...POST, response: { body: { objects: {} } } },
      rulesRoute([NEW_RULE]),
    ]);
    const error = await executeWrite(createTool, { counterparty: "Netflix" }, client).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "unexpected_response" });
    expect((error as SevdeskError).message).toContain("Do not repeat the call");
    expect(client.writes()).toHaveLength(1);
  });

  it("reports the rule as created when it is missing from the list afterwards", async () => {
    const client = new StagedClient(createReads([], []), [POST, rulesRoute([])]);
    const error = await executeWrite(createTool, { counterparty: "Netflix" }, client).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "PrivateTransactionRule", id: "952" }],
    });
  });

  it("reports the rule as created when the list cannot be read afterwards", async () => {
    const client = new StagedClient(createReads([], []), [
      POST,
      {
        path: "/PrivateTransactionRule",
        response: { error: new SevdeskError({ kind: "server", message: "sevDesk failed." }) },
      },
    ]);
    const error = await executeWrite(createTool, { counterparty: "Netflix" }, client).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      completedWrites: [{ objectName: "PrivateTransactionRule", id: "952" }],
    });
  });

  it("sends the POST once when sevDesk refuses it", async () => {
    const refused = new SevdeskError({ kind: "validation", message: "sevDesk refused it." });
    const client = new StagedClient(createReads([], []), [
      { ...POST, response: { error: refused } },
    ]);
    await expect(executeWrite(createTool, { counterparty: "Netflix" }, client)).rejects.toBe(
      refused,
    );
    expect(client.writes()).toHaveLength(1);
  });
});

describe("sevdesk_private_transaction_rule_delete", () => {
  const BOTH = ruleRow(980, { counterpartName: "Vermieter", paymentPurpose: "Miete" });
  const DELETE: FakeRoute = {
    method: "DELETE",
    path: "/PrivateTransactionRule/951",
    response: { body: { objects: [null] } },
  };

  it("is a commit tool that locks the account's rules and the rule", () => {
    expect(deleteTool.tier).toBe("commit");
    expect(deleteTool.annotations.destructiveHint).toBe(true);
    expect(deleteTool.locks?.({ id: 951 })).toEqual([
      ACCOUNT_PRIVATE_TRANSACTION_RULES,
      { objectName: "PrivateTransactionRule", id: "951" },
    ]);
  });

  it("previews the rule and says that private transactions stay private", async () => {
    const client = new StagedClient([rulesRoute([EXISTING, BOTH])], []);
    const plan = await prepareWrite(deleteTool, { id: 951 }, client);
    expect(plan.preview.action).toBe("Delete private-transaction rule 951.");
    expect(plan.preview.facts).toEqual([
      { label: "Private-transaction rule", value: "id 951" },
      { label: "Counterparty text (Auftraggeber/Empfänger)", value: "Vermieter Huber" },
      { label: "Created", value: "2026-11-16" },
    ]);
    expect(plan.preview.warnings).toEqual([
      "sevDesk is no longer expected to mark imported bank transactions private by this rule. " +
        "Where rules act, on bank imports, could not be tested on a trial account.",
      "Transactions already marked private stay private: when measured, deleting a rule changed " +
        "no transaction. sevdesk_transaction_reset sets one back to unbooked.",
      "Undo: create the rule again with sevdesk_private_transaction_rule_create; it gets a new id.",
    ]);
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.previewDe.action).toBe("Regel für private Umsätze 951 löschen.");
    expect(plan.previewDe.facts[2]).toEqual({ label: "Angelegt", value: "16.11.2026" });
    expect(client.writes()).toEqual([]);
  });

  it("shows both texts of a rule that has both (the spec allows it)", async () => {
    const client = new StagedClient([rulesRoute([BOTH])], []);
    const plan = await prepareWrite(deleteTool, { id: 980 }, client);
    expect(plan.preview.facts.slice(1, 3)).toEqual([
      { label: "Counterparty text (Auftraggeber/Empfänger)", value: "Vermieter" },
      { label: "Purpose text (Verwendungszweck)", value: "Miete" },
    ]);
  });

  it("refuses a rule that is not listed, before anything is sent", async () => {
    const client = new StagedClient([rulesRoute([BOTH])], [DELETE]);
    const error = await prepareWrite(deleteTool, { id: 951 }, client).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as SevdeskError).message).toBe(
      "There is no private-transaction rule 951; find the rules with " +
        "sevdesk_private_transaction_rules_list. Nothing was sent.",
    );
    expect(client.writes()).toEqual([]);
  });

  it("deletes the rule and confirms that it left the list", async () => {
    const client = new StagedClient([rulesRoute([EXISTING, BOTH])], [DELETE, rulesRoute([BOTH])]);
    const { output } = await executeWrite(deleteTool, { id: 951 }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: "/PrivateTransactionRule/951",
        tier: "commit",
      }),
    ]);
    expect(output.data.rule).toEqual({
      id: 951,
      counterparty: "Vermieter Huber",
      createdOn: "2026-11-16",
    });
    expect(output.summary).toBe(
      "Private-transaction rule 951 deleted; transactions already marked private are unchanged.",
    );
    expect(output.affected).toEqual([{ objectName: "PrivateTransactionRule", id: "951" }]);
  });

  it("does not take a 2xx for a deletion while the rule is still listed", async () => {
    const client = new StagedClient([rulesRoute([EXISTING])], [DELETE, rulesRoute([EXISTING])]);
    const error = await executeWrite(deleteTool, { id: 951 }, client).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "PrivateTransactionRule", id: "951" }],
    });
  });
});
