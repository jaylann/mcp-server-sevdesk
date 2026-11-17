/**
 * The private-transaction rules (Regeln für private Umsätze): `sevdesk_private_transaction_rules_list`
 * (read), `sevdesk_private_transaction_rule_create` and `sevdesk_private_transaction_rule_delete`
 * (both commit). Reads, checks, the estimate and the requests:
 * `src/domain/private-transaction-rules.ts`.
 *
 * Tiers: marking one transaction private is `commit` (`sevdesk_transaction_mark_private`), and a
 * rule makes sevDesk do that on its own for future bank imports, so creating and deleting rules is
 * `commit` too: a human confirms the preview.
 */
import { z } from "zod";

import { type Fact, formatMoney } from "../../domain/lifecycle/preview.js";
import { pageOutput, pageOutputShape, pageSummary, pagingInputShape } from "../../domain/paging.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import {
  ESTIMATE_LISTED_MAX,
  executePrivateRuleCreate,
  executePrivateRuleDelete,
  listPrivateRules,
  planPrivateRuleCreate,
  planPrivateRuleDelete,
  type PrivateRuleCreatePlan,
  type PrivateRuleDto,
  privateRuleDtoSchema,
  RULE_TEXT_MAX,
  RULE_TEXT_MIN,
  type RuleField,
  ruleObject,
} from "../../domain/private-transaction-rules.js";
import { defineTool, defineWriteTool } from "../define-tool.js";
import { ACCOUNT_PRIVATE_TRANSACTION_RULES } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, READ_ANNOTATIONS } from "./reconcile-shared.js";

/**
 * Where rules act, for the results the model reads (English only, like every summary): sevDesk is
 * expected to apply rules on bank imports, but that could not be measured (D-099), so it is never
 * stated as a fact.
 */
