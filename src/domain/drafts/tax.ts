/**
 * The tax setting of draft documents. Tools speak Update 2.0 tax rules (Steuerregeln) only; this
 * module validates the rule and every position's rate against `TAX_RULES` before anything is
 * sent, and writes the rule the way the account's bookkeeping system expects:
 *
 * - Update 2.0: `taxRule: {id, objectName: "TaxRule"}` (spec overview "sevdesk-Update 2.0 → Tax
 *   Rules"; sevdesk-rs's `saveInvoice`/`saveCreditNote` requests, rebuilt from its source, send
 *   `taxRule {id: 1}`, `taxRate: 0`, `taxText` and no `taxType`; the responses recorded on
 *   2026-10-01 show them accepted).
 * - Update 1.0: the rule's legacy `taxType` (default, eu, noteu, ss), from the spec's tax rule
 *   tables (spec/deviations.md D-005). Rules without a 1.0 equivalent are refused; custom tax sets
 *   (`taxType: custom` + `taxSet`) are not offered.
 *
 * The document-level `taxRate` is "not used anymore" (spec) and always sent as 0, as sevdesk-rs
 * does.
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SystemVersion } from "../../sevdesk/system-version.js";
import { compare, toDecimalString } from "../money.js";
import { type TaxRule, taxRuleById } from "../reference-data.js";

/**
 * Tax rules a sales document (invoice, order, credit note) may carry: the `taxRule.id` enum of
 * `Model_Invoice`, `Model_Order` and `Model_creditNote` in the spec. Rules 15 and 22 exist in
 * `GET /TaxRule` but not in these enums (spec/deviations.md D-030), so they are refused rather
 * than risked.
 */
export const SALES_TAX_RULE_IDS: readonly number[] = [1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21];

/** Taxable domestic revenue (Umsatzsteuerpflichtige Umsätze): the default for new drafts. */
export const DEFAULT_TAX_RULE_ID = 1;

/** The Kleinunternehmer rule (§19 UStG): no VAT, `smallSettlement`. */
const SMALL_BUSINESS_RULE_ID = 11;

/** One-Stop-Shop rules: the rate depends on the destination country. */
const OSS_RULE_IDS: ReadonlySet<number> = new Set([18, 19, 20]);

/** Which rules a document accepts, for error messages. */
export interface RuleScope {
  readonly allowedRuleIds: readonly number[];
  /** Trusted plural noun, e.g. "invoices", "provision credit notes". */
  readonly documents: string;
}

/** The tax rule `id` if `scope` allows it; a `validation` error that lists the allowed ids otherwise. */
export function taxRuleFor(id: number, scope: RuleScope): TaxRule {
  const rule = taxRuleById(id);
  const allowed = scope.allowedRuleIds.join(", ");
  if (rule === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Tax rule ${id} does not exist. ${capitalize(scope.documents)} take tax rule ${allowed}; ` +
        "sevdesk_reference_lookup kind=tax_rules explains them.",
    });
  }
  if (!scope.allowedRuleIds.includes(rule.id)) {
    const why = rule.direction === "expense" ? " (it is a rule for expenses)" : "";
    throw new SevdeskError({
      kind: "validation",
      message:
        `Tax rule ${rule.id} (${rule.nameDe}) cannot be used for ${scope.documents}${why}. ` +
        `Use tax rule ${allowed}; sevdesk_reference_lookup kind=tax_rules explains them.`,
    });
  }
  return rule;
}

/** Extra limit on the rates, e.g. "the rates of the source invoice". */
export interface RateLimit {
  readonly rates: readonly string[];
  /** Trusted text naming whose rates they are, e.g. "the source invoice 1001". */
  readonly owner: string;
}

/**
 * The tax rate of every position (same order as `positions`), checked against the rule's
 * `allowedTaxRates` and an optional extra limit. A position without a rate gets the rule's only
 * allowed rate (or the limit's only rate); otherwise it must say which rate applies. Throws a
 * `validation` error naming the position and the allowed rates.
 */
export function resolveTaxRates(
  rule: TaxRule,
  positions: readonly { readonly taxRate?: string | undefined }[],
  limit?: RateLimit,
): string[] {
  const allowed = rule.allowedTaxRates?.map(String);
  const candidates = limit?.rates ?? allowed;
  return positions.map((position, index) => {
    const label = `Position ${index + 1}`;
    if (position.taxRate === undefined) {
      if (candidates !== undefined && candidates.length === 1 && candidates[0] !== undefined) {
        return toDecimalString(candidates[0]);
      }
      throw new SevdeskError({
        kind: "validation",
        message:
          candidates === undefined
            ? `${label} has no taxRate. With tax rule ${rule.id} (${rule.nameDe}) the rate ` +
              "depends on the destination country, so give it per position."
            : `${label} has no taxRate. ${rateChoice(rule, candidates)} Say which one applies.`,
      });
    }
    const rate = position.taxRate;
    if (allowed !== undefined && !includesRate(allowed, rate)) {
      throw new SevdeskError({
        kind: "validation",
        message:
          `${label} has a tax rate of ${rate} %, which tax rule ${rule.id} (${rule.nameDe}) ` +
          `does not allow. ${rateChoice(rule, allowed)}${rateHint(rule, rate)}`,
      });
    }
    if (limit !== undefined && !includesRate(limit.rates, rate)) {
      throw new SevdeskError({
        kind: "validation",
        message:
          `${label} has a tax rate of ${rate} %, but ${limit.owner} ` +
          `${formatRates(limit.rates)}; sevDesk only accepts those rates here.`,
      });
    }
    return toDecimalString(rate);
  });
}

/**
 * Refuses a rule for a use case sevDesk rejects with it (`notSupportedFor` in reference data,
 * e.g. "e-invoices" for One-Stop-Shop rules).
 */
export function checkTaxRuleUseCase(rule: TaxRule, useCase: string, noun: string): void {
  if (rule.notSupportedFor?.includes(useCase) === true) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Tax rule ${rule.id} (${rule.nameDe}) is not supported for ${useCase}, and this ` +
        `${noun} is one. Choose another tax rule.`,
    });
  }
}

