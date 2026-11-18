/**
 * Check `reverse_charge` of `sevdesk_records_audit`: the § 13b base of a period, split by tax rule,
 * with the documents behind each sum.
 *
 * - **received** (rules 12, 13, 14): purchases on which this account owes the VAT as recipient.
 *   The base is the net of the positions; the tax owed is base × rate, with sevDesk's 0 %
 *   positions taxed at the regular 19 % (sevDesk's rule names say "0% (19%)"), exactly as
 *   `sevdesk_vat_summary` does (`ustvaTarget`); rules 12 and 14 deduct it again as input VAT
 *   (§ 15 Abs. 1 Satz 1 Nr. 4 UStG, Kz 67), rule 13 does not.
 * - **issued** (rules 5, 21): sales on which the customer owes the VAT: § 13b Abs. 5 UStG
 *   (rule 5, Kz 60) and services to businesses in other EU states (rule 21, Kz 21).
 *
 * Period: like the UStVA, by tax point (`taxPoint` with the rule's timing): rule 14 at the end of
 * the period of the service (§ 13b Abs. 1 UStG), rules 12 and 13 with the invoice, at the latest
 * at the end of the month after the supply (§ 13b Abs. 2 UStG), rules 5 and 21 at the end of the
 * supply. Documents are listed with the VAT summary's margin around the period
 * (`ACCRUAL_MARGIN_DAYS`), so the bases match its Kz 46, 84, 60 and 21 for the same period. The
 * tax can differ by a cent: it is rounded here per rule and rate, there per form line and rate,
 * and Kz 84/85 combine rules 12 and 13.
 *
 * Findings, against the account's regime today:
 * - rule 13 (§ 13b without input VAT deduction) on an account with regular taxation, which costs
 *   the tax unless deduction is excluded for reasons sevDesk does not know (`check`);
 * - rules 12 and 14 (with deduction) on a Kleinunternehmer account, which owes the tax but may not
 *   deduct it (`warning`: wrong unless the account used regular taxation then). Whether sevDesk
 *   lets a Kleinunternehmer account pick rule 12 or 14 at all is not recorded; if it does not,
 *   this finding never fires.
 */
import { z } from "zod";

import { loadAccountSettings, type TaxRegime, taxRegimeOf } from "../../account-settings.js";
import { moneySchema } from "../../common.js";
import { add, type Decimal, decimal } from "../../money.js";
import {
  type DocumentHeader,
  listDocumentHeaders,
  pagedRangesNote,
  percentOf,
  scanPositions,
} from "../positions-scan.js";
import { plural, shiftDays } from "../shared.js";
import { ustvaLine, ustvaTarget, type VatDirection } from "../ustva-boxes.js";
import { ACCRUAL_MARGIN_DAYS, taxPoint } from "../vat.js";
import {
  type AuditCheckContext,
  type AuditCheckResult,
  auditRecordSchema,
  byDateThenId,
  eur,
  excludedOf,
  type FindingDraft,
  type FindingText,
  recordOf,
  scanNotes,
  taxRuleRef,
  taxRuleRefSchema,
} from "./findings.js";

/** Rules under which this account owes the VAT as recipient (expenses). */
const RECEIVED_RULES: ReadonlySet<number> = new Set([12, 13, 14]);
/** Rules under which the customer owes the VAT (revenue). */
const ISSUED_RULES: ReadonlySet<number> = new Set([5, 21]);
/** Documents listed per tax rule (the sums cover all of them). */
const MAX_SECTION_RECORDS = 50;

export const REVERSE_CHARGE_FINDING_CODES = [
  "reverse_charge_without_deduction",
  "reverse_charge_deduction_on_small_business",
] as const;
type ReverseChargeFindingCode = (typeof REVERSE_CHARGE_FINDING_CODES)[number];

const WITHOUT_DEDUCTION: FindingText = {
  severity: "check",
  title: "§ 13b without input VAT deduction on a regular account",
  titleDe: "§ 13b ohne Vorsteuerabzug bei Regelbesteuerung",
  reason:
    "Rule 13 books the tax owed as recipient (§ 13b UStG) without deducting it. The account " +
    "uses regular taxation today, and a business with input VAT deduction deducts that tax " +
    "again (§ 15 Abs. 1 Satz 1 Nr. 4 UStG; rules 12 and 14), so rule 13 costs the tax. It is " +
    "right where deduction is excluded: tax-exempt activities (§ 15 Abs. 2 UStG, e.g. doctors, " +
    "insurance brokers), purchases for non-business use, or a period in which the account was " +
    "a Kleinunternehmer.",
  action:
    "Check whether the purchase is for business use with input VAT deduction; then book it " +
    "under rule 12, or under rule 14 for a service of a business in another EU state.",
};

