/**
 * Check `vat` of `sevdesk_records_audit`: is a document's VAT treatment consistent with where the
 * other side is established? It compares each document's tax rule (and, for purchases with input
 * VAT, its rates) with the contact's VAT id and address countries (`parties.ts`).
 *
 * Purchases (expense vouchers, self-billed credit notes) from a supplier established abroad:
 * - German VAT booked as input VAT (rule 9): the recipient usually owes the VAT instead
 *   (§ 13b Abs. 1, Abs. 2 Nr. 1, Abs. 5 UStG) and VAT the supplier does not owe is not deductible
 *   (§ 14c Abs. 1, § 15 Abs. 1 Satz 1 Nr. 1 UStG);
 * - VAT at a rate Germany does not charge booked as input VAT (rule 9): foreign VAT is no German
 *   input VAT;
 * - plain 0 % (rule 9 or 10) without reverse charge or acquisition (§ 13b, § 1a UStG), unless the
 *   supplier is in the EU small-business scheme (VAT id ending in EX).
 * The mirror cases the same data grounds: rule 14 (§ 13b Abs. 1) or rule 8 (§ 1a) for a supplier
 * with only German data or one outside the EU, and rule 12 for a supplier in another EU state.
 *
 * Sales (invoices; cancellation invoices are left out, they mirror their original): German VAT
 * (rule 1) to a customer with a VAT id of another EU state and no German data (§ 3a Abs. 2,
 * § 6a UStG), and intra-EU supplies or services (rules 3, 21) without a VAT id of another EU state
 * (§ 6a Abs. 1 Satz 1 Nr. 4, § 18a UStG). A VAT id counts only in the valid format of its state,
 * as in the tax-rule helper (`customerVatIdOf`).
 *
 * False positives the data rules out: a supplier with a German VAT id or a German address
 * (registered or established in Germany, § 13b Abs. 7 UStG) may charge German VAT; a supplier with
 * only German data (e.g. a Kleinunternehmer) may charge none; import VAT positions (`import-vat.ts`)
 * are no supplier's VAT. What the data cannot tell (where a service was performed, whether goods
 * moved) is named in the finding's action instead of asserted.
 *
 * Documents are selected by document date. Positions are read only for rule 9 purchases from
 * suppliers abroad, where the rates decide.
 */
import { SevdeskError } from "../../../sevdesk/errors.js";
import { loadAccountSettings, type TaxRegime, taxRegimeOf } from "../../account-settings.js";
import { type AccountDatevList, loadAccountsDatev } from "../../accounts-datev.js";
import { compare, isZero } from "../../money.js";
import { importVatAccountIds, isImportVat } from "../import-vat.js";
import {
  type DocumentHeader,
  listDocumentHeaders,
  pagedRangesNote,
  type PositionGroup,
  scanPositions,
} from "../positions-scan.js";
import { plural } from "../shared.js";
import { sameRate } from "../ustva-boxes.js";
import {
  type AuditCheckContext,
  type AuditCheckResult,
  type AuditContact,
  excludedOf,
  type FindingDraft,
  type FindingText,
  scanNotes,
} from "./findings.js";
import {
  customerVatIdOf,
  loadPartyDirectory,
  locate,
  type PartyArea,
  type PartyDirectory,
  type PartyFacts,
  type PartyLocation,
} from "./parties.js";

/** Purchase tax rules this check compares with the supplier. */
const EXPENSE_RULES: ReadonlySet<number> = new Set([8, 9, 10, 12, 14]);
/** Sales tax rules this check compares with the customer. */
const REVENUE_RULES: ReadonlySet<number> = new Set([1, 3, 21]);
/** VAT rates Germany charges. */
const GERMAN_RATES = ["19", "7"] as const;
/**
 * The temporary reduction (§ 28 Abs. 1 and 2 UStG, Zweites Corona-Steuerhilfegesetz): 16 and 5 %
 * for supplies from 2020-07-01 to 2020-12-31. Outside it, these are other states' rates (5 % in
 * Cyprus, for one).
 */
const REDUCED_2020 = { rates: ["16", "5"], from: "2020-07-01", to: "2020-12-31" } as const;

