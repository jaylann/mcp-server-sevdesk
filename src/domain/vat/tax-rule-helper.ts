/**
 * The tax-rule helper behind `sevdesk_tax_rule_suggest`: gathers the facts of a sale (the
 * account's regime from the cached `GET /SevClient`; with a contact id, the contact's invoice
 * address country, VAT ID and kind from `GET /Contact/{id}` and its addresses), lets the call's
 * own values win, checks the VAT ID's format offline and returns the decision of
 * `sales-tax-rule.ts` as a DTO. Reads only; never calls VIES or any other host.
 *
 * The customer type, when the call does not say: business when the contact's VAT ID shows it
 * (`vatIdShowsBusiness`: a valid format, or outside the EU another country's number) or the
 * contact is an organisation (sevDesk's rule: `name` set), else consumer; without a contact,
 * business when the VAT ID given shows it. "n/a", "-" or a number in the wrong format is no
 * evidence. The result says where each fact came from.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { loadAccountSettings, type TaxRegime, taxRegimeOf } from "../account-settings.js";
import { compact } from "../common.js";
import type { ContactDto } from "../contacts.js";
import type { CountryReadOptions } from "../country-codes.js";
import { invoiceAddressOf, loadContact } from "../drafts/recipient.js";
import { taxRuleById } from "../reference-data.js";
import {
  CUSTOMER_AREAS,
  CUSTOMER_TYPES,
  customerAreaOf,
  type CustomerType,
  decideSalesTaxRule,
  DISCLAIMER,
  placeName,
  type RuleOutcome,
  SUPPLY_KINDS,
  type SupplyKind,
  taxRuleMismatchWarning,
  vatIdShowsBusiness,
} from "./sales-tax-rule.js";
import { checkVatIdFormat, type VatIdFormatCheck, vatIdFormatSchema } from "./vat-id.js";

const outcomeSchema = z.object({
  taxRuleId: z.number().int().describe("sevDesk tax rule (Steuerregel) id for taxRuleId."),
  taxRuleName: z.string().describe("The rule's name in sevDesk (German)."),
  taxRuleNameEn: z.string(),
  rate: z
    .string()
    .optional()
    .describe(
      "VAT rate in percent for the positions, e.g. '19'; for One-Stop-Shop rules the standard " +
        "rate of the customer's state. Absent when it is not known.",
    ),
  rateNote: z.string().optional(),
  invoiceNote: z
    .object({
      de: z.string().describe("The note as printed on a German invoice."),
      en: z.string(),
      required: z.boolean().describe("True when the law requires it; false: recommended."),
    })
    .optional()
    .describe("The note the invoice carries (e.g. Steuerschuldnerschaft des Leistungsempfängers)."),
  legalBasis: z.string(),
  reason: z.string(),
  when: z.string().optional().describe("The condition under which this rule applies."),
});

const TYPE_SOURCES = [
  "input",
  "vat_id",
  "contact_vat_id",
  "contact_organisation",
  "contact_person",
] as const;
type TypeSource = (typeof TYPE_SOURCES)[number];

/** The helper's result (also the tool's output). */
export const taxRuleSuggestionSchema = z.object({
  customer: z.object({
    contactId: z.number().int().optional(),
    country: z
      .string()
      .describe("ISO 3166-1 alpha-2 code of the customer's country; XI for Northern Ireland."),
    countryName: z
      .string()
      .optional()
      .describe("For EU member states, Monaco and Northern Ireland."),
    countryFrom: z.enum(["input", "contact_address"]),
    area: z
      .enum(CUSTOMER_AREAS)
      .describe(
        "germany, eu (another member state) or non_eu, for VAT on this supply: Monaco counts " +
          "as France, Northern Ireland as eu for goods and non_eu for services.",
      ),
    type: z.enum(CUSTOMER_TYPES).describe("business (B2B) or consumer (B2C)."),
    typeFrom: z
      .enum(TYPE_SOURCES)
      .describe(
        "input, vat_id (a VAT ID in a valid format was given), or the contact's VAT ID, kind.",
      ),
  }),
  supply: z.enum(SUPPLY_KINDS),
  regime: z
    .enum(["regular", "small_business", "unknown"])
    .describe(
      "The account's VAT regulation from sevDesk (small_business = Kleinunternehmer, § 19 " +
        "UStG); unknown: it could not be read, regular VAT is assumed.",
    ),
  decided: z
    .boolean()
    .describe("False when the rule depends on a fact not known here: see suggestions[].when."),
  suggestions: z.array(outcomeSchema),
  exceptions: z
    .array(outcomeSchema)
    .describe("Rules that apply instead in special cases, each with its condition."),
  vatId: vatIdFormatSchema
    .optional()
    .describe("Offline format check of the customer's VAT ID (USt-IdNr.); no VIES request."),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.object({ en: z.string(), de: z.string() }).describe("Not tax advice."),
});
export type TaxRuleSuggestion = z.output<typeof taxRuleSuggestionSchema>;

/** What the call says about the sale; every customer fact is optional with a contact. */
export interface TaxRuleHelperInput {
  readonly supply: SupplyKind;
  readonly contactId?: number | undefined;
  /** ISO 3166-1 alpha-2 (any case); EL is read as Greece, XI is Northern Ireland. */
  readonly country?: string | undefined;
  readonly customerType?: CustomerType | undefined;
  readonly vatId?: string | undefined;
}

/**
 * Suggests the tax rule for a sale (see the module doc). Throws a `validation` error when the
 * customer's country or type is neither given nor known from the contact, and the client's
 * errors otherwise (a missing contact becomes a `validation` error that says how to find it).
 */