const DEDUCTION_ON_SMALL_BUSINESS: FindingText = {
  severity: "warning",
  title: "§ 13b with input VAT deduction on a Kleinunternehmer account",
  titleDe: "§ 13b mit Vorsteuerabzug bei Kleinunternehmerregelung",
  reason:
    "Rules 12 and 14 book the tax owed as recipient (§ 13b UStG) and deduct it again as input " +
    "VAT (§ 15 Abs. 1 Satz 1 Nr. 4 UStG). The account uses the Kleinunternehmer regulation " +
    "today: a Kleinunternehmer owes that tax too (§ 13b Abs. 5 UStG) but may not deduct input " +
    "VAT (§ 19 Abs. 1 UStG), so the booking leaves out tax that is due. It is right only for a " +
    "period in which the account used regular taxation.",
  action:
    "Check which regulation the account used when the purchase was made; as a Kleinunternehmer, " +
    "book it under rule 13 (§ 13b without input VAT deduction).",
};

/** The finding of each rule on an account of `regime`, if any. */
function findingFor(
  rule: number,
  regime: TaxRegime | undefined,
): { readonly code: ReverseChargeFindingCode; readonly text: FindingText } | undefined {
  if (regime === "regular" && rule === 13) {
    return { code: "reverse_charge_without_deduction", text: WITHOUT_DEDUCTION };
  }
  if (regime === "small_business" && (rule === 12 || rule === 14)) {
    return {
      code: "reverse_charge_deduction_on_small_business",
      text: DEDUCTION_ON_SMALL_BUSINESS,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const ruleSumSchema = z.object({
  taxRule: taxRuleRefSchema,
  ustva: z
    .object({
      baseKz: z.string(),
      taxKz: z.string().optional(),
      inputTaxKz: z.string().optional(),
    })
    .describe("Where the amounts go in the UStVA (2026 form)."),
  base: moneySchema.describe("Net base (Bemessungsgrundlage) in EUR; credit notes reduce it."),
  tax: moneySchema
    .optional()
    .describe("received: the tax owed as recipient (base × rate, computed on the sum per rate)."),
  inputTax: moneySchema
    .optional()
    .describe("received: the part deducted again as input VAT (rules 12 and 14; rule 13 none)."),
  recipientTaxAssumed: z
    .boolean()
    .optional()
    .describe("True when 0 % positions were taxed at the regular 19 %, as sevDesk's rule says."),
  documents: z.number().int(),
  records: z
    .array(auditRecordSchema)
    .describe(
      `The documents behind the sum by tax point, at most ${String(MAX_SECTION_RECORDS)}; ` +
        "net and tax per document.",
    ),
  recordsOmitted: z.number().int().optional(),
});

export const reverseChargeSectionSchema = z.object({
  received: z
    .array(ruleSumSchema)
    .describe("Purchases on which this account owes the VAT as recipient: rules 12, 13, 14."),
  issued: z
    .array(ruleSumSchema)
    .describe(
      "Sales on which the customer owes the VAT: rule 5 (§ 13b Abs. 5 UStG) and rule 21 " +
        "(services to businesses in other EU states).",
    ),
  totals: z
    .object({ base: moneySchema, tax: moneySchema, inputTax: moneySchema })
    .describe("received, over all rules: tax − inputTax is what § 13b adds to the payment."),
});

export type ReverseChargeSection = z.output<typeof reverseChargeSectionSchema>;

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

type Side = "received" | "issued";

interface SelectedDocument {
  readonly header: DocumentHeader;
  readonly side: Side;
  readonly taxPoint: string;
}

/** One document's share of a rule's sum. */
interface DocumentSum {
  readonly header: DocumentHeader;
  readonly taxPoint: string;
  readonly net: Decimal;
  readonly tax: Decimal | undefined;
}

interface RuleAccumulator {
  readonly rule: number;
  readonly side: Side;
  base: Decimal;
  /** Base per recipient rate (received), taxed once per rate like the UStVA line. */
  readonly perRate: Map<string, Decimal>;
  assumed: boolean;
  readonly documents: DocumentSum[];
}

function sideOf(header: DocumentHeader): Side | undefined {
  const rule = header.taxRuleId;
  if (rule === undefined) return undefined;
  if (header.direction === "expense" && RECEIVED_RULES.has(rule)) return "received";
  if (header.direction === "revenue" && ISSUED_RULES.has(rule)) return "issued";
  return undefined;
}

async function runReverseChargeCheck(
  context: AuditCheckContext,
): Promise<AuditCheckResult & { readonly reverseCharge: ReverseChargeSection }> {
  const { client, period, options, limits } = context;
  const settings = await loadAccountSettings(client, {
    cacheOwner: context.cacheOwner,
    signal: options.signal,
  });
  const regime = taxRegimeOf(settings);
  const listed = await listDocumentHeaders(
    client,
    {
      from: shiftDays(period.from, -ACCRUAL_MARGIN_DAYS),
      to: shiftDays(period.to, ACCRUAL_MARGIN_DAYS),
      maxRows: limits?.maxRows,
      today: context.today,
    },
    options,
  );

  const selected: SelectedDocument[] = [];
  let legacy = 0;
  for (const header of listed.headers) {
    const side = sideOf(header);
    const rule = header.taxRuleId;
    if (side === undefined || rule === undefined || header.direction === undefined) {
      const date = header.date ?? "";
      if (header.legacyTaxType === "eu" && date >= period.from && date <= period.to) legacy += 1;
      continue;
    }
    const target = ustvaTarget(rule, header.direction, "0");
    if (target.kind !== "line") continue;
    const point = taxPoint(header, target.timing).date;
    if (point === undefined || point < period.from || point > period.to) continue;
    selected.push({ header, side, taxPoint: point });
  }

  const scan = await scanPositions(
    client,
    selected.map((entry) => entry.header),
    {
      maxDocuments: limits?.maxDocuments,
      signal: options.signal,
      onProgress: options.onProgress,
      deadline: options.deadline,
    },
  );
  const byHeader = new Map(selected.map((entry) => [entry.header, entry]));
  const sums = new Map<number, RuleAccumulator>();
  for (const document of scan.documents) {
    const entry = byHeader.get(document.header);
    const rule = document.header.taxRuleId;
    const direction: VatDirection | undefined = document.header.direction;
    if (entry === undefined || rule === undefined || direction === undefined) continue;
    const sum = sums.get(rule) ?? {
      rule,
      side: entry.side,
      base: decimal(0),
      perRate: new Map<string, Decimal>(),
      assumed: false,
      documents: [],
    };
    let net = decimal(0);
    let tax = decimal(0);
    for (const group of document.groups) {
      net = add(net, group.net);
      const target = ustvaTarget(rule, direction, group.rate);
      if (entry.side !== "received" || target.kind !== "line") continue;
      if (target.recipientRate === undefined) continue;
      const rate = target.recipientRate;
      sum.perRate.set(rate, add(sum.perRate.get(rate) ?? decimal(0), group.net));
      tax = add(tax, percentOf(group.net, rate));
      sum.assumed ||= target.assumedRate === true;
    }
    sum.base = add(sum.base, net);
    sum.documents.push({
      header: document.header,
      taxPoint: entry.taxPoint,
      net,
      tax: entry.side === "received" ? tax : undefined,
    });
    sums.set(rule, sum);
  }

  const section = sectionOf([...sums.values()]);
  const drafts: FindingDraft[] = [...sums.values()].flatMap((sum) => {
    const found = findingFor(sum.rule, regime);
    if (found === undefined) return [];
    return sum.documents.map((document) => ({
      code: found.code,
      text: found.text,
      contact:
        document.header.contact === undefined
          ? undefined
          : { id: document.header.contact.id, name: document.header.contact.name },
      header: document.header,
    }));
  });

  const incomplete = scan.documents.filter((document) => !document.positionsComplete).length;
  const notes = [
    "§ 13b amounts count in the period of their tax point, as in sevdesk_vat_summary: rule 14 " +
      "at the end of the period of the service (§ 13b Abs. 1 UStG), rules 12 and 13 with the " +
      "invoice, at the latest at the end of the month after the supply (§ 13b Abs. 2 UStG); " +
      `documents dated up to ${String(ACCRUAL_MARGIN_DAYS)} days around the period were read.`,
  ];
  if ([...sums.values()].some((sum) => sum.assumed)) {
    notes.push(
      "sevDesk books reverse-charge purchases at 0 %; the tax owed as recipient was computed " +
        "here at 19 %. Adjust for positions taxed at 7 %.",
    );
  }
  if (sums.has(13)) {
    notes.push(
      "Rule 13 is reported under Kz 84/85 like rule 12; services of a business in another EU " +
        "state belong to Kz 46/47 instead.",
    );
  }
  if (settings === undefined && [...RECEIVED_RULES].some((rule) => sums.has(rule))) {
    notes.push(
      "The account settings could not be read, so rules 12, 13 and 14 were not compared with " +
        "the account's regime.",
    );
  }
  if (legacy > 0) {
    notes.push(
      `${plural(legacy, "Update 1.0 document")} dated in the period with the tax type eu and ` +
        "no tax rule may be § 13b purchases or acquisitions; they are not in these sums.",
    );
  }
  if (listed.truncated) {
    notes.push(
      "Listing documents stopped at a cap: the sums are incomplete. Use a shorter period.",
    );
  }
  const pagedNote = pagedRangesNote(listed);
  if (pagedNote !== undefined) notes.push(pagedNote);
  notes.push(
    ...scanNotes({
      notRead: scan.notRead,
      maxDocuments: limits?.maxDocuments,
      timedOut: scan.timedOut,
      documentsRead: scan.documents.length,
      documentsToRead: selected.length,
      positionsIncomplete: incomplete,
      unconvertible: scan.unconvertible.length,
    }),
  );

  const leftOut = scan.notRead + scan.unconvertible.length;
  return {
    drafts,
    regime,
    reverseCharge: section,
    coverage: {
      rowsRead: listed.rowsRead,
      documentsInScope: selected.length,
      documentsChecked: scan.documents.length,
      documentsLeftOut: leftOut,
      truncated: listed.truncated || pagedNote !== undefined || scan.notRead > 0 || incomplete > 0,
      ...(scan.timedOut ? { timeBudgetReached: true } : {}),
      excluded: excludedOf(listed.excluded),
    },
    notes,
  };
}

/** The section from the per-rule sums: rules in id order, totals over the received ones. */
function sectionOf(sums: readonly RuleAccumulator[]): ReverseChargeSection {
  const ordered = [...sums].sort((a, b) => a.rule - b.rule);
  let base = decimal(0);
  let tax = decimal(0);
  let inputTax = decimal(0);
  const received: ReverseChargeSection["received"] = [];
  const issued: ReverseChargeSection["issued"] = [];
  for (const sum of ordered) {
    const output = ruleOutput(sum);
    if (sum.side === "issued") {
      issued.push(output.entry);
      continue;
    }
    received.push(output.entry);
    base = add(base, sum.base);
    tax = add(tax, output.tax);
    inputTax = add(inputTax, output.inputTax);
  }
  return {
    received,
    issued,
    totals: { base: eur(base), tax: eur(tax), inputTax: eur(inputTax) },
  };
}

type RuleSum = ReverseChargeSection["received"][number];

/** The UStVA Kennzahlen of a § 13b rule, from the VAT summary's table (`ustva-boxes.ts`). */
export function kennzahlenOf(rule: number, direction: VatDirection): RuleSum["ustva"] {
  const target = ustvaTarget(rule, direction, "0");
  // Every rule in RECEIVED_RULES and ISSUED_RULES maps to a form line (checked by the tests).
  if (target.kind !== "line") throw new Error(`reverse_charge: rule ${String(rule)} has no line`);
  const line = ustvaLine(target.line);
  const inputTaxKz = target.inputTax === undefined ? undefined : ustvaLine(target.inputTax).taxKz;
  return {
    baseKz: line.baseKz ?? target.line,
    ...(line.taxKz === undefined ? {} : { taxKz: line.taxKz }),
    ...(inputTaxKz === undefined ? {} : { inputTaxKz }),
  };
}

function ruleOutput(sum: RuleAccumulator): {
  readonly entry: RuleSum;
  readonly tax: Decimal;
  readonly inputTax: Decimal;
} {
  const ustva = kennzahlenOf(sum.rule, sum.side === "received" ? "expense" : "revenue");
  let tax = decimal(0);
  for (const [rate, base] of sum.perRate) tax = add(tax, percentOf(base, rate));
  const inputTax = ustva.inputTaxKz === undefined ? decimal(0) : tax;
  const documents = [...sum.documents].sort(
    (a, b) => a.taxPoint.localeCompare(b.taxPoint) || byDateThenId(a.header, b.header),
  );
  const omitted = documents.length - MAX_SECTION_RECORDS;
  const entry: RuleSum = {
    taxRule: taxRuleRef(sum.rule),
    ustva,
    base: eur(sum.base),
    ...(sum.side === "received" ? { tax: eur(tax), inputTax: eur(inputTax) } : {}),
    ...(sum.assumed ? { recipientTaxAssumed: true } : {}),
    documents: documents.length,
    records: documents.slice(0, MAX_SECTION_RECORDS).map((document) =>
      recordOf(document.header, {
        net: document.net,
        tax: document.tax,
        taxPoint: document.taxPoint,
        withContact: true,
      }),
    ),
    ...(omitted > 0 ? { recordsOmitted: omitted } : {}),
  };
  return { entry, tax, inputTax };
}

/** Check `reverse_charge`; see the module doc. */
export const reverseChargeCheck = {
  label: "the §13b base by tax rule",
  summary:
    "the §13b base by tax rule (12, 13, 14 received; 5, 21 issued) with the tax owed, the UStVA " +
    "Kennzahlen and the documents behind each sum, by tax point like sevdesk_vat_summary; flags " +
    "rule 13 on a regular account and rules 12 and 14 on a Kleinunternehmer account",
  codes: REVERSE_CHARGE_FINDING_CODES,
  run: runReverseChargeCheck,
};