export const VAT_FINDING_CODES = [
  "foreign_supplier_charged_german_vat",
  "foreign_vat_deducted",
  "foreign_supplier_zero_rate",
  "eu_reverse_charge_for_domestic_supplier",
  "acquisition_from_domestic_supplier",
  "eu_supplier_under_rule_12",
  "eu_reverse_charge_for_non_eu_supplier",
  "acquisition_from_non_eu_supplier",
  "german_vat_to_eu_business",
  "intra_eu_supply_without_eu_vat_id",
  "eu_service_without_eu_vat_id",
] as const;
type VatFindingCode = (typeof VAT_FINDING_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Finding texts
// ---------------------------------------------------------------------------------------------

/** What the wording of a finding depends on. */
interface TextContext {
  readonly regime: TaxRegime | undefined;
  /** Where the other side is, when abroad. */
  readonly area: PartyArea | undefined;
  /** What sevDesk holds as the customer's VAT id (sales). */
  readonly vatIdState: string;
}

/** The reverse-charge rule for a service bought from `area` (Kleinunternehmer: rule 13). */
function reverseChargeRule(context: TextContext): string {
  if (context.regime === "small_business") {
    return "under rule 13 (§ 13b without input VAT deduction, as a Kleinunternehmer)";
  }
  switch (context.area) {
    case "eu":
      return "under rule 14 (services of a business in another EU state)";
    case "non_eu":
    case "northern_ireland":
      return "under rule 12 (services of a business outside the EU)";
    case undefined:
      return "under rule 14 (services of a business in another EU state) or 12 (outside the EU)";
  }
}

/** Where a 0 % purchase from `area` belongs instead (regular taxation). */
function zeroRateRules(area: PartyArea | undefined): string {
  switch (area) {
    case "eu":
      return "book services under rule 14 and goods under rule 8";
    case "non_eu":
      return "book services and work deliveries under rule 12";
    case "northern_ireland":
      return "book services under rule 12 and goods under rule 8";
    case undefined:
      return (
        "book services under rule 14 (EU) or 12 (outside the EU) and goods from another EU " +
        "state under rule 8"
      );
  }
}

const ABROAD_EXCEPTIONS =
  "Supplies taxable abroad (e.g. a hotel stay or a meal abroad, § 3a Abs. 3 UStG), goods " +
  "imported from outside the EU (import VAT, § 1 Abs. 1 Nr. 4 UStG) and a supplier in the EU " +
  "small-business scheme (VAT id ending in EX) stay as they are.";

const REGISTERED_IN_GERMANY =
  "Check whether the supplier is registered for VAT in Germany (then store its German VAT id " +
  "on the contact) or the supply is one on which a foreign business charges German VAT: the " +
  "exceptions of § 13b Abs. 6 UStG (e.g. passenger transport, admission to fairs and congresses " +
  "in Germany) or goods that were in Germany already.";

const TEXTS: Readonly<Record<VatFindingCode, (context: TextContext) => FindingText>> = {
  foreign_supplier_charged_german_vat: (context) => ({
    severity: "warning",
    title: "Foreign supplier charged German VAT",
    titleDe: "Ausländischer Lieferant mit deutscher Umsatzsteuer",
    reason:
      "The supplier looks established abroad (a foreign VAT id or address and no German one in " +
      "sevDesk), yet the document carries German VAT booked as input VAT (rule 9). For services " +
      "and work deliveries of a business established abroad the business recipient owes the VAT " +
      "(§ 13b Abs. 1, Abs. 2 Nr. 1 and Abs. 5 UStG). VAT shown by a supplier who does not owe it " +
      "is owed by the supplier (§ 14c Abs. 1 UStG) and is not deductible (§ 15 Abs. 1 Satz 1 " +
      "Nr. 1 UStG).",
    action:
      `${REGISTERED_IN_GERMANY} Otherwise ask for an invoice without German VAT and book it ` +
      `${reverseChargeRule(context)}.`,
  }),
  foreign_vat_deducted: (context) => ({
    severity: "warning",
    title: "Foreign VAT booked as input VAT",
    titleDe: "Ausländische Umsatzsteuer als Vorsteuer gebucht",
    reason:
      "The supplier looks established abroad and the document carries VAT at a rate Germany " +
      "does not charge, booked as input VAT (rule 9). Only German VAT is input VAT in the German " +
      "VAT return (§ 15 Abs. 1 Satz 1 Nr. 1 UStG); VAT of another EU state is refunded only by " +
      "that state (applied for through the BZSt, § 18g UStG).",
    action:
      "Check the invoice: foreign VAT on a supply taxable abroad (e.g. a hotel stay abroad) is " +
      "a cost here (rule 10) and may be refunded through the EU refund procedure. If the supply " +
      "is taxable in Germany, ask for an invoice without VAT and book it " +
      `${reverseChargeRule(context)}.`,
  }),
  foreign_supplier_zero_rate: (context) => ({
    severity: "check",
    title: "Foreign supplier booked at 0 % without reverse charge",
    titleDe: "Ausländischer Lieferant mit 0 % ohne Reverse Charge",
    reason:
      "The supplier looks established abroad and the document is booked at 0 % under rule 9 or " +
      "10, which puts no tax into the VAT return. Services a business established abroad " +
      "supplies to a business are mostly taxable in Germany (§ 3a Abs. 2 UStG), and the " +
      "recipient owes the VAT (§ 13b Abs. 1 or Abs. 2 Nr. 1, Abs. 5 UStG); goods bought from a " +
      "supplier in another EU state are an intra-EU acquisition the buyer taxes (§ 1a UStG).",
    action:
      context.regime === "small_business"
        ? `Check where the supply is taxable. ${ABROAD_EXCEPTIONS} Otherwise a Kleinunternehmer ` +
          "owes the tax as recipient too, without deduction: book services under rule 13 " +
          "(§ 13b Abs. 5 UStG). Goods from another EU state are taxed as an acquisition only " +
          "above the acquisition threshold (§ 1a Abs. 3 UStG)."
        : `Check where the supply is taxable. ${ABROAD_EXCEPTIONS} Otherwise ` +
          `${zeroRateRules(context.area)}; the tax is then deducted again as input VAT ` +
          "(§ 15 Abs. 1 Satz 1 Nr. 3 and 4 UStG).",
  }),
  eu_reverse_charge_for_domestic_supplier: () => ({
    severity: "check",
    title: "EU reverse charge for a German supplier",
    titleDe: "EU-Reverse-Charge bei deutschem Lieferanten",
    reason:
      "Rule 14 is for services of a business established in another EU state (§ 13b Abs. 1 " +
      "UStG), but sevDesk holds only German data for the supplier (a German VAT id or address). " +
      "A business established in Germany charges German VAT itself (§ 13a Abs. 1 Nr. 1 UStG), " +
      "apart from the domestic reverse-charge cases of § 13b Abs. 2 Nr. 2 to 12 UStG (e.g. " +
      "construction services, building cleaning), which belong under rule 12.",
    action:
      "Check the invoice: with German VAT, book it under rule 9; for a domestic reverse-charge " +
      "case, under rule 12. If the supplier is established in another EU state, store its VAT " +
      "id from there on the contact.",
  }),
  acquisition_from_domestic_supplier: () => ({
    severity: "check",
    title: "Intra-EU acquisition from a German supplier",
    titleDe: "Innergemeinschaftlicher Erwerb von deutschem Lieferanten",
    reason:
      "Rule 8 is for goods that come from another EU state (intra-EU acquisition, § 1a Abs. 1 " +
      "UStG), but sevDesk holds only German data for the supplier (a German VAT id or address). " +
      "Goods a German supplier delivers within Germany are no acquisition; the supplier charges " +
      "German VAT.",
    action:
      "Check where the goods were shipped from: from within Germany, book the invoice with its " +
      "German VAT under rule 9; from another EU state, store the supplier's VAT id from there " +
      "on the contact.",
  }),
  eu_supplier_under_rule_12: () => ({
    severity: "check",
    title: "Service from an EU business under rule 12",
    titleDe: "Leistung eines EU-Unternehmens mit Steuerregel 12",
    reason:
      "The supplier looks established in another EU state, but the document uses rule 12 " +
      "(§ 13b Abs. 2 UStG, Kz 84/85). Services of a business established in another EU state " +
      "that are taxable where the recipient is (§ 3a Abs. 2 UStG) fall under § 13b Abs. 1 UStG " +
      "(rule 14, Kz 46/47); their tax arises at the end of the period in which they were " +
      "performed, not with the invoice.",
    action:
      "Check what was bought: such a service belongs under rule 14. Rule 12 stays right for a " +
      "work delivery (Werklieferung, § 13b Abs. 2 Nr. 1 UStG) and for services taxed where a " +
      "property is (§ 3a Abs. 3 Nr. 1 UStG), e.g. construction work in Germany.",
  }),
  eu_reverse_charge_for_non_eu_supplier: () => ({
    severity: "check",
    title: "EU reverse charge for a supplier outside the EU",
    titleDe: "EU-Reverse-Charge bei einem Lieferanten außerhalb der EU",
    reason:
      "Rule 14 (§ 13b Abs. 1 UStG, Kz 46/47) is only for services of a business established in " +
      "another EU state, but the supplier looks established outside the EU. Services of a " +
      "business established outside the EU fall under § 13b Abs. 2 Nr. 1 UStG (rule 12, " +
      "Kz 84/85).",
    action:
      "Check where the supplier is established: outside the EU, book under rule 12; in an EU " +
      "state, store its VAT id from there on the contact.",
  }),
  acquisition_from_non_eu_supplier: () => ({
    severity: "check",
    title: "Intra-EU acquisition from a supplier outside the EU",
    titleDe: "Innergemeinschaftlicher Erwerb von einem Lieferanten außerhalb der EU",
    reason:
      "Rule 8 (intra-EU acquisition, § 1a UStG) needs goods that come from another EU state, " +
      "but the supplier looks established outside the EU. Goods shipped from outside the EU are " +
      "an import (§ 1 Abs. 1 Nr. 4 UStG): customs charges import VAT, deductible with the " +
      "customs notice (§ 15 Abs. 1 Satz 1 Nr. 2 UStG, Kz 62).",
    action:
      "Check where the goods were shipped from: from another EU state rule 8 stays; from " +
      "outside the EU, book the goods without VAT and the import VAT from the customs notice " +
      "on the import VAT account (rule 9).",
  }),
  german_vat_to_eu_business: () => ({
    severity: "check",
    title: "German VAT to a business customer in another EU state",
    titleDe: "Deutsche Umsatzsteuer an Unternehmen in anderem EU-Staat",
    reason:
      "The customer has a VAT id of another EU state and no German VAT id or address in " +
      "sevDesk, yet the invoice charges German VAT (rule 1). Services to a business are " +
      "taxable where the customer is established (§ 3a Abs. 2 UStG), for a customer in another " +
      "EU state not in Germany (rule 21, Kz 21, Zusammenfassende Meldung). Goods shipped to " +
      "another EU state for a buyer who uses its VAT id from there are a tax-exempt intra-EU " +
      "supply (§ 4 Nr. 1 Buchst. b, § 6a UStG; rule 3, Kz 41).",
    action:
      "Check where the supply is taxable. German VAT stays right for goods that stay in " +
      "Germany, services related to German real estate (§ 3a Abs. 3 Nr. 1 UStG), admission to " +
      "events in Germany (§ 3a Abs. 3 Nr. 5 UStG) and restaurant services in Germany. " +
      "Otherwise cancel the invoice and issue a new one under rule 21 or 3.",
  }),
  intra_eu_supply_without_eu_vat_id: (context) => ({
    severity: "warning",
    title: "Intra-EU supply without the buyer's EU VAT id",
    titleDe: "Innergemeinschaftliche Lieferung ohne USt-IdNr. des Abnehmers",
    reason:
      "An intra-EU supply (rule 3, Kz 41) is tax-exempt only if the buyer used a valid VAT id " +
      "of another EU state (§ 6a Abs. 1 Satz 1 Nr. 4 UStG), and it goes into the " +
      "Zusammenfassende Meldung under that VAT id (§ 18a UStG). sevDesk holds " +
      `${context.vatIdState} for this customer.`,
    action:
      "Store the buyer's VAT id from its EU state on the contact and have it confirmed (BZSt, " +
      "§ 18e UStG). Without one the supply is not exempt: correct the invoice (German VAT under " +
      "rule 1, or rule 2 for an export outside the EU).",
  }),
  eu_service_without_eu_vat_id: (context) => ({
    severity: "warning",
    title: "EU reverse-charge service without the customer's EU VAT id",
    titleDe: "EU-Leistung mit Reverse Charge ohne USt-IdNr. des Kunden",
    reason:
      "Rule 21 (services to a business in another EU state, Kz 21) needs a business customer " +
      "established in another EU state (§ 3a Abs. 2 UStG), shown by its VAT id, which also " +
      "goes into the Zusammenfassende Meldung (§ 18a UStG). sevDesk holds " +
      `${context.vatIdState} for this customer.`,
    action:
      "Store the customer's VAT id from its EU state on the contact and have it confirmed " +
      "(BZSt, § 18e UStG). A business customer outside the EU belongs under rule 17; a private " +
      "customer or one in Germany is charged German VAT (rule 1).",
  }),
};

/** What sevDesk holds as a customer's VAT id, in words (trusted: never the VAT id itself). */
function vatIdStateOf(vatId: string | undefined): string {
  switch (customerVatIdOf(vatId)) {
    case "none":
      return "no VAT id";
    case "germany":
      return "a German VAT id";
    case "non_eu":
      return "a VAT id from outside the EU";
    case "northern_ireland":
      return "a VAT id from Northern Ireland (EU rules for goods only)";
    case "eu":
      return "a VAT id of another EU state";
    case "wrong_format":
      return "a VAT id in the wrong format for its state";
    case "unreadable":
      return "a VAT id without a country prefix";
  }
}

// ---------------------------------------------------------------------------------------------
// Judging one document
// ---------------------------------------------------------------------------------------------

/** The other side of a document, merged from the document and the contact directory. */
interface Party {
  readonly facts: PartyFacts;
  /** Whether the VAT id is known (embedded in the document or the contact was listed). */
  readonly vatIdKnown: boolean;
  readonly location: PartyLocation;
  /**
   * False when a capped contact or address list may have left out some of its data (see
   * `parties.ts`): no finding then rests on what the data does not show.
   */
  readonly complete: boolean;
}

type Verdict =
  | { readonly kind: "finding"; readonly code: VatFindingCode }
  /** Rule 9 from a supplier abroad: the position rates decide. */
  | { readonly kind: "positions" }
  | { readonly kind: "ok" }
  /** Where the other side is cannot be told from its data. */
  | { readonly kind: "not_judged" }
  /** Needed amounts are missing (a foreign-currency document without EUR values). */
  | { readonly kind: "left_out" };

const OK: Verdict = { kind: "ok" };
const NOT_JUDGED: Verdict = { kind: "not_judged" };
const finding = (code: VatFindingCode): Verdict => ({ kind: "finding", code });

/** Whether this check looks at `header`. */
function inScope(header: DocumentHeader): boolean {
  const rule = header.taxRuleId;
  if (rule === undefined) return false;
  if (header.direction === "expense") {
    return header.kind !== "invoice" && EXPENSE_RULES.has(rule);
  }
  return header.kind === "invoice" && header.invoiceType !== "SR" && REVENUE_RULES.has(rule);
}

function partyOf(header: DocumentHeader, directory: PartyDirectory): Party {
  const id = header.contact?.id;
  const listed = id === undefined ? undefined : directory.parties.get(id);
  const embedded = header.contactVatId;
  const vatId = embedded === undefined ? listed?.vatId : (embedded ?? undefined);
  const documentCountry =
    header.countryId === undefined ? undefined : directory.countryCodes.get(header.countryId);
  const countries = [
    ...new Set([
      ...(listed?.countries ?? []),
      ...(documentCountry === undefined ? [] : [documentCountry]),
    ]),
  ].sort();
  const facts: PartyFacts = {
    id,
    name: listed?.name ?? header.contact?.name,
    vatId,
    countries,
    countriesUnknown:
      listed?.countriesUnknown === true ||
      (header.countryId !== undefined && documentCountry === undefined),
  };
  return {
    facts,
    vatIdKnown: embedded !== undefined || listed !== undefined,
    location: locate(facts),
    complete:
      !directory.coverage.addressesTruncated &&
      (listed !== undefined || !directory.coverage.contactsTruncated),
  };
}

/**
 * A purchase: rule against the supplier's location. A supplier with German data (VAT id or
 * address) may charge German VAT or none, also when it has foreign data as well (a foreign
 * business registered or established in Germany); the EU rules 14 and 8 are questioned only for
 * a supplier with nothing but German data, and checked against the area only for one with nothing
 * but foreign data. An address whose country is unknown might be German: not judged.
 *
 * Data a capped list left out can only add a German or a foreign location: that turns a finding
 * or a rate check into OK or not judged, never an OK into a finding. So for an incomplete party
 * the OKs stand and the rest is not judged.
 */
function judgePurchase(header: DocumentHeader, rule: number, party: Party): Verdict {
  const verdict = purchaseVerdict(header, rule, party);
  if (!party.complete && (verdict.kind === "finding" || verdict.kind === "positions")) {
    return NOT_JUDGED;
  }
  return verdict;
}

function purchaseVerdict(header: DocumentHeader, rule: number, party: Party): Verdict {
  const { location } = party;
  if (party.facts.countriesUnknown === true) return NOT_JUDGED;
  if (!location.germany && !location.abroad) return NOT_JUDGED;
  const foreign = location.abroad && !location.germany;
  switch (rule) {
    case 9:
      return foreign ? { kind: "positions" } : OK;
    case 10:
      // sevDesk allows only 0 % under rule 10.
      if (!foreign || location.smallBusinessScheme) return OK;
      if (header.eur === undefined) return { kind: "left_out" };
      return isZero(header.eur.tax) ? finding("foreign_supplier_zero_rate") : OK;
    case 12:
      return foreign && location.area === "eu" ? finding("eu_supplier_under_rule_12") : OK;
    case 14:
      if (!location.abroad) return finding("eu_reverse_charge_for_domestic_supplier");
      if (!foreign || location.area === undefined) return NOT_JUDGED;
      return location.area === "eu" ? OK : finding("eu_reverse_charge_for_non_eu_supplier");
    case 8:
      if (!location.abroad) return finding("acquisition_from_domestic_supplier");
      if (!foreign || location.area === undefined) return NOT_JUDGED;
      return location.area === "non_eu" ? finding("acquisition_from_non_eu_supplier") : OK;
    default:
      return OK;
  }
}

/** A sale (invoice): rule against the customer's VAT id and location. */
function judgeSale(header: DocumentHeader, rule: number, party: Party): Verdict {
  if (!party.vatIdKnown) return NOT_JUDGED;
  const vatId = customerVatIdOf(party.facts.vatId);
  switch (rule) {
    case 1:
      if (header.eur === undefined) return { kind: "left_out" };
      if (compare(header.eur.tax, 0) <= 0 || vatId !== "eu" || party.location.germany) return OK;
      // A German address would settle it; one whose country is unknown, or one a capped list
      // left out, might be German. Rules 3 and 21 rest on the VAT id alone.
      return party.facts.countriesUnknown === true || !party.complete
        ? NOT_JUDGED
        : finding("german_vat_to_eu_business");
    case 3:
      // Northern Ireland follows the EU rules for goods (XI VAT ids).
      return vatId === "eu" || vatId === "northern_ireland"
        ? OK
        : finding("intra_eu_supply_without_eu_vat_id");
    case 21:
      // Northern Ireland follows the UK's rules for services: an XI VAT id does not fit rule 21.
      return vatId === "eu" ? OK : finding("eu_service_without_eu_vat_id");
    default:
      return OK;
  }
}

/** Whether `rate` is a German rate on `header`: 16 and 5 % only for 2020's reduction. */
function isGermanRate(rate: string, header: DocumentHeader): boolean {
  if (GERMAN_RATES.some((german) => sameRate(rate, german))) return true;
  return REDUCED_2020.rates.some((reduced) => sameRate(rate, reduced)) && inReducedPeriod(header);
}

/** The document date or the supply date (or its end) falls in 2020's reduction. */
function inReducedPeriod(header: DocumentHeader): boolean {
  return [header.date, header.deliveryDate, header.deliveryDateUntil].some(
    (date) => date !== undefined && date >= REDUCED_2020.from && date <= REDUCED_2020.to,
  );
}

/**
 * A rule 9 purchase from a supplier abroad, by its positions (import VAT positions left out):
 * German rates, other rates, or nothing but 0 %.
 */
function judgeRates(
  header: DocumentHeader,
  groups: readonly PositionGroup[],
  location: PartyLocation,
): VatFindingCode | undefined {
  const taxed = groups.filter((group) => !sameRate(group.rate, "0"));
  if (groups.length === 0) return undefined;
  if (taxed.length === 0) {
    return location.smallBusinessScheme ? undefined : "foreign_supplier_zero_rate";
  }
  return taxed.some((group) => isGermanRate(group.rate, header))
    ? "foreign_supplier_charged_german_vat"
    : "foreign_vat_deducted";
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

/** Booking accounts find the import VAT account by number; unreadable ones leave the known id. */
async function loadAccountsOrNothing(
  context: AuditCheckContext,
): Promise<AccountDatevList | undefined> {
  try {
    return await loadAccountsDatev(context.client, {
      cacheOwner: context.cacheOwner,
      signal: context.options.signal,
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return undefined;
    throw error;
  }
}

async function runVatCheck(context: AuditCheckContext): Promise<AuditCheckResult> {
  const { client, period, options, limits } = context;
  const settings = await loadAccountSettings(client, {
    cacheOwner: context.cacheOwner,
    signal: options.signal,
  });
  const regime = taxRegimeOf(settings);
  const listed = await listDocumentHeaders(
    client,
    { from: period.from, to: period.to, maxRows: limits?.maxRows, today: context.today },
    options,
  );
  const candidates = listed.headers.filter(inScope);
  const legacy = listed.headers.filter(
    (header) => header.taxRuleId === undefined && header.legacyTaxType !== undefined,
  ).length;

  // One read of the contact and address lists serves every document (see `parties.ts`).
  const directory =
    candidates.length === 0
      ? undefined
      : await loadPartyDirectory(client, {
          cacheOwner: context.cacheOwner,
          maxRows: limits?.maxContactRows,
          // An invoice's own address country places the customer even without contact addresses.
          documentsHaveCountries: candidates.some((header) => header.countryId !== undefined),
          signal: options.signal,
          onProgress: options.onProgress,
        });
  const drafts: FindingDraft[] = [];
  const toRead: { readonly header: DocumentHeader; readonly party: Party }[] = [];
  let notJudged = 0;
  let missingAmounts = 0;
  const draftOf = (code: VatFindingCode, header: DocumentHeader, party: Party): FindingDraft => ({
    code,
    text: TEXTS[code]({
      regime,
      area: party.location.area,
      vatIdState: vatIdStateOf(party.facts.vatId),
    }),
    contact: contactOf(party),
    header,
  });
  for (const header of candidates) {
    if (directory === undefined) break;
    const party = partyOf(header, directory);
    // `inScope` passed only documents with a tax rule.
    const rule = header.taxRuleId ?? 0;
    const verdict =
      header.direction === "expense"
        ? judgePurchase(header, rule, party)
        : judgeSale(header, rule, party);
    switch (verdict.kind) {
      case "finding":
        drafts.push(draftOf(verdict.code, header, party));
        break;
      case "positions":
        toRead.push({ header, party });
        break;
      case "not_judged":
        notJudged += 1;
        break;
      case "left_out":
        missingAmounts += 1;
        break;
      case "ok":
        break;
    }
  }

  const scan =
    toRead.length === 0
      ? undefined
      : await scanPositions(
          client,
          toRead.map((entry) => entry.header),
          {
            maxDocuments: limits?.maxDocuments,
            signal: options.signal,
            onProgress: options.onProgress,
            deadline: options.deadline,
          },
        );
  if (scan !== undefined) {
    const importVat = importVatAccountIds({
      accounts: await loadAccountsOrNothing(context),
      chartOfAccounts: settings?.chartOfAccounts,
    });
    const parties = new Map(toRead.map((entry) => [entry.header, entry.party]));
    for (const document of scan.documents) {
      const party = parties.get(document.header);
      if (party === undefined) continue;
      const groups = document.groups.filter(
        (group) => !isImportVat(document.header, group, importVat),
      );
      const code = judgeRates(document.header, groups, party.location);
      if (code !== undefined) drafts.push(draftOf(code, document.header, party));
    }
  }

  const notRead = scan === undefined ? 0 : scan.notRead + scan.unconvertible.length;
  const incomplete = scan?.documents.filter((document) => !document.positionsComplete).length ?? 0;
  const contacts = directory?.coverage;
  const leftOut = missingAmounts + notRead;
  const pagedNote = pagedRangesNote(listed);
  const truncated =
    listed.truncated ||
    pagedNote !== undefined ||
    (scan !== undefined && scan.notRead > 0) ||
    incomplete > 0 ||
    contacts?.truncated === true;

  const notes = [
    "Documents are selected by document date; drafts are not checked. Sales are checked on " +
      "invoices (not on revenue vouchers or credit notes); cancellation invoices are left out.",
    "Where a contact is established comes from its VAT id (USt-IdNr.) and its addresses in " +
      "sevDesk: a German VAT id or address counts as established or registered in Germany.",
  ];
  if (notJudged > 0) {
    notes.push(
      `${plural(notJudged, "document")} could not be judged: the contact has no VAT id and no ` +
        "address in sevDesk, German and foreign data that leave the question open, an " +
        "address in a country that could not be resolved, or data a capped list left out " +
        "(coverage.notJudged). Complete the contacts to have them checked.",
    );
  }
  if (contacts?.contactsTruncated === true) {
    notes.push(
      "The contact list stopped at its cap or had to be read page by page, so contacts may be " +
        "missing: for contacts not read only what the document shows " +
        "was used (the VAT id and address on an invoice), and no finding was made that their " +
        "missing data could overturn.",
    );
  }
  if (contacts?.addressesTruncated === true) {
    notes.push(
      "The address list stopped at its cap: any contact may have further addresses, German or " +
        "foreign, so no finding was made that such an address could overturn; findings on a " +
        "customer's VAT id (rules 3 and 21) stand.",
    );
  }
  if (directory?.countriesUnread === true) {
    notes.push(
      "The country table (StaticCountry) could not be read: contacts with an address were not " +
        "judged (it might be German); customers' VAT ids were still checked.",
    );
  }
  if (settings === undefined) {
    notes.push(
      "The account settings could not be read; the actions are worded for regular taxation " +
        "(Regelbesteuerung).",
    );
  }
  if (legacy > 0) {
    notes.push(
      `${plural(legacy, "Update 1.0 document")} with a tax type that maps to no single tax rule ` +
        `(e.g. eu) ${legacy === 1 ? "was" : "were"} not checked.`,
    );
  }
  if (listed.truncated) {
    notes.push(
      "Listing documents stopped at a cap: documents beyond it were not checked. Use a shorter " +
        "period.",
    );
  }
  if (pagedNote !== undefined) notes.push(pagedNote);
  notes.push(
    ...scanNotes({
      notRead: scan?.notRead ?? 0,
      maxDocuments: limits?.maxDocuments,
      timedOut: scan?.timedOut === true,
      documentsRead: scan?.documents.length ?? 0,
      documentsToRead: toRead.length,
      positionsIncomplete: incomplete,
      unconvertible: missingAmounts + (scan?.unconvertible.length ?? 0),
    }),
  );

  const checked = candidates.length - notJudged - leftOut;
  return {
    drafts,
    regime,
    coverage: {
      rowsRead: listed.rowsRead,
      documentsInScope: candidates.length,
      documentsChecked: checked,
      documentsLeftOut: leftOut,
      notJudged,
      truncated,
      ...(scan?.timedOut === true ? { timeBudgetReached: true } : {}),
      excluded: excludedOf(listed.excluded),
      ...(directory === undefined
        ? {}
        : {
            contacts: {
              read: directory.coverage.read,
              addressesRead: directory.coverage.addressesRead,
              truncated: directory.coverage.truncated,
            },
          }),
    },
    notes,
  };
}

function contactOf(party: Party): AuditContact {
  return {
    id: party.facts.id,
    name: party.facts.name,
    vatId: party.facts.vatId,
    countries: party.facts.countries,
  };
}

/** Check `vat`; see the module doc. */
export const vatCheck = {
  label: "VAT treatment against where suppliers and customers are established",
  summary:
    "foreign suppliers booked with German VAT, foreign VAT or plain 0 % instead of reverse " +
    "charge (§13b UStG) or intra-EU acquisition, EU rules for German or non-EU suppliers, " +
    "German VAT to EU businesses, intra-EU sales without an EU VAT id (by document date, from " +
    "the contacts' VAT ids and addresses)",
  codes: VAT_FINDING_CODES,
  run: runVatCheck,
};