export async function suggestTaxRule(
  client: SevdeskClient,
  input: TaxRuleHelperInput,
  options: CountryReadOptions,
): Promise<TaxRuleSuggestion> {
  const regime = taxRegimeOf(
    await loadAccountSettings(client, { cacheOwner: options.cacheOwner, signal: options.signal }),
  );
  const contact =
    input.contactId === undefined ? undefined : await loadContact(client, input.contactId, options);

  const contactCountry = contact === undefined ? undefined : invoiceAddressOf(contact)?.country;
  const country = isoCountry(input.country ?? contactCountry);
  if (country === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        contact === undefined
          ? "Say where the customer is: pass country (ISO code such as AT) or contactId."
          : `Contact ${String(contact.contact.id)} has no address with a country sevDesk can ` +
            "name. Pass country (ISO code such as AT).",
    });
  }

  const vatIdText = input.vatId ?? contact?.contact.vatNumber;
  const vatId = vatIdText === undefined ? undefined : checkVatIdFormat(vatIdText);
  const typed = customerTypeOf(input, contact?.contact, vatId, country);
  if (typed === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        (vatId === undefined
          ? ""
          : "The VAT ID given is not in a valid format, so it does not show that the customer " +
            "is a business. ") +
        "Say whether the customer buys as a business or a consumer: pass customerType " +
        "(business or consumer), or contactId.",
    });
  }
  const decision = decideSalesTaxRule({
    regime,
    country,
    customerType: typed.type,
    vatId,
    supply: input.supply,
  });

  return taxRuleSuggestionSchema.parse({
    customer: compact({
      contactId: contact?.contact.id,
      country,
      countryName: placeName(country),
      countryFrom: input.country === undefined ? "contact_address" : "input",
      area: customerAreaOf({ country, vatId, supply: input.supply }),
      type: typed.type,
      typeFrom: typed.from,
    }),
    supply: input.supply,
    regime: regime ?? "unknown",
    decided: decision.decided,
    suggestions: decision.suggestions.map(outcomeDto),
    exceptions: decision.exceptions.map(outcomeDto),
    ...(vatId === undefined ? {} : { vatId }),
    notes: [...decision.notes],
    warnings: [...decision.warnings],
    disclaimer: { ...DISCLAIMER },
  });
}

/**
 * The draft-invoice preview hint when `ruleId` is not a rule a sale to this contact usually takes
 * (`taxRuleMismatchWarning`), judged from the contact (VAT ID, kind) and the invoice address's
 * country (`countryCode`, any case). Undefined when the rule fits or the country is unknown.
 */
export function invoiceTaxRuleHint(
  ruleId: number,
  regime: TaxRegime | undefined,
  contact: ContactDto,
  countryCode: string | undefined,
): string | undefined {
  const country = isoCountry(countryCode);
  if (country === undefined) return undefined;
  return taxRuleMismatchWarning(ruleId, {
    regime,
    country,
    customerType: contactCustomerType(contact, country).type,
    vatId: contactVatId(contact),
  });
}

/** An ISO alpha-2 code in upper case (EL, the Greek VAT prefix, read as GR), or undefined. */
function isoCountry(value: string | undefined): string | undefined {
  const code = value?.trim().toUpperCase();
  if (code === undefined || !/^[A-Z]{2}$/.test(code)) return undefined;
  return code === "EL" ? "GR" : code;
}

interface TypedCustomer {
  readonly type: CustomerType;
  readonly from: TypeSource;
}

/**
 * The customer type and where it came from; undefined when nothing tells it. `vatId` is the VAT
 * ID the decision uses (the call's, else the contact's); `country` is the customer's ISO code.
 */
function customerTypeOf(
  input: TaxRuleHelperInput,
  contact: ContactDto | undefined,
  vatId: VatIdFormatCheck | undefined,
  country: string,
): TypedCustomer | undefined {
  if (input.customerType !== undefined) return { type: input.customerType, from: "input" };
  if (contact !== undefined) return contactCustomerType(contact, country);
  return vatId !== undefined && vatIdShowsBusiness(vatId, country)
    ? { type: "business", from: "vat_id" }
    : undefined;
}

/**
 * Business when the contact's VAT ID shows it or the contact is an organisation, else consumer
 * (see the module doc).
 */
function contactCustomerType(contact: ContactDto, country: string): TypedCustomer {
  const vatId = contactVatId(contact);
  if (vatId !== undefined && vatIdShowsBusiness(vatId, country)) {
    return { type: "business", from: "contact_vat_id" };
  }
  return contact.kind === "organisation"
    ? { type: "business", from: "contact_organisation" }
    : { type: "consumer", from: "contact_person" };
}

/** The format check of the contact's VAT ID, if it has one. */
function contactVatId(contact: ContactDto): VatIdFormatCheck | undefined {
  return contact.vatNumber === undefined ? undefined : checkVatIdFormat(contact.vatNumber);
}

function outcomeDto(outcome: RuleOutcome): z.input<typeof outcomeSchema> {
  const rule = taxRuleById(outcome.taxRuleId);
  return compact({
    taxRuleId: outcome.taxRuleId,
    taxRuleName: rule?.nameDe ?? `Tax rule ${String(outcome.taxRuleId)}`,
    taxRuleNameEn: rule?.nameEn ?? `Tax rule ${String(outcome.taxRuleId)}`,
    rate: outcome.rate,
    rateNote: outcome.rateNote,
    invoiceNote: outcome.invoiceNote === undefined ? undefined : { ...outcome.invoiceNote },
    legalBasis: outcome.legalBasis,
    reason: outcome.reason,
    when: outcome.when,
  });
}