/** Preview warnings for a rule (trusted text). */
export function taxRuleWarnings(rule: TaxRule): string[] {
  const warnings: string[] = [];
  if (rule.id === SMALL_BUSINESS_RULE_ID) {
    warnings.push(
      "Tax rule 11 is for small businesses (Kleinunternehmer, §19 UStG) only: the document " +
        "shows no VAT.",
    );
  }
  if (OSS_RULE_IDS.has(rule.id)) {
    warnings.push(
      `Tax rule ${rule.id} is a One-Stop-Shop rule: every rate must be the destination ` +
        "country's VAT rate; sevDesk checks it against the recipient's country.",
    );
  }
  return warnings;
}

/** Document-level tax fields of a save payload. */
export type DocumentTaxFields =
  | {
      readonly taxRule: { readonly id: number; readonly objectName: "TaxRule" };
      readonly taxRate: 0;
      readonly taxText: string;
      readonly smallSettlement: boolean;
    }
  | {
      readonly taxType: LegacyTaxType;
      readonly taxRate: 0;
      readonly taxText: string;
      readonly smallSettlement: boolean;
    };

/** Update 1.0 tax types this server writes (`custom` needs a tax set and is not offered). */
export const LEGACY_TAX_TYPES = ["default", "eu", "noteu", "ss"] as const;
type LegacyTaxType = (typeof LEGACY_TAX_TYPES)[number];

/**
 * The tax fields for `rule` on an account with bookkeeping system `version`. `taxText` defaults to
 * the rule's German name. Throws a `validation` error on a 1.0 account for a rule without a 1.0
 * tax type.
 */
export function documentTaxFields(
  rule: TaxRule,
  version: SystemVersion,
  taxText: string | undefined,
): DocumentTaxFields {
  const text = taxText ?? rule.nameDe;
  const smallSettlement = rule.id === SMALL_BUSINESS_RULE_ID;
  if (version === "2.0") {
    return {
      taxRule: { id: rule.id, objectName: "TaxRule" },
      taxRate: 0,
      taxText: text,
      smallSettlement,
    };
  }
  const legacy = LEGACY_TAX_TYPES.find((type) => type === rule.legacyTaxType);
  if (legacy === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "This sevDesk account still uses bookkeeping system 1.0, where tax rule " +
        `${rule.id} (${rule.nameDe}) has no equivalent tax type. Use tax rule 1 (default), ` +
        "3 (eu), 11 (ss) or 17 (noteu), or move the account to sevDesk Update 2.0.",
    });
  }
  return { taxType: legacy, taxRate: 0, taxText: text, smallSettlement };
}

/**
 * The Update 2.0 rule matching a stored Update 1.0 `taxType` (for validating positions of an
 * existing 1.0 document), or `undefined` for `custom` and unknown types.
 */
export function ruleForLegacyTaxType(taxType: string | undefined): TaxRule | undefined {
  const byType: Readonly<Record<string, number>> = { default: 1, eu: 3, noteu: 17, ss: 11 };
  const id = taxType === undefined ? undefined : byType[taxType.trim().toLowerCase()];
  return id === undefined ? undefined : taxRuleById(id);
}

/** Short label for previews, e.g. "1 Umsatzsteuerpflichtige Umsätze". */
export function taxRuleLabel(rule: TaxRule): string {
  return `${rule.id} ${rule.nameDe}`;
}

function includesRate(rates: readonly string[], rate: string): boolean {
  return rates.some((candidate) => compare(candidate, rate) === 0);
}

function formatRates(rates: readonly string[]): string {
  const list = rates.map((rate) => toDecimalString(rate));
  return list.length === 1 ? `only has ${list[0] ?? ""} %` : `only has ${list.join(", ")} %`;
}

function rateChoice(rule: TaxRule, rates: readonly string[]): string {
  return `Tax rule ${rule.id} allows ${rates.map((rate) => toDecimalString(rate)).join(", ")} %.`;
}

/** A pointer to the rule that probably fits a rejected rate. */
function rateHint(rule: TaxRule, rate: string): string {
  const onlyZero = rule.allowedTaxRates?.length === 1 && rule.allowedTaxRates[0] === 0;
  if (onlyZero && compare(rate, 0) > 0) {
    return " To charge VAT on domestic sales use tax rule 1.";
  }
  if (rule.id === DEFAULT_TAX_RULE_ID && compare(rate, 0) !== 0) {
    return " A small business (Kleinunternehmer, §19 UStG) uses tax rule 11 with rate 0.";
  }
  return "";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