function whereRulesAct(pronoun: "it" | "them"): string {
  return (
    `sevDesk is expected to apply ${pronoun} when it imports bank transactions (not testable on ` +
    "a trial account)."
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export const privateRulesListTool = defineTool({
  name: "sevdesk_private_transaction_rules_list",
  title: "List sevDesk private-transaction rules",
  description:
    "List the private-transaction rules (Regeln für private Umsätze): texts by which sevDesk " +
    "marks bank transactions as private (Privatentnahme/Privateinlage) on its own when it " +
    "imports them from the bank. Each rule has a counterparty text (Auftraggeber/Empfänger), a " +
    "purpose text (Verwendungszweck) or both. Create or delete one with " +
    "sevdesk_private_transaction_rule_create / sevdesk_private_transaction_rule_delete.",
  toolset: "banking",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({ ...pagingInputShape({ limit: 50, max: 200 }) }),
  output: z.object({ items: z.array(privateRuleDtoSchema), ...pageOutputShape }),
  handler: async (args, ctx) => {
    const page = await listPrivateRules(
      ctx.client,
      { limit: args.limit, offset: args.offset },
      ctx.signal,
    );
    const summary = pageSummary("Private-transaction rules", page.window, page.state);
    return {
      data: { items: [...page.items], ...pageOutput(page.window, page.state, args.limit) },
      summary: page.items.length === 0 ? summary : `${summary} ${whereRulesAct("them")}`,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------------------------

/** How a preview names what a rule matches on. */
const FIELD_TEXT: Readonly<Record<RuleField, Phrase>> = {
  counterparty: phrase("counterparty (Auftraggeber/Empfänger)", "Auftraggeber/Empfänger"),
  purpose: phrase("purpose (Verwendungszweck)", "Verwendungszweck"),
};

/** Where rules take effect, and that this could not be tested. */
const WHERE_RULES_ACT = phrase(
  "sevDesk applies a rule on its own when it imports bank transactions: a matching transaction " +
    "is then marked private (Privatentnahme for money out, Privateinlage for money in) and counts " +
    "as neither business expense nor income. This could not be tested: a trial account imports " +
    "no bank transactions.",
  "sevDesk wendet eine Regel selbst an, wenn es Kontoumsätze von der Bank importiert: Ein " +
    "passender Umsatz wird dann als privat markiert (Privatentnahme bei Ausgängen, Privateinlage " +
    "bei Eingängen) und zählt weder als Betriebsausgabe noch als Betriebseinnahme. Getestet " +
    "werden konnte das nicht: Ein Testkonto importiert keine Kontoumsätze.",
);

const CORPORATIONS = phrase(
  "Corporations (GmbH, UG, AG) have no private withdrawals or deposits; for them such a rule " +
    "books wrongly.",
  "Kapitalgesellschaften (GmbH, UG, AG) kennen keine Privatentnahmen oder Privateinlagen; dort " +
    "führt eine solche Regel zu falschen Buchungen.",
);

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** A rule text argument: one line, trimmed. */
function ruleTextInput(what: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(RULE_TEXT_MAX)
    .regex(/^[^\r\n]*$/, { message: "expected one line" })
    .optional()
    .describe(
      `${what}, at least ${String(RULE_TEXT_MIN)} letters or digits. Give this or the other ` +
        "text, not both.",
    );
}

export const privateRuleCreateTool = defineWriteTool({
  name: "sevdesk_private_transaction_rule_create",
  title: "Create a sevDesk private-transaction rule",
  description:
    "Create a private-transaction rule (Regel für private Umsätze): sevDesk then marks bank " +
    "transactions it imports from the bank as private (Privatentnahme/Privateinlage) on its own " +
    "when their counterparty (Auftraggeber/Empfänger) or purpose (Verwendungszweck) matches the " +
    "text. One text per rule. It does not change existing transactions; how sevDesk matches is " +
    "not known. The preview lists open transactions that look like what the rule is meant for, " +
    "as an estimate. Only for sole proprietors and partnerships, not for a GmbH or UG. Refuses " +
    "a text equal to an existing rule's and one that is too short. Commit tier: asks a human " +
    "to confirm the preview; dryRun only previews. Undo: sevdesk_private_transaction_rule_delete. " +
    "Existing rules: sevdesk_private_transaction_rules_list.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    counterparty: ruleTextInput(
      "Counterparty (Auftraggeber/Empfänger) text to match, e.g. a landlord's name",
    ),
    purpose: ruleTextInput("Purpose (Verwendungszweck) text to match"),
    ...dryRunInputShape,
  }),
  output: z.object({
    rule: privateRuleDtoSchema.describe(
      "The new rule as read back (as sevDesk answered the create when the read-back did not " +
        "reach it; the summary says so).",
    ),
  }),
  // "No rule has this text" is checked, then the rule is created: two calls at once would both
  // pass the check.
  locks: () => [ACCOUNT_PRIVATE_TRANSACTION_RULES],
  prepare: async (args, ctx) => {
    const plan = await planPrivateRuleCreate(
      ctx.client,
      { counterparty: args.counterparty, purpose: args.purpose },
      ctx.signal,
    );
    const warnings = createWarnings(plan);
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Eine Regel für private Umsätze zum ${FIELD_TEXT[plan.field].de} anlegen: sevDesk ` +
              "soll Kontoumsätze, die es von der Bank importiert, anhand des Textes unten als " +
              "privat markieren."
            : `Create a private-transaction rule on the ${FIELD_TEXT[plan.field].en}: sevDesk is ` +
              "to mark bank transactions it imports as private by the text below.",
        facts: createFacts(plan, lang),
        warnings: warnings.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state: { payload: plan.payload },
    };
  },
  execute: async (_args, plan, ctx) => {
    const { rule, notes } = await executePrivateRuleCreate(
      ctx.client,
      plan.state.payload,
      ctx.signal,
    );
    const summary =
      `Private-transaction rule ${String(rule.id)} created. ${whereRulesAct("it")} When ` +
      "measured, rules did not change existing transactions.";
    return {
      data: { rule },
      summary: notes.length === 0 ? summary : `${summary} Note: ${notes.join(" ")}`,
      affected: [ruleObject(rule.id)],
    };
  },
});

/** The facts of a new rule: what it matches, then the estimate (labelled as one) in both languages. */
function createFacts(plan: PrivateRuleCreatePlan, lang: PreviewLanguage): Fact[] {
  const de = lang === "de";
  const { estimate } = plan;
  const examined = de
    ? `${String(estimate.examined)} ` +
      (estimate.complete
        ? "(alle offenen Umsätze)"
        : `(die ersten ${String(estimate.examined)}; die Liste wurde gekürzt)`)
    : `${String(estimate.examined)} ` +
      (estimate.complete
        ? "(all open transactions)"
        : `(the first ${String(estimate.examined)}; the list was cut)`);
  const listed = estimate.listed.length;
  const matches =
    estimate.matches === 0
      ? de
        ? "keiner"
        : "none"
      : String(estimate.matches) +
        (estimate.matches > listed
          ? de
            ? `, die ersten ${String(listed)} unten`
            : `, the first ${String(listed)} listed below`
          : "");
  const facts: Fact[] = [
    { label: de ? "Regel prüft" : "Rule matches on", value: FIELD_TEXT[plan.field][lang] },
    { label: "Text", value: plan.text },
    {
      label: de ? "Geprüfte offene Umsätze" : "Open transactions examined",
      value: examined,
    },
    {
      label: de
        ? "Vermutlich gemeint (Schätzung)"
        : "Look like what the rule is meant for (estimate)",
      value: matches,
    },
  ];
  for (const row of estimate.listed) {
    const text = (plan.field === "counterparty" ? row.counterparty : row.purpose) ?? "";
    const parts = [
      row.valueDate === undefined ? undefined : dateText(row.valueDate, lang),
      formatMoney(row.amount, lang),
      text,
    ].filter((part): part is string => part !== undefined && part !== "");
    facts.push({
      label: de
        ? `Schätzung: Kontoumsatz ${String(row.id)}`
        : `Estimate: bank transaction ${String(row.id)}`,
      value: parts.join(", "),
    });
  }
  return facts;
}

/** The consequences of a new rule, in the order both previews show them. */
function createWarnings(plan: PrivateRuleCreatePlan): Phrase[] {
  const { estimate, field } = plan;
  const where = FIELD_TEXT[field];
  const warnings: Phrase[] = [
    WHERE_RULES_ACT,
    phrase(
      "The transactions listed are an estimate made here, not sevDesk's matching: open " +
        `(unbooked) transactions whose ${where.en} contains the text, ignoring case. How sevDesk ` +
        "matches a rule (whole text, part of it, case) is not known, and when measured it changed " +
        "neither existing transactions nor ones entered by hand. Creating the rule changes none " +
        "of the transactions listed; sevdesk_transaction_mark_private marks one private.",
      "Die aufgeführten Umsätze sind eine Schätzung dieses Servers, nicht sevDesks Abgleich: " +
        `offene (ungebuchte) Umsätze, deren ${where.de} den Text enthält, ohne Rücksicht auf ` +
        "Groß- und Kleinschreibung. Wie sevDesk eine Regel abgleicht (ganzer Text, Teil davon, " +
        "Schreibweise), ist nicht bekannt, und bei der Messung änderte es weder bestehende noch " +
        "von Hand erfasste Umsätze. Das Anlegen der Regel ändert keinen der aufgeführten " +
        "Umsätze; sevdesk_transaction_mark_private markiert einen davon als privat.",
    ),
  ];
  if (!estimate.complete) {
    // The number actually examined: the scan stops at 500 open transactions, or earlier when
    // listTransactions reaches its cap of rows read (most of them booked).
    const count = estimate.examined;
    warnings.push(
      phrase(
        `Only ${String(count)} open ${count === 1 ? "transaction was" : "transactions were"} ` +
          "examined: the list was cut, and more may look like what the rule is meant for.",
        `Nur ${String(count)} ${count === 1 ? "offener Umsatz wurde" : "offene Umsätze wurden"} ` +
          "geprüft: Die Liste wurde gekürzt, und weitere können gemeint scheinen.",
      ),
    );
  }
  if (estimate.matches > estimate.listed.length) {
    warnings.push(
      phrase(
        `Only the first ${String(ESTIMATE_LISTED_MAX)} of ${String(estimate.matches)} matches ` +
          "are listed by id.",
        `Nur die ersten ${String(ESTIMATE_LISTED_MAX)} von ${String(estimate.matches)} ` +
          "Treffern sind mit ID aufgeführt.",
      ),
    );
  }
  if (!plan.rulesComplete) {
    warnings.push(
      phrase(
        "sevDesk lists more than 1000 rules: the check for an equal rule read the first 1000 " +
          "only.",
        "sevDesk listet mehr als 1000 Regeln: Die Prüfung auf eine gleiche Regel las nur die " +
          "ersten 1000.",
      ),
    );
  }
  warnings.push(
    CORPORATIONS,
    phrase(
      "Undo: sevdesk_private_transaction_rule_delete. Transactions sevDesk has marked private " +
        "by then stay private (when measured, deleting rules changed no transaction); " +
        "sevdesk_transaction_reset sets one back.",
      "Rückgängig: sevdesk_private_transaction_rule_delete. Umsätze, die sevDesk bis dahin als " +
        "privat markiert hat, bleiben privat (bei der Messung änderte das Löschen von Regeln " +
        "keinen Umsatz); sevdesk_transaction_reset setzt einen davon zurück.",
    ),
  );
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

const DELETE_WARNINGS: readonly Phrase[] = [
  phrase(
    "sevDesk no longer marks imported bank transactions private by this rule. Where rules act, on " +
      "bank imports, could not be tested on a trial account.",
    "sevDesk markiert importierte Kontoumsätze danach nicht mehr nach dieser Regel als privat. " +
      "Wo Regeln wirken, beim Bankimport, ließ sich auf einem Testkonto nicht testen.",
  ),
  phrase(
    "Transactions already marked private stay private: when measured, deleting a rule changed no " +
      "transaction. sevdesk_transaction_reset sets one back to unbooked.",
    "Bereits als privat markierte Umsätze bleiben privat: Bei der Messung änderte das Löschen " +
      "einer Regel keinen Umsatz. sevdesk_transaction_reset setzt einen davon auf ungebucht " +
      "zurück.",
  ),
  phrase(
    "Undo: create the rule again with sevdesk_private_transaction_rule_create; it gets a new id.",
    "Rückgängig: die Regel mit sevdesk_private_transaction_rule_create neu anlegen; sie erhält " +
      "eine neue ID.",
  ),
];

export const privateRuleDeleteTool = defineWriteTool({
  name: "sevdesk_private_transaction_rule_delete",
  title: "Delete a sevDesk private-transaction rule",
  description:
    "Delete a private-transaction rule (Regel für private Umsätze), so sevDesk no longer marks " +
    "imported bank transactions private by it. Transactions already marked private stay private " +
    "(sevdesk_transaction_reset sets one back). Commit tier: asks a human to confirm the " +
    "preview; dryRun only previews. Rule ids: sevdesk_private_transaction_rules_list.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Rule id, from sevdesk_private_transaction_rules_list."),
    ...dryRunInputShape,
  }),
  output: z.object({ rule: privateRuleDtoSchema.describe("The deleted rule, as it was.") }),
  // The rule is found in the list, then deleted and the list read back.
  locks: (args) => [ACCOUNT_PRIVATE_TRANSACTION_RULES, ruleObject(args.id)],
  prepare: async (args, ctx) => {
    const { rule } = await planPrivateRuleDelete(ctx.client, args.id, ctx.signal);
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Regel für private Umsätze ${String(rule.id)} löschen.`
            : `Delete private-transaction rule ${String(rule.id)}.`,
        facts: ruleFacts(rule, lang),
        warnings: DELETE_WARNINGS.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state: { rule },
    };
  },
  execute: async (args, plan, ctx) => {
    await executePrivateRuleDelete(ctx.client, args.id, ctx.signal);
    return {
      data: { rule: plan.state.rule },
      summary:
        `Private-transaction rule ${String(args.id)} deleted; transactions already marked private ` +
        "are unchanged.",
      affected: [ruleObject(args.id)],
    };
  },
});

/** A listed rule as preview facts (texts: cleaned sevDesk text). */
function ruleFacts(rule: PrivateRuleDto, lang: PreviewLanguage): Fact[] {
  const de = lang === "de";
  const facts: Fact[] = [
    {
      label: de ? "Regel für private Umsätze" : "Private-transaction rule",
      value: `${de ? "ID" : "id"} ${String(rule.id)}`,
    },
  ];
  if (rule.counterparty !== undefined) {
    facts.push({
      label: de ? "Text zu Auftraggeber/Empfänger" : "Counterparty text (Auftraggeber/Empfänger)",
      value: rule.counterparty,
    });
  }
  if (rule.purpose !== undefined) {
    facts.push({
      label: de ? "Text zum Verwendungszweck" : "Purpose text (Verwendungszweck)",
      value: rule.purpose,
    });
  }
  if (rule.createdOn !== undefined) {
    facts.push({ label: de ? "Angelegt" : "Created", value: dateText(rule.createdOn, lang) });
  }
  return facts;
}
