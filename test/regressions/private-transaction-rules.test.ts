/**
 * Private-transaction rules (#88, spec/deviations.md D-099): a rule makes sevDesk mark bank
 * transactions private on its own, so creating one is `commit` like marking one transaction
 * private. Two traps, each checked through the whole tool call:
 *
 * - No rule is created without a human's confirmation: a declined prompt and a dry run send
 *   nothing.
 * - sevDesk's matching is not measured, and two recorded rules changed no existing transaction.
 *   The preview's list of open transactions is a local estimate: it must say so, and never say
 *   that a transaction will become private.
 */
import { describe, expect, it } from "vitest";

import {
  privateRuleCreateTool,
  privateRuleDeleteTool,
} from "../../src/tools/banking/private-rules.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  accountsListRoute,
  listRoute,
  transactionRow,
} from "../unit/domain/reconciliation/helpers.js";

closeWriteHarnessesAfterEach();

const RULE = {
  id: "951",
  objectName: "PrivateTransactionRule",
  additionalInformation: null,
  create: "2026-11-16T21:10:00+01:00",
  update: "2026-11-16T21:10:00+01:00",
  sevClient: { id: "1", objectName: "SevClient" },
  paymentPurpose: null,
  counterpartName: "Vermieter Huber",
};

const ROUTES: readonly FakeRoute[] = [
  listRoute("/PrivateTransactionRule", [RULE]),
  accountsListRoute(),
  listRoute("/CheckAccountTransaction", [
    transactionRow({
      id: "5101",
      payeePayerName: "Netflix",
      paymtPurpose: "Abo",
      amount: "-12.99",
    }),
  ]),
  {
    method: "POST",
    path: "/PrivateTransactionRule",
    response: { body: { objects: { ...RULE, id: "952", counterpartName: "Netflix" } } },
  },
  {
    method: "DELETE",
    path: "/PrivateTransactionRule/951",
    response: { body: { objects: [null] } },
  },
];

async function harness(answer: "accept" | "decline") {
  return writeHarness({
    tools: [privateRuleCreateTool, privateRuleDeleteTool],
    routes: ROUTES,
    connect: {
      answer: () =>
        answer === "accept"
          ? { action: "accept", content: { approve: true } }
          : { action: "decline" },
    },
  });
}

describe("no rule is created or deleted without a confirmation", () => {
  it.each([
    ["sevdesk_private_transaction_rule_create", { counterparty: "Netflix" }],
    ["sevdesk_private_transaction_rule_delete", { id: 951 }],
  ])("%s sends nothing when the human declines", async (name, args) => {
    const { client, fake, prompts } = await harness("decline");
    await client.callTool({ name, arguments: args });
    expect(prompts).toHaveLength(1);
    expect(writesOf(fake)).toEqual([]);
  });

  it.each([
    ["sevdesk_private_transaction_rule_create", { counterparty: "Netflix" }],
    ["sevdesk_private_transaction_rule_delete", { id: 951 }],
  ])("%s sends nothing in a dry run and asks nobody", async (name, args) => {
    const { client, fake, prompts } = await harness("accept");
    const result = await client.callTool({ name, arguments: { ...args, dryRun: true } });
    expect(result.isError).not.toBe(true);
    expect(prompts).toEqual([]);
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("the preview never states a match as a fact", () => {
  it("labels the open transactions as an estimate and promises no private marking", async () => {
    const { client, fake, prompts } = await harness("decline");
    await client.callTool({
      name: "sevdesk_private_transaction_rule_create",
      arguments: { counterparty: "Netflix" },
    });
    const shown = prompts[0]?.message ?? "";
    expect(shown).toContain("Estimate: bank transaction 5101");
    expect(shown).toContain("(estimate)");
    expect(shown).toContain("an estimate made here, not sevDesk's matching");
    // Where rules act was never measured (D-099): hedged, never stated as a fact.
    expect(shown).toContain(
      "sevDesk is expected to apply a rule on its own when it imports bank transactions",
    );
    expect(shown).not.toMatch(/sevDesk (?:applies|marks)\b/);
    expect(shown).not.toMatch(/\b(?:will|would)\s+(?:be\s+marked|become)\s+private\b/i);
    expect(shown).not.toMatch(/\bmatches\s*:/i);
    expect(writesOf(fake)).toEqual([]);
  });

  it("says the same in a dry run's preview", async () => {
    const { client } = await harness("accept");
    const result = await client.callTool({
      name: "sevdesk_private_transaction_rule_create",
      arguments: { counterparty: "Netflix", dryRun: true },
    });
    const text = resultText(result);
    expect(text).toContain("Estimate: bank transaction 5101");
    expect(text).not.toMatch(/\b(?:will|would)\s+(?:be\s+marked|become)\s+private\b/i);
  });
});
