/**
 * Which sevDesk tax rule (Steuerregel) a sale takes, from the facts that decide it under the
 * German VAT Act (UStG): the account's regime (regular VAT or Kleinunternehmer, `GET /SevClient`,
 * `account-settings.ts`), where the customer is (Germany, another EU member state, outside the
 * EU), whether it buys as a business (B2B) or a consumer (B2C), its VAT ID, and whether the sale
 * is goods, services, or telecommunication, broadcasting and electronic services ("digital
 * services", § 3a Abs. 5 UStG). Pure: no I/O, no clock.
 *
 * Each outcome carries the rule, the rate for the positions (for One-Stop-Shop rules the standard
 * rate of the customer's state from the dated table in `eu.ts`), the note the invoice must or
 * should carry, the legal basis and the reason. Where the law turns on facts this server cannot
 * know, the decision says so instead of guessing:
 *
 * - **thresholds and OSS registration**: distance sales and digital services to EU consumers stay
 *   German below 10,000 € a year (§ 3c Abs. 4, § 3a Abs. 5 UStG) and move to the consumer's
 *   state above it; both outcomes are returned, each with its condition (`decided: false`);
 * - **the catalogue of § 3a Abs. 4 UStG** for services to consumers outside the EU: both outcomes;
 * - **special places of supply** (land, events, transport, restaurants: § 3a Abs. 3, § 3b UStG),
 *   **tax-exempt sales** (§ 4 UStG) and **domestic reverse charge** (§ 13b Abs. 2 UStG): listed
 *   as `exceptions`, each with when it applies instead;
 * - **the Kleinunternehmer thresholds** (§ 19 UStG) and the **Soll/Ist choice**, which sevDesk's
 *   API does not expose and which changes when VAT is due, not the rule: notes.
 *
 * Places VAT law treats apart from their ISO code ({@link customerAreaOf}):
 *
 * - **Monaco** (MC) counts as France (§ 1 Abs. 2a Satz 2 UStG, Art. 7 MwStSystRL): its
 *   businesses have French VAT IDs, and where the VAT of the customer's state applies, it is
 *   France's;
 * - **Northern Ireland** follows the EU VAT rules for goods and the UK's for services (Windsor
 *   Framework, Art. 8 of the Protocol on Ireland/Northern Ireland). A customer is there with
 *   country XI (the code VAT law uses; sevDesk's country list has none), or with country GB and a
 *   VAT ID of Northern Ireland (XI…); for other GB customers the goods case is an exception;
 * - **parts of member states outside the EU VAT area** under their state's own ISO code (Art. 6
 *   MwStSystRL, for Germany § 1 Abs. 2 Satz 1 UStG: the Canary Islands, Ceuta, Melilla,
 *   Heligoland, Büsingen, Livigno, Campione d'Italia, Mount Athos): an exception, rule 2 for goods
 *   and 17 for services. Places outside it with their own code (Åland AX, the French overseas
 *   departments, Greenland, …) are simply outside the EU.
 *
 * Assumes, as sevDesk's tax rules do, a business established in Germany, and for goods that they
 * are shipped from Germany to the customer's country. An unknown regime is treated as regular VAT
 * with a warning, and rule 11 becomes an exception.
 *
 * {@link taxRuleMismatchWarning} compares a draft invoice's rule with these outcomes for every
 * kind of supply (an invoice does not say which it is) and words the hint the draft preview shows.
 */
import type { TaxRegime } from "../account-settings.js";
import { taxRuleById } from "../reference-data.js";
import {
  EU_STANDARD_RATES_AS_OF,
  EU_STANDARD_RATES_SOURCE,
  type EuMemberState,
  euMemberState,
} from "./eu.js";
import type { VatIdFormatCheck } from "./vat-id.js";

export const SUPPLY_KINDS = ["goods", "services", "digital_services"] as const;
export type SupplyKind = (typeof SUPPLY_KINDS)[number];

