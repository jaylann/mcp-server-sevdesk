/**
 * The tax-rule helper and the VAT-ID check of the `reports` toolset: two read tools, one task
 * each. The helper decides which tax rule a sale takes and reads only sevDesk; the VAT-ID check
 * is the only tool that may reach a host outside sevDesk (VIES, when `SEVDESK_VIES_CHECK` is on),
 * which is why it declares `openWorldHint` and the helper does not.
 */
import { z } from "zod";

import { CUSTOMER_TYPES, SUPPLY_KINDS } from "../../domain/vat/sales-tax-rule.js";
import {
  suggestTaxRule,
  type TaxRuleSuggestion,
  taxRuleSuggestionSchema,
} from "../../domain/vat/tax-rule-helper.js";
import { checkVatId, type VatIdCheck, vatIdCheckSchema } from "../../domain/vat/vat-id-check.js";
import { defineTool } from "../define-tool.js";
import type { AnyToolDefinition } from "../types.js";

const vatIdInput = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .describe("VAT ID (USt-IdNr.) with its prefix, e.g. ATU12345678; spaces, dots, dashes allowed.");

/** `sevdesk_tax_rule_suggest`: which tax rule (Steuerregel) an outgoing invoice takes. */
export const taxRuleSuggestTool = defineTool({
  name: "sevdesk_tax_rule_suggest",
  title: "Suggest the tax rule for a sale",
  description:
    "Suggest the sevDesk tax rule (Steuerregel) for an outgoing invoice (Rechnung) from the " +
    "customer and what is sold: domestic sales (1), goods to EU businesses with a VAT ID (3, " +
    "innergemeinschaftliche Lieferung), services to EU businesses (21, Reverse Charge), sales to " +
    "EU consumers (1, or One-Stop-Shop 18–20 at the customer country's rate), exports (2), " +
    "services abroad (17) and Kleinunternehmer sales (11, §19 UStG). Uses the account's VAT " +
    "regulation and, with contactId, the contact's country, USt-IdNr. and kind. Returns the " +
    "rule, the rate, the note the invoice must carry (e.g. Steuerschuldnerschaft des " +
    "Leistungsempfängers), the legal basis and the reason; where the answer depends on facts " +
    "it cannot know (thresholds, OSS registration, special services) it returns each option " +
    "with its condition. Checks the VAT ID's format offline; sends nothing outside sevDesk. " +
    "Read only; not tax advice. Before: sevdesk_contacts_search. After: " +
    "sevdesk_invoice_create_draft with taxRuleId.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    supply: z
      .enum(SUPPLY_KINDS)
      .describe(
        "goods (Lieferung), services (sonstige Leistung) or digital_services (telecommunication, " +
          "broadcasting, electronically supplied services, §3a Abs. 5 UStG).",
      ),
    contactId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("The customer's contact: its invoice-address country, VAT ID and kind are used."),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "expected an ISO 3166-1 alpha-2 code such as AT")
      .optional()
      .describe(
        "Customer's country, ISO 3166-1 alpha-2 (e.g. AT, CH; XI for Northern Ireland); " +
          "overrides the contact's.",
      ),
    customerType: z
      .enum(CUSTOMER_TYPES)
      .optional()
      .describe("business (B2B) or consumer (B2C); overrides what the contact suggests."),
    vatId: vatIdInput.optional().describe("Customer's VAT ID; overrides the contact's."),
  }),
  output: taxRuleSuggestionSchema,
  handler: async (args, ctx) => {
    const data = await suggestTaxRule(ctx.client, args, {
      cacheOwner: ctx.config,
      signal: ctx.signal,
    });
    return { data, summary: suggestionSummary(data) };
  },
});

/** `sevdesk_vat_id_check`: is a VAT ID (USt-IdNr.) plausible, and does VIES confirm it? */
export const vatIdCheckTool = defineTool({
  name: "sevdesk_vat_id_check",
  title: "Check a VAT ID",
  description:
    "Check an EU VAT ID (USt-IdNr., Umsatzsteuer-Identifikationsnummer), e.g. before an " +
    "intra-EU invoice with Reverse Charge or an innergemeinschaftliche Lieferung: offline, " +
    "whether it fits the format of the member state its prefix names (all 27; EL for Greece; " +
    "XI for Northern Ireland). " +
    "When the server's operator enabled the live check (SEVDESK_VIES_CHECK, off by default), " +
    "it also asks the European Commission's VIES service whether the number is valid today, " +
    "sending only the VAT ID to ec.europa.eu; otherwise nothing leaves the server. A valid " +
    "format is not proof that the number exists. Read only. See also sevdesk_tax_rule_suggest.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.strictObject({ vatId: vatIdInput }),
  output: vatIdCheckSchema,
  handler: async (args, ctx) => {
    const data = await checkVatId(args.vatId, { vies: ctx.config.viesCheck, signal: ctx.signal });
    return { data, summary: vatIdSummary(data) };
  },
});

/** The tools of this module, in registration order. */
export const REPORT_VAT_TOOLS: readonly AnyToolDefinition[] = [taxRuleSuggestTool, vatIdCheckTool];

/** One trusted sentence: rule ids and names come from reference data, never from sevDesk. */
function suggestionSummary(data: TaxRuleSuggestion): string {
  const rules = data.suggestions
    .map((outcome) => `${String(outcome.taxRuleId)} (${outcome.taxRuleName})`)
    .join(" or ");
  const customer = `a ${data.customer.type} in ${data.customer.countryName ?? data.customer.country}`;
  const lead = data.decided
    ? `Tax rule ${rules} for ${data.supply.replace("_", " ")} to ${customer}.`
    : `Tax rule ${rules} for ${data.supply.replace("_", " ")} to ${customer}, depending on ` +
      "facts not known here (see each suggestion's when).";
  const extra = [
    data.exceptions.length > 0 ? `${String(data.exceptions.length)} exception(s)` : undefined,
    data.warnings.length > 0 ? `${String(data.warnings.length)} warning(s)` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${lead}${extra.length > 0 ? ` ${extra.join(", ")}.` : ""} Not tax advice.`;
}

/** One trusted sentence without the VAT ID itself. */
function vatIdSummary(data: VatIdCheck): string {
  const where = data.format.countryName ?? "an EU member state";
  const format =
    data.format.status === "valid_format"
      ? `The VAT ID fits the format of ${where}.`
      : data.format.status === "invalid_format"
        ? `The VAT ID does not fit the format of ${where}.`
        : data.format.status === "not_eu"
          ? "The VAT ID has no EU member state's prefix."
          : "The value is not readable as a VAT ID.";
  return `${format} ${data.vies.message}`;
}