export const CUSTOMER_TYPES = ["business", "consumer"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** Where the customer is, seen from Germany. */
export const CUSTOMER_AREAS = ["germany", "eu", "non_eu"] as const;
export type CustomerArea = (typeof CUSTOMER_AREAS)[number];

/** What decides the rule. */
export interface SaleFacts {
  /** The account's regime; undefined when it could not be read. */
  readonly regime: TaxRegime | undefined;
  /** The customer's country, ISO 3166-1 alpha-2, upper case; XI for Northern Ireland. */
  readonly country: string;
  readonly customerType: CustomerType;
  /** The customer's VAT ID, format-checked; undefined when none is known. */
  readonly vatId?: VatIdFormatCheck | undefined;
  readonly supply: SupplyKind;
}

/** A note the invoice carries: German as printed, an English gloss, and whether it is required. */
interface InvoiceNote {
  readonly de: string;
  readonly en: string;
  readonly required: boolean;
}

/** One possible rule with what an invoice under it needs. All text is trusted. */
export interface RuleOutcome {
  readonly taxRuleId: number;
  /** Rate for the positions in percent, e.g. "19"; undefined when it is not known. */
  readonly rate: string | undefined;
  readonly rateNote?: string | undefined;
  readonly invoiceNote?: InvoiceNote | undefined;
  readonly legalBasis: string;
  readonly reason: string;
  /** The condition under which this outcome applies (suggestions of an open case, exceptions). */
  readonly when?: string | undefined;
}

/**
 * An outcome as the decision builds it. `routine`: an exception that is the normal case for some
 * businesses (tax-exempt sales, domestic reverse charge, rule 11 under an unknown regime), so a
 * draft with that rule gets no mismatch warning.
 */
interface Candidate extends RuleOutcome {
  readonly routine?: boolean;
}

/** The decision for one set of {@link SaleFacts}. */
export interface SalesTaxRuleDecision {
  /** False when the outcome depends on a fact the server cannot know; see `suggestions[].when`. */
  readonly decided: boolean;
  /** One outcome when decided; otherwise one per possible fact, each with its `when`. */
  readonly suggestions: readonly RuleOutcome[];
  /** Rules that apply instead in special cases, each with its `when`. */
  readonly exceptions: readonly RuleOutcome[];
  /** Conditions, assumptions and facts the server cannot know. */
  readonly notes: readonly string[];
  /** Problems with the facts given (VAT ID, regime). */
  readonly warnings: readonly string[];
}

/** Every result of the helper carries this, in English and German. */
export const DISCLAIMER = {
  en:
    "Not tax advice: a suggestion from the facts given, following the German VAT Act (UStG) as " +
    "of November 2026. Whether it fits the case is for you or your Steuerberater to decide.",
  de:
    "Keine Steuerberatung: ein Vorschlag aus den angegebenen Angaben nach dem " +
    "Umsatzsteuergesetz (Stand November 2026). Ob er zum Fall passt, entscheidest du oder deine " +
    "Steuerberatung.",
} as const;

/** What decides where the customer is for VAT: its country, its VAT ID and what is sold. */
export type CustomerPlace = Pick<SaleFacts, "country" | "vatId" | "supply">;

/**
 * Where the customer is for VAT on its supply, seen from Germany (`country` in any case): Monaco
 * counts as France, Northern Ireland as the EU for goods and outside it for services (see the
 * module doc).
 */
export function customerAreaOf(place: CustomerPlace): CustomerArea {
  if (inNorthernIreland(place)) return place.supply === "goods" ? "eu" : "non_eu";
  const code = vatCountryOf(place.country);
  if (code === "DE") return "germany";
  return euMemberState(code) === undefined ? "non_eu" : "eu";
}

/**
 * The English name of `country` (any case) for an EU member state, Monaco or Northern Ireland
 * (XI); undefined for any other country.
 */
export function placeName(country: string): string | undefined {
  const code = country.trim().toUpperCase();
  return euMemberState(code)?.name ?? OTHER_PLACE_NAMES[code];
}

/** The code VAT law uses for Northern Ireland (the prefix of its VAT IDs). */
const NORTHERN_IRELAND = "XI";

/** Names of the places with a VAT treatment of their own that are not member states. */
const OTHER_PLACE_NAMES: Readonly<Record<string, string>> = {
  MC: "Monaco",
  [NORTHERN_IRELAND]: "Northern Ireland",
};

/** The country whose VAT a customer in `country` (any case) comes under: France for Monaco. */
function vatCountryOf(country: string): string {
  const code = country.trim().toUpperCase();
  return code === "MC" ? "FR" : code;
}

/** Whether the customer is in Northern Ireland: country XI, or GB with a VAT ID of Northern Ireland. */
function inNorthernIreland(place: Pick<SaleFacts, "country" | "vatId">): boolean {
  const code = place.country.trim().toUpperCase();
  if (code === NORTHERN_IRELAND) return true;
  return (
    code === "GB" &&
    place.vatId?.status === "valid_format" &&
    place.vatId.country === NORTHERN_IRELAND
  );
}

/** The member state (or XI) whose VAT rules the customer's place follows: FR for Monaco. */
function vatPlaceOf(place: Pick<SaleFacts, "country" | "vatId">): string {
  return inNorthernIreland(place) ? NORTHERN_IRELAND : vatCountryOf(place.country);
}

/** Where the customer is, for the texts: Monaco, Northern Ireland, a member state or the code. */
function customerPlaceName(place: Pick<SaleFacts, "country" | "vatId">): string {
  return inNorthernIreland(place) ? countryName(NORTHERN_IRELAND) : countryName(place.country);
}

/** How the standard rate of a member state is looked up (tests pass a table without a rate). */
export type StandardRateOf = (state: EuMemberState) => string | undefined;

const tableRate: StandardRateOf = (state) => state.standardRate;

/**
 * The rule(s) for `facts`. Pure; `rateOf` is the standard-rate lookup for One-Stop-Shop outcomes
 * (default: the dated table in `eu.ts`).
 */
export function decideSalesTaxRule(
  facts: SaleFacts,
  rateOf: StandardRateOf = tableRate,
): SalesTaxRuleDecision {
  const decision = decideCandidates(facts, rateOf);
  return {
    decided: decision.decided,
    suggestions: decision.suggestions.map(withoutRoutine),
    exceptions: decision.exceptions.map(withoutRoutine),
    notes: decision.notes,
    warnings: decision.warnings,
  };
}

interface CandidateDecision {
  readonly decided: boolean;
  readonly suggestions: readonly Candidate[];
  readonly exceptions: readonly Candidate[];
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
}

function decideCandidates(facts: SaleFacts, rateOf: StandardRateOf): CandidateDecision {
  const warnings = vatIdWarnings(facts);
  if (facts.regime === "small_business") {
    const decision = smallBusiness(facts);
    return { ...decision, warnings: [...warnings, ...decision.warnings] };
  }
  const decision = regular(facts, rateOf);
  const regimeKnown = facts.regime !== undefined;
  return {
    decided: decision.decided && regimeKnown,
    suggestions: decision.suggestions,
    exceptions: regimeKnown ? decision.exceptions : [...decision.exceptions, SMALL_BUSINESS_IF],
    notes: [...decision.notes, SOLL_IST_NOTE, ESTABLISHMENT_NOTE],
    warnings: [...(regimeKnown ? [] : [UNKNOWN_REGIME]), ...warnings, ...decision.warnings],
  };
}

function withoutRoutine(candidate: Candidate): RuleOutcome {
  const { routine: _routine, ...outcome } = candidate;
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Regular VAT (Regelbesteuerung)
// ---------------------------------------------------------------------------------------------

function regular(facts: SaleFacts, rateOf: StandardRateOf): CandidateDecision {
  const decision = byArea(facts, rateOf);
  const outside = outsideVatAreaException(facts);
  return {
    ...decision,
    exceptions: outside === undefined ? decision.exceptions : [...decision.exceptions, outside],
    notes: [...decision.notes, ...placeNotes(facts)],
  };
}

function byArea(facts: SaleFacts, rateOf: StandardRateOf): CandidateDecision {
  switch (customerAreaOf(facts)) {
    case "germany":
      return domestic(facts);
    case "eu":
      return facts.customerType === "business" ? euBusiness(facts) : euConsumer(facts, rateOf);
    case "non_eu":
      return nonEu(facts, rateOf);
  }
}

/** Notes on a place VAT law treats apart from its ISO code (Monaco, Northern Ireland). */
function placeNotes(facts: SaleFacts): string[] {
  const code = facts.country.trim().toUpperCase();
  if (code === "MC") return [MONACO_NOTE];
  if (inNorthernIreland(facts) || (code === "GB" && facts.supply === "goods")) {
    return [NORTHERN_IRELAND_NOTE];
  }
  return [];
}

/**
 * Parts of member states outside the EU VAT area under the state's own ISO code (Art. 6
 * MwStSystRL), with what to name them and the legal basis to add.
 */
const OUTSIDE_VAT_AREA: Readonly<
  Record<string, { readonly places: string; readonly legalBasis: string }>
> = {
  DE: {
    places: "Heligoland or Büsingen am Hochrhein",
    legalBasis: "§ 1 Abs. 2 Satz 1 UStG; Art. 6 MwStSystRL",
  },
  ES: { places: "the Canary Islands, Ceuta or Melilla", legalBasis: "Art. 6 MwStSystRL" },
  GR: { places: "Mount Athos", legalBasis: "Art. 6 MwStSystRL" },
  IT: {
    places: "Livigno, Campione d'Italia or the Italian waters of Lake Lugano",
    legalBasis: "Art. 6 MwStSystRL",
  },
};

/**
 * The exception for a customer in a part of its member state that lies outside the EU VAT area:
 * goods go there as an export (rule 2), services are taxed there (rule 17). Not routine: a draft
 * with such a rule still gets the hint, which says it can be right in a special case.
 */
function outsideVatAreaException(facts: SaleFacts): Candidate | undefined {
  const territory = OUTSIDE_VAT_AREA[facts.country.trim().toUpperCase()];
  if (territory === undefined) return undefined;
  const { places, legalBasis } = territory;
  if (facts.supply === "goods") {
    return {
      ...exportOf(
        `Goods shipped to ${places}, which lie outside the EU VAT area: a tax-exempt export ` +
          "(Ausfuhr).",
        `§ 4 Nr. 1 Buchst. a, § 6 UStG; ${legalBasis}`,
      ),
      when: `the goods go to ${places}`,
    };
  }
  if (facts.customerType === "business") {
    return {
      ...notTaxableHere(
        `A service to a business established in ${places}, outside the EU VAT area: the place ` +
          "of supply is there (§ 3a Abs. 2 UStG), so it is not taxable in Germany.",
        `§ 3a Abs. 2 UStG; ${legalBasis}`,
      ),
      when: `the customer is established in ${places}`,
    };
  }
  if (facts.supply === "digital_services") {
    return {
      ...notTaxableHere(
        "Telecommunication, broadcasting and electronic services to a consumer living in " +
          `${places}, outside the EU VAT area, are taxed there (§ 3a Abs. 5 UStG): not taxable ` +
          "in Germany.",
        `§ 3a Abs. 5 UStG; ${legalBasis}`,
      ),
      when: `the customer lives in ${places}`,
    };
  }
  return {
    ...notTaxableHere(
      `A catalogue service of § 3a Abs. 4 UStG to a consumer living in ${places}, outside the ` +
        "EU VAT area, is taxed where the consumer lives: not taxable in Germany.",
      `§ 3a Abs. 4 UStG; ${legalBasis}`,
    ),
    when:
      `the customer lives in ${places} and the service is one of § 3a Abs. 4 UStG (e.g. ` +
      "consulting, advertising or data processing)",
  };
}

function domestic(facts: SaleFacts): CandidateDecision {
  const legalBasis =
    facts.supply === "goods"
      ? "§ 1 Abs. 1 Nr. 1, § 3 Abs. 6, § 12 UStG"
      : "§ 1 Abs. 1 Nr. 1, § 3a Abs. 1 and 2, § 12 UStG";
  return {
    decided: true,
    suggestions: [
      german(
        "The customer is in Germany, so the sale is taxable here at the German rate.",
        legalBasis,
      ),
    ],
    exceptions: [
      EXEMPT_DOMESTIC,
      ...(facts.customerType === "business" ? [DOMESTIC_REVERSE_CHARGE] : []),
    ],
    notes: [],
    warnings: [],
  };
}

function euBusiness(facts: SaleFacts): CandidateDecision {
  const name = customerPlaceName(facts);
  if (facts.supply === "goods") {
    const missing = missingVatIdReason(facts);
    if (missing === undefined) {
      return decided(
        {
          taxRuleId: 3,
          rate: "0",
          invoiceNote: INTRA_EU_SUPPLY_NOTE,
          legalBasis: "§ 4 Nr. 1 Buchst. b, § 6a UStG; § 14a Abs. 3 UStG; § 18a UStG (ZM)",
          reason:
            `Goods shipped to a business in ${name} that uses a VAT ID of another member state: ` +
            "a tax-exempt intra-Community supply; the customer pays acquisition VAT in its state.",
        },
        [],
        [INTRA_EU_GOODS_NOTE],
      );
    }
    return {
      decided: true,
      suggestions: [
        german(
          `${missing} Without a valid VAT ID of another member state an intra-Community supply ` +
            "is not tax-exempt, so German VAT applies.",
          "§ 6a Abs. 1 Satz 1 Nr. 4 UStG; § 1 Abs. 1 Nr. 1, § 3 Abs. 6 UStG",
        ),
      ],
      exceptions: [
        {
          taxRuleId: 3,
          rate: "0",
          invoiceNote: INTRA_EU_SUPPLY_NOTE,
          legalBasis: "§ 4 Nr. 1 Buchst. b, § 6a UStG",
          reason: "Tax-exempt intra-Community supply.",
          when: "the customer gives you a valid VAT ID of another EU member state before you invoice",
        },
      ],
      notes: [INTRA_EU_GOODS_NOTE],
      warnings: [
        `${missing} Ask the customer for it: the intra-Community supply exemption depends on it.`,
      ],
    };
  }
  const withoutVatId = facts.vatId?.status !== "valid_format";
  return {
    decided: true,
    suggestions: [
      {
        taxRuleId: 21,
        rate: "0",
        invoiceNote: REVERSE_CHARGE_NOTE,
        legalBasis:
          "§ 3a Abs. 2 UStG; Art. 44 and 196 MwStSystRL; § 14a Abs. 1 UStG; § 18a UStG (ZM)",
        reason:
          `A service to a business in ${name}: the place of supply is the customer's state ` +
          "(§ 3a Abs. 2 UStG), and the customer owes the VAT there (reverse charge).",
      },
    ],
    exceptions: [SPECIAL_PLACE_GERMANY],
    notes: [SPECIAL_PLACE_NOTE],
    warnings: withoutVatId
      ? [
          "No VAT ID of the customer in a valid format is known. You need other proof that the " +
            "customer is a business (Abschnitt 3a.2 Abs. 9 to 11 UStAE), and the Zusammenfassende " +
            "Meldung needs the VAT ID: ask for it.",
        ]
      : [],
  };
}

function euConsumer(facts: SaleFacts, rateOf: StandardRateOf): CandidateDecision {
  const name = customerPlaceName(facts);
  const vatPlace = vatPlaceOf(facts);
  const vatName = countryName(vatPlace);
  const destination = destinationRate(vatPlace, rateOf);
  switch (facts.supply) {
    case "goods":
      return {
        decided: false,
        suggestions: [
          {
            taxRuleId: 18,
            ...destination,
            legalBasis: "§ 3c Abs. 1 and 4 UStG; § 18j UStG (One-Stop-Shop)",
            reason:
              `A distance sale of goods to a consumer in ${name}: above the EU threshold the VAT ` +
              `of ${vatName} applies, declared through the One-Stop-Shop.`,
            when: OVER_THRESHOLD,
          },
          german(
            `A distance sale of goods to a consumer in ${name} below the EU threshold: the ` +
              "place of supply stays in Germany.",
            "§ 3c Abs. 4 UStG; § 3 Abs. 6 UStG",
            UNDER_THRESHOLD,
          ),
        ],
        exceptions: [],
        notes: [OSS_NOTE, GOODS_SHIPPED_NOTE],
        warnings: [],
      };
    case "digital_services":
      return {
        decided: false,
        suggestions: [
          {
            taxRuleId: 19,
            ...destination,
            legalBasis: "§ 3a Abs. 5 UStG; § 18j UStG (One-Stop-Shop)",
            reason:
              `Telecommunication, broadcasting or electronic services to a consumer in ${name}: ` +
              `above the EU threshold the VAT of ${vatName} applies, declared through the ` +
              "One-Stop-Shop.",
            when: OVER_THRESHOLD,
          },
          german(
            `Telecommunication, broadcasting or electronic services to a consumer in ${name} ` +
              "below the EU threshold: the place of supply stays in Germany.",
            "§ 3a Abs. 5 Satz 3 UStG",
            UNDER_THRESHOLD,
          ),
        ],
        exceptions: [],
        notes: [OSS_NOTE],
        warnings: [],
      };
    case "services":
      return decided(
        german(
          "A service to a consumer is taxed where your business is established (§ 3a Abs. 1 " +
            "UStG), so German VAT applies.",
          "§ 3a Abs. 1 UStG",
        ),
        [
          {
            taxRuleId: 20,
            ...destination,
            legalBasis: "§ 3a Abs. 3, § 3b UStG; § 18j UStG (One-Stop-Shop)",
            reason: `A service whose place of supply is in ${name}: the VAT of ${vatName} applies.`,
            when:
              `the service has a special place of supply in ${name} (§ 3a Abs. 3, § 3b UStG), ` +
              "e.g. work on land there, admission to an event there, passenger transport there, " +
              "or long-term hire of a means of transport to a consumer living there; declared " +
              "through the One-Stop-Shop",
          },
        ],
        [],
      );
  }
}

function nonEu(facts: SaleFacts, rateOf: StandardRateOf): CandidateDecision {
  if (facts.supply === "goods") {
    const toNorthernIreland = northernIrelandGoods(facts, rateOf);
    return decided(
      exportOf(
        "Goods shipped to a customer outside the EU: a tax-exempt export (Ausfuhr).",
        "§ 4 Nr. 1 Buchst. a, § 6 UStG; §§ 8 to 17 UStDV (proof of export)",
      ),
      [
        german(
          "Goods that stay in the EU, or an export that cannot be proven, are taxable in " +
            "Germany.",
          "§ 1 Abs. 1 Nr. 1, § 3 Abs. 6 UStG",
          "the goods do not leave the EU, or the export cannot be proven",
        ),
        ...(toNorthernIreland === undefined ? [] : [toNorthernIreland]),
      ],
      [
        EXPORT_NOTE,
        ...(facts.customerType === "consumer" ? [EXPORT_COLLECTED_NOTE] : [GOODS_SHIPPED_NOTE]),
      ],
    );
  }
  if (facts.customerType === "business") {
    return decided(
      notTaxableHere(
        "A service to a business outside the EU: the place of supply is the customer's country " +
          "(§ 3a Abs. 2 UStG), so it is not taxable in Germany.",
        "§ 3a Abs. 2 UStG",
      ),
      [SPECIAL_PLACE_GERMANY],
      [NON_EU_BUSINESS_NOTE, SPECIAL_PLACE_NOTE],
    );
  }
  if (facts.supply === "digital_services") {
    return decided(
      notTaxableHere(
        "Telecommunication, broadcasting and electronic services to a consumer outside the EU " +
          "are taxed where the consumer lives (§ 3a Abs. 5 UStG): not taxable in Germany.",
        "§ 3a Abs. 5 UStG",
      ),
      [],
      [NON_EU_LOCAL_VAT_NOTE],
    );
  }
  return {
    decided: false,
    suggestions: [
      {
        ...notTaxableHere(
          "A catalogue service of § 3a Abs. 4 UStG to a consumer living outside the EU is taxed " +
            "where the consumer lives: not taxable in Germany.",
          "§ 3a Abs. 4 UStG",
        ),
        when:
          "the service is one of § 3a Abs. 4 UStG, e.g. consulting, legal or tax advice, " +
          "engineering, advertising, data processing, provision of information, licences and " +
          "rights, or staff provision",
      },
      german(
        "Other services to consumers are taxed where your business is established.",
        "§ 3a Abs. 1 UStG",
        "it is any other service",
      ),
    ],
    exceptions: [],
    notes: [NON_EU_LOCAL_VAT_NOTE],
    warnings: [],
  };
}

/**
 * For goods to a GB customer, the case that they go to Northern Ireland, which follows the EU
 * rules for goods: an intra-Community supply to a business with an XI VAT ID (rule 3), a distance
 * sale to a consumer (rule 18 above the threshold; below it rule 1, the export exception's case).
 */
function northernIrelandGoods(facts: SaleFacts, rateOf: StandardRateOf): Candidate | undefined {
  if (facts.country.trim().toUpperCase() !== "GB") return undefined;
  if (facts.customerType === "business") {
    return {
      taxRuleId: 3,
      rate: "0",
      invoiceNote: INTRA_EU_SUPPLY_NOTE,
      legalBasis: `§ 4 Nr. 1 Buchst. b, § 6a UStG; ${WINDSOR_FRAMEWORK}`,
      reason:
        "Goods shipped to a business in Northern Ireland, which follows the EU VAT rules for " +
        "goods: a tax-exempt intra-Community supply, not an export.",
      when:
        "the goods go to Northern Ireland and the customer gives you a valid VAT ID of Northern " +
        "Ireland (XI…)",
    };
  }
  return {
    taxRuleId: 18,
    ...destinationRate(NORTHERN_IRELAND, rateOf),
    legalBasis: `§ 3c Abs. 1 and 4 UStG; § 18j UStG (One-Stop-Shop); ${WINDSOR_FRAMEWORK}`,
    reason:
      "A distance sale of goods to a consumer in Northern Ireland, which follows the EU VAT " +
      "rules for goods: above the EU threshold the VAT of Northern Ireland applies, declared " +
      "through the One-Stop-Shop.",
    when:
      "the goods go to Northern Ireland and your distance sales of goods and digital services to " +
      "consumers in other EU states (Northern Ireland included) exceed 10,000 € net; below that, " +
      "German VAT applies (rule 1)",
  };
}

// ---------------------------------------------------------------------------------------------
// Kleinunternehmer (§ 19 UStG)
// ---------------------------------------------------------------------------------------------

function smallBusiness(facts: SaleFacts): CandidateDecision {
  const area = customerAreaOf(facts);
  const notes: string[] = [SMALL_BUSINESS_THRESHOLD_NOTE];
  if (area === "eu" && facts.customerType === "business") {
    notes.push(
      facts.supply === "goods"
        ? "A Kleinunternehmer's supplies of goods to EU businesses fall under the § 19 " +
            "exemption, not under the intra-Community supply exemption (rule 3)."
        : "A service to a business in another EU state is supplied there (§ 3a Abs. 2 UStG), " +
            "and the customer owes the VAT there: the invoice should also carry " +
            '"Steuerschuldnerschaft des Leistungsempfängers" and both VAT IDs (§ 14a Abs. 1 UStG).',
    );
  }
  if (area === "eu" && facts.customerType === "consumer" && facts.supply !== "services") {
    notes.push(
      "Above 10,000 € a year of distance sales and digital services to consumers in other EU " +
        "states, the place of supply moves to the consumer's state (§ 3c, § 3a Abs. 5 UStG), " +
        "where the § 19 exemption does not apply; sevDesk offers no One-Stop-Shop rule on a " +
        "Kleinunternehmer account.",
    );
  }
  return {
    decided: true,
    suggestions: [
      {
        taxRuleId: 11,
        rate: "0",
        invoiceNote: {
          de: "Steuerbefreiung nach § 19 UStG (Kleinunternehmerregelung)",
          en: "VAT exemption for small businesses under § 19 UStG",
          required: true,
        },
        legalBasis: "§ 19 Abs. 1 UStG; § 34a UStDV (invoice note)",
        reason:
          "This sevDesk account uses the Kleinunternehmer regulation: its sales show no VAT, and " +
          "sevDesk takes tax rule 11 for every sale on such an account.",
      },
    ],
    exceptions: [],
    notes,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Building blocks (trusted text)
// ---------------------------------------------------------------------------------------------

const GERMAN_RATE_NOTE =
  "19 % standard rate; 7 % for the goods and services of § 12 Abs. 2 UStG (e.g. most food, books).";

/** Rule 1 at the German rate. */
function german(reason: string, legalBasis: string, when?: string): Candidate {
  return {
    taxRuleId: 1,
    rate: "19",
    rateNote: GERMAN_RATE_NOTE,
    legalBasis,
    reason,
    ...(when === undefined ? {} : { when }),
  };
}

/** Rule 2, a tax-exempt export. */
function exportOf(reason: string, legalBasis: string): Candidate {
  return {
    taxRuleId: 2,
    rate: "0",
    invoiceNote: {
      de: "Steuerfreie Ausfuhrlieferung",
      en: "Tax-exempt export delivery",
      required: true,
    },
    legalBasis,
    reason,
  };
}

/** Rule 17, not taxable in Germany. */
function notTaxableHere(reason: string, legalBasis: string): Candidate {
  return {
    taxRuleId: 17,
    rate: "0",
    invoiceNote: {
      de: "Nicht im Inland steuerbare Leistung",
      en: "Not taxable in Germany (place of supply abroad)",
      required: false,
    },
    legalBasis,
    reason,
  };
}

function decided(
  suggestion: Candidate,
  exceptions: readonly Candidate[],
  notes: readonly string[],
): CandidateDecision {
  return { decided: true, suggestions: [suggestion], exceptions, notes, warnings: [] };
}

/**
 * The standard rate of the member state whose VAT applies (`vatPlace`, from {@link vatPlaceOf})
 * for a One-Stop-Shop outcome. Northern Ireland's is not in the verified table, so it has none.
 */
function destinationRate(
  vatPlace: string,
  rateOf: StandardRateOf,
): { readonly rate: string | undefined; readonly rateNote: string } {
  const state = euMemberState(vatPlace);
  const name = countryName(vatPlace);
  const rate = state === undefined ? undefined : rateOf(state);
  if (rate === undefined) {
    return {
      rate: undefined,
      rateNote:
        `The standard rate of ${name} is not in this server's verified table; look it up (e.g. ` +
        "on the European Commission's Your Europe page) before invoicing.",
    };
  }
  return {
    rate,
    rateNote:
      `Standard rate of ${name} (${EU_STANDARD_RATES_SOURCE}; read ${EU_STANDARD_RATES_AS_OF}). ` +
      `Reduced rates of ${name} can apply to some goods and services.`,
  };
}

function countryName(country: string): string {
  return placeName(country) ?? country.trim().toUpperCase();
}

const INTRA_EU_SUPPLY_NOTE: InvoiceNote = {
  de: "Steuerfreie innergemeinschaftliche Lieferung",
  en: "Tax-exempt intra-Community supply; your and the customer's VAT IDs on the invoice",
  required: true,
};

const REVERSE_CHARGE_NOTE: InvoiceNote = {
  de: "Steuerschuldnerschaft des Leistungsempfängers",
  en: "Reverse charge: the customer owes the VAT; your and the customer's VAT IDs on the invoice",
  required: true,
};

const EXEMPT_DOMESTIC: Candidate = {
  taxRuleId: 4,
  rate: "0",
  invoiceNote: {
    de: "Steuerfreie Leistung nach § 4 Nr. … UStG (die Befreiung nennen)",
    en: "Tax-exempt under § 4 UStG; name the exemption that applies",
    required: true,
  },
  legalBasis: "§ 4 UStG; § 14 Abs. 4 Satz 1 Nr. 8 UStG",
  reason: "A sale that § 4 UStG exempts from VAT.",
  when:
    "the sale is tax-exempt under § 4 UStG, e.g. medical care, education, letting of " +
    "property or financial services",
  routine: true,
};

const DOMESTIC_REVERSE_CHARGE: Candidate = {
  taxRuleId: 5,
  rate: "0",
  invoiceNote: { ...REVERSE_CHARGE_NOTE, en: "Reverse charge: the business customer owes the VAT" },
  legalBasis: "§ 13b Abs. 2 and 5 UStG; § 14a Abs. 5 UStG",
  reason: "A domestic sale where the business customer owes the VAT (reverse charge).",
  when:
    "it is a case of § 13b Abs. 2 UStG, e.g. construction services to a business that itself " +
    "provides construction services, building cleaning, scrap metal, or mobile phones and " +
    "chips from 5,000 € net",
  routine: true,
};

const SPECIAL_PLACE_GERMANY: Candidate = german(
  "A service whose place of supply is in Germany is taxable here.",
  "§ 3a Abs. 3, § 3b UStG",
  "the service has a special place of supply in Germany (§ 3a Abs. 3, § 3b UStG), e.g. work " +
    "on land or buildings in Germany, admission to an event in Germany, or short-term hire of a " +
    "means of transport handed over in Germany",
);

const SMALL_BUSINESS_IF: Candidate = {
  taxRuleId: 11,
  rate: "0",
  invoiceNote: {
    de: "Steuerbefreiung nach § 19 UStG (Kleinunternehmerregelung)",
    en: "VAT exemption for small businesses under § 19 UStG",
    required: true,
  },
  legalBasis: "§ 19 Abs. 1 UStG; § 34a UStDV (invoice note)",
  reason: "A Kleinunternehmer account takes tax rule 11 for every sale.",
  when: "the account uses the Kleinunternehmer regulation (§ 19 UStG)",
  routine: true,
};

const OVER_THRESHOLD =
  "your distance sales of goods and digital services to consumers in other EU states exceeded " +
  "10,000 € net in the previous calendar year or exceed it in the current one, or you opted for " +
  "taxation in the consumer's state (§ 3c Abs. 4, § 3a Abs. 5 UStG)";

const UNDER_THRESHOLD =
  "those sales stayed at or below 10,000 € net in the previous and stay so in the current " +
  "calendar year, and you did not opt for taxation in the consumer's state";

const UNKNOWN_REGIME =
  "The account's VAT regulation (regular VAT or Kleinunternehmer, § 19 UStG) could not be read " +
  "from sevDesk, so regular VAT is assumed; on a Kleinunternehmer account every sale takes rule 11.";

const SOLL_IST_NOTE =
  "Whether the account pays VAT on invoicing or on payment (Soll- or Istversteuerung) changes " +
  "only when the VAT is due, not the tax rule; sevDesk's API does not expose it.";

const ESTABLISHMENT_NOTE =
  "Assumes your business is established in Germany, as sevDesk's tax rules do.";

const INTRA_EU_GOODS_NOTE =
  "The exemption needs the customer's valid VAT ID of another member state (§ 6a Abs. 1 Satz 1 " +
  "Nr. 4 UStG; sevdesk_vat_id_check checks the format and, if the server allows it, with VIES), " +
  "proof that the goods reached the other state (Gelangensbestätigung, § 17b UStDV) and a " +
  "correct Zusammenfassende Meldung (§ 18a UStG).";

const SPECIAL_PLACE_NOTE =
  "Services connected with land, events, passenger transport, restaurants or the hire of means " +
  "of transport follow special place-of-supply rules (§ 3a Abs. 3, § 3b UStG); check whether " +
  "the service is one of them.";

const OSS_NOTE =
  "Whether the 10,000 € threshold is exceeded, and whether you are registered for the " +
  "One-Stop-Shop (§ 18j UStG; otherwise you register in the consumer's state), is not known " +
  "here. sevDesk's One-Stop-Shop rules (18 to 20) are not available for e-invoices, vouchers, " +
  "a custom revenue account, or advance, partial and final invoices.";

const GOODS_SHIPPED_NOTE =
  "Assumes the goods are shipped from Germany to the customer's country by you or on your behalf.";

const EXPORT_NOTE =
  "The exemption needs proof that the goods left the EU (Ausfuhrnachweis, e.g. the customs " +
  "exit confirmation from ATLAS).";

const EXPORT_COLLECTED_NOTE =
  "When a private customer collects the goods in Germany, the export exemption has extra " +
  "conditions (§ 6 Abs. 1 Nr. 2 and Abs. 3a UStG).";

const NON_EU_BUSINESS_NOTE =
  "Keep proof that the customer is a business, e.g. a certificate of its tax authority " +
  "(Abschnitt 3a.2 Abs. 11 UStAE). The customer's country may charge its own VAT (reverse " +
  "charge or registration).";

const WINDSOR_FRAMEWORK = "Art. 8 Protocol on Ireland/Northern Ireland (Windsor Framework)";

const NORTHERN_IRELAND_NOTE =
  "Northern Ireland follows the EU VAT rules for goods and the UK's for services (Windsor " +
  "Framework, Art. 8 of the Protocol on Ireland/Northern Ireland). Goods that go there are not " +
  "an export but an intra-Community supply to a business with an XI VAT ID (rule 3, also in the " +
  "Zusammenfassende Meldung; without one, German VAT) or a distance sale to a consumer. Services " +
  "count as supplied outside the EU. Pass country XI, or the customer's XI VAT ID with GB.";

const MONACO_NOTE =
  "Monaco counts as France for VAT (§ 1 Abs. 2a Satz 2 UStG, Art. 7 MwStSystRL): businesses " +
  "there have French VAT IDs (FR…), and where the VAT of the customer's state applies, it is " +
  "France's.";

const NON_EU_LOCAL_VAT_NOTE =
  "The customer's country may require you to register for its own VAT or GST on such sales " +
  "(e.g. Switzerland, Norway, the United Kingdom).";

const SMALL_BUSINESS_THRESHOLD_NOTE =
  "The Kleinunternehmer exemption applies while total turnover stayed at or below 25,000 € in " +
  "the previous year and stays at or below 100,000 € in the current one (§ 19 Abs. 1 UStG); " +
  "beyond that, regular VAT applies from the sale that crosses 100,000 €.";

// ---------------------------------------------------------------------------------------------
// The VAT ID
// ---------------------------------------------------------------------------------------------

/**
 * Why the customer has no VAT ID that allows an intra-Community supply (a sentence), or
 * undefined when it has one (a valid format of another member state).
 */
function missingVatIdReason(facts: SaleFacts): string | undefined {
  const vatId = facts.vatId;
  if (vatId === undefined) return "No VAT ID of the customer is known.";
  if (vatId.status !== "valid_format") {
    return "The customer's VAT ID is not in the format of an EU member state.";
  }
  if (vatId.country === "DE") {
    return "The customer's VAT ID is German, not one of another member state.";
  }
  return undefined;
}

/** Warnings about the VAT ID given (format, issuing state, consumer). */
function vatIdWarnings(facts: SaleFacts): string[] {
  const vatId = facts.vatId;
  if (vatId === undefined) return [];
  const area = customerAreaOf(facts);
  const warnings: string[] = [];
  switch (vatId.status) {
    case "unreadable":
      warnings.push("The VAT ID given is not readable as one (two letters, then the number).");
      break;
    case "not_eu":
      if (area !== "non_eu") {
        warnings.push("The VAT ID given does not start with the prefix of an EU member state.");
      }
      break;
    case "invalid_format":
      warnings.push(
        `The VAT ID does not fit the format of ${vatId.countryName ?? "its member state"} ` +
          `(${vatId.expectedFormat ?? "see the VIES FAQ"}); check it with the customer.`,
      );
      break;
    case "valid_format":
      if (vatId.country !== undefined && vatId.country !== vatPlaceOf(facts) && area !== "non_eu") {
        warnings.push(
          `The VAT ID was issued by ${vatId.countryName ?? vatId.country}, but the customer is in ` +
            `${customerPlaceName(facts)}: check which applies, the rule follows where the ` +
            "goods go or where the customer is established.",
        );
      }
      break;
  }
  if (facts.customerType === "consumer" && vatId.status === "valid_format") {
    warnings.push(
      "A VAT ID was given for a consumer. If the customer buys as a business, ask again with " +
        "customerType business.",
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Draft check
// ---------------------------------------------------------------------------------------------

/** What a draft knows about its customer (the supply kind it does not know). */
export type DraftSaleFacts = Omit<SaleFacts, "supply">;

/**
 * The rules a sale to this customer usually takes, for any kind of supply: every suggestion,
 * plus the exceptions that are routine for some businesses (tax-exempt sales, domestic reverse
 * charge, rule 11 while the regime is unknown).
 */
export function expectedSalesRuleIds(facts: DraftSaleFacts): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const supply of SUPPLY_KINDS) {
    const decision = decideCandidates({ ...facts, supply }, tableRate);
    for (const outcome of decision.suggestions) ids.add(outcome.taxRuleId);
    for (const outcome of decision.exceptions) {
      if (outcome.routine === true) ids.add(outcome.taxRuleId);
    }
  }
  return ids;
}

const SUPPLY_LABELS: Readonly<Record<SupplyKind, string>> = {
  goods: "goods",
  services: "services",
  digital_services: "digital services",
};

/**
 * The preview hint for a draft invoice whose rule `ruleId` is none of the rules
 * {@link expectedSalesRuleIds} expects for its customer; undefined when it is one of them. A
 * hint, never a refusal (trusted text: country names come from the EU table, never from sevDesk).
 */
export function taxRuleMismatchWarning(ruleId: number, facts: DraftSaleFacts): string | undefined {
  if (expectedSalesRuleIds(facts).has(ruleId)) return undefined;
  const byRules = new Map<string, string[]>();
  for (const supply of SUPPLY_KINDS) {
    const rules = decideCandidates({ ...facts, supply }, tableRate)
      .suggestions.map((outcome) => String(outcome.taxRuleId))
      .join(" or ");
    byRules.set(rules, [...(byRules.get(rules) ?? []), SUPPLY_LABELS[supply]]);
  }
  const expected = [...byRules]
    .map(([rules, supplies]) => `${rules} for ${listText(supplies)}`)
    .join(", ");
  const rule = taxRuleById(ruleId);
  const label =
    rule === undefined
      ? `Tax rule ${String(ruleId)}`
      : `Tax rule ${String(rule.id)} (${rule.nameDe})`;
  return (
    `${label} is not the usual rule for this customer (${customerLabel(facts)}): ${expected}. ` +
    "It can still be right in a special case; sevdesk_tax_rule_suggest explains the choice. " +
    "A hint, not tax advice."
  );
}

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  const last = items.at(-1) ?? "";
  return items.length <= 1 ? last : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** The customer as the hint names it; where a VAT ID matters, judged for goods. */
function customerLabel(facts: DraftSaleFacts): string {
  const vatId =
    facts.vatId?.status === "valid_format"
      ? " with a VAT ID"
      : facts.customerType === "business" && customerAreaOf({ ...facts, supply: "goods" }) === "eu"
        ? " without a VAT ID in a valid format"
        : "";
  return `a ${facts.customerType} in ${customerPlaceName(facts)}${vatId}`;
}
