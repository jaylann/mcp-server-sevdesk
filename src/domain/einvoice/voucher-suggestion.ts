/**
 * Turns a parsed e-invoice into the fields of a sevDesk voucher (Beleg): direction, supplier
 * candidates, tax rule, one position per VAT rate, dates and Belegnummer. Used by
 * `sevdesk_einvoice_parse` (shown to the model) and by `sevdesk_voucher_import_einvoice`
 * (m4-vouchers), which refuses to import while `blocking` is not empty.
 *
 * Nothing here writes: the account's own company and regime come from the cached `GET /SevClient`
 * (`account-settings.ts`), supplier candidates from `GET /Contact` reads. Contacts are never
 * created; the model gets candidates and decides (or creates one with `sevdesk_contact_create`).
 *
 * **Direction.** The invoice is an expense (Ausgabe, `creditDebit` C) when the account's company
 * is the buyer and revenue (Einnahme, D) when it is the seller. Matched by VAT id (normalized),
 * then by the seller's tax number, then by exact normalized name; when nothing matches the
 * invoice is assumed to be an incoming one (expense) and a warning says so.
 *
 * **Supplier.** Contacts are scanned (`GET /Contact?depth=1`, at most
 * {@link MAX_SCANNED_CONTACTS}) and matched by VAT id (`vatNumber`), then by IBAN
 * (`bankAccount`, only for the seller, whose payee account the invoice carries), then by exact
 * normalized name; when the scan is cut off, a `name` search adds candidates beyond it.
 * `supplierId` is suggested only for exactly one VAT id or IBAN match, and not when that
 * contact's stored IBAN differs from the invoice's payee IBAN (BT-84): then a warning with both
 * IBANs masked asks to check the bank details (payment redirection). A name-only match stays a
 * candidate with a warning.
 *
 * **Own invoices.** For revenue (the account is the seller) the invoice number (BT-1) is looked up
 * among the account's invoices (`GET /Invoice?invoiceNumber=…`, re-checked exactly): an XRechnung
 * that sevDesk itself issued is already booked, so a match blocks the import (`ownInvoiceId`). When
 * the lookup cannot run, revenue imports are blocked as well.
 *
 * **Tax rule** (sevDesk Update 2.0 rules, `reference-data.ts`; one rule per voucher, so VAT
 * categories that need different rules block the import). Sources: the spec's tax rule tables,
 * EN 16931 VAT category semantics (UNTDID 5305), §§ 1a, 4, 13b, 15, 19 UStG.
 *
 * | Account | Direction | Category | Rule |
 * |---|---|---|---|
 * | regular | expense | S from a German seller (or none given) | 9 Vorsteuerabziehbare Aufwendungen |
 * | regular | expense | S from a foreign seller | none: foreign VAT is not deductible (§15 UStG) and rule 10 is not offered on regular accounts (recorded ReceiptGuidance) |
 * | regular | expense | Z, E, O, G | 9 at 0 % (nothing to deduct) |
 * | regular | expense | AE from a German seller | 12 Reverse Charge §13b Abs. 2 (e.g. construction) |
 * | regular | expense | AE from another EU state | 14 Reverse Charge §13b Abs. 1 (EU services) |
 * | regular | expense | AE from outside the EU | 12 Reverse Charge §13b Abs. 2 Nr. 1 |
 * | regular | expense | K | 8 Innergemeinschaftlicher Erwerb (§1a UStG) |
 * | regular | expense | L, M | none (local Canary/Ceuta tax, not German VAT; as above) |
 * | small business | expense | AE | 13 Reverse Charge ohne Vorsteuerabzug (§13b Abs. 5, §19 UStG) |
 * | small business | expense | all others | 10 Nicht vorsteuerabziehbare Aufwendungen (§19 UStG) |
 * | regular | revenue | S, Z | 1 Umsatzsteuerpflichtige Umsätze |
 * | regular | revenue | E | 4 Steuerfreie Umsätze §4 UStG |
 * | regular | revenue | AE to a German buyer | 5 Reverse Charge §13b UStG |
 * | regular | revenue | AE to a buyer outside the EU | 17 Nicht im Inland steuerbare Leistung |
 * | regular | revenue | AE to a buyer in another EU state | none: rule 21 is not allowed on vouchers |
 * | regular | revenue | K | 3 Innergemeinschaftliche Lieferungen |
 * | regular | revenue | G | 2 Ausfuhren |
 * | regular | revenue | O, L, M | none: depends on the case (17 or 22) |
 * | small business | revenue | all | 11 Kleinunternehmer §19 UStG |
 *
 * With a rule that allows only 0 % (10, 12, 13, 14, …) but VAT on the invoice, the VAT is part of
 * the expense: `foldVatForZeroRule` is set (with `foldVatReason`) and the positions stay as on
 * the invoice; the importer folds them (0 %, amount = gross) and checks its totals knowing it did,
 * so folding happens in one place. An unknown regime (settings unreadable) is treated as regular
 * VAT with a warning.
 *
 * **Positions.** One per VAT breakdown row (BG-23): net = taxable amount (BT-116, which already
 * includes document allowances and charges), tax = BT-117, gross = net + tax. Their sum equals
 * BT-109/BT-110/BT-112 for a consistent invoice.
 *
 * **Blocking** (trusted sentences): arithmetic or VAT breakdown errors, MINIMUM/BASIC WL profiles,
 * documents that are not invoices, credit notes (whether sevDesk wants a supplier credit note as
 * a negative expense or as revenue is not settled), foreign currencies, no or mixed tax rules,
 * rates the rule does not allow (unless folded), revenue that sevDesk already has as an invoice or
 * that could not be checked. Formal defects that do not change the amounts (missing
 * identifiers, addresses, XRechnung-only rules) are warnings.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { parseUpstream, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  type AccountCompany,
  loadAccountCompany,
  loadAccountSettings,
  type TaxRegime,
  taxRegimeOf,
} from "../account-settings.js";
import { maskIban } from "../banking.js";
import { moneySchema } from "../common.js";
import { type ContactDto, parseContactRecord, toContactDto } from "../contacts.js";
import { listInvoices } from "../invoices.js";
import { add, compare, isZero, type Money, money } from "../money.js";
import { taxRuleById } from "../reference-data.js";
import { normalizeIban, normalizeVatId } from "./fields.js";
import {
  type EInvoiceParty,
  type ParsedEInvoice,
  VAT_CATEGORY_CODES,
  type VatCategoryCode,
} from "./model.js";

/** Most contacts read when looking for the supplier (two pages of 1,000). */
export const MAX_SCANNED_CONTACTS = 2_000;
const CONTACT_PAGE_SIZE = 1_000;
/** Most candidates shown. */
const MAX_CANDIDATES = 10;
/** Rows of a `name` search added when the scan was cut off. */
const NAME_SEARCH_LIMIT = 100;

/** ISO 3166-1 alpha-2 codes of the EU member states (Greece is GR here, EL in VAT ids). */
const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

/** Findings that change amounts or VAT: an invoice with one of them is not imported. */
const BLOCKING_FINDING = /^(?:SD-PROFILE|SD-NUMBER|BR-1[2-6]|BR-CO-1[0-7]|BR-[A-Z]{1,2}-0[189])$/;

const KIND_BASES = [
  "buyer_vat_id",
  "seller_vat_id",
  "seller_tax_number",
  "buyer_name",
  "seller_name",
  "assumed_expense",
] as const;

const MATCH_KINDS = ["vat_id", "iban", "name"] as const;
type MatchKind = (typeof MATCH_KINDS)[number];

/** The voucher fields suggested for an e-invoice (also part of the parse tool's output). */
export const einvoiceVoucherSuggestionSchema = z.object({
  kind: z
    .enum(["expense", "revenue"])
    .describe("expense = Ausgabe (creditDebit C), revenue = Einnahme (creditDebit D)."),
  kindBasis: z
    .enum(KIND_BASES)
    .describe("How the direction was decided: which party matched the account's own company."),
  counterparty: z
    .object({
      role: z.enum(["seller", "buyer"]),
      name: z.string(),
      vatId: z.string().optional(),
      ibanMasked: z.string().optional().describe("Payee IBAN of the invoice, masked."),
    })
    .describe("The other party: the seller for an expense, the buyer for revenue."),
  supplierCandidates: z
    .array(
      z.object({
        contactId: z.number().int(),
        displayName: z.string(),
        customerNumber: z.string().optional(),
        vatNumber: z.string().optional(),
        matchedBy: z.enum(MATCH_KINDS),
      }),
    )
    .describe("sevDesk contacts that match the counterparty, strongest match first."),
  supplierId: z
    .number()
    .int()
    .optional()
    .describe(
      "Contact to use: only set for exactly one VAT id or IBAN match whose stored IBAN does not " +
        "contradict the invoice's payee IBAN.",
    ),
  supplierSearch: z.object({
    scanned: z.number().int().describe("Contacts compared."),
    complete: z.boolean().describe("False when the account has more contacts than were read."),
  }),
  taxRuleId: z.number().int().optional().describe("Suggested sevDesk tax rule (Steuerregel)."),
  taxRuleName: z.string().optional(),
  taxRuleReason: z.string().describe("Why this rule, or why none could be suggested."),
  positions: z
    .array(
      z.object({
        vatCategory: z.enum(VAT_CATEGORY_CODES),
        taxRate: z.string().describe("Rate for the voucher position, percent."),
        net: moneySchema,
        tax: moneySchema,
        gross: moneySchema,
      }),
    )
    .describe("One voucher position per VAT rate (Belegposition); amounts exact."),
  voucherDate: z.string().describe("Belegdatum = invoice issue date (BT-2)."),
  number: z.string().describe("Belegnummer = invoice number (BT-1)."),
  deliveryDate: z.string().optional().describe("Leistungsdatum (BT-72 or period start)."),
  deliveryDateUntil: z.string().optional().describe("End of the service period (BT-74)."),
  paymentDeadline: z.string().optional().describe("Due date (BT-9)."),
  currency: z.string(),
  totals: z.object({ net: moneySchema, tax: moneySchema, gross: moneySchema, due: moneySchema }),
  foldVatForZeroRule: z
    .boolean()
    .describe(
      "True when the tax rule allows only 0 % but the invoice shows VAT: the positions keep the " +
        "invoice's VAT rows, and the import books each at 0 % with amount = gross.",
    ),
  foldVatReason: z.string().optional().describe("Why the VAT is folded (only with the flag)."),
  ownInvoiceId: z
    .number()
    .int()
    .optional()
    .describe("Revenue only: the sevDesk invoice with the same number (the import is blocked)."),
  blocking: z
    .array(z.string())
    .describe("Reasons the invoice cannot be imported as is; empty when it can."),
  warnings: z.array(z.string()),
});

export type EInvoiceVoucherSuggestion = z.output<typeof einvoiceVoucherSuggestionSchema>;
type Candidate = EInvoiceVoucherSuggestion["supplierCandidates"][number];

/** What {@link planVoucherFromEInvoice} needs. */
export interface EInvoiceSuggestionContext {
  readonly client: SevdeskClient;
  /** Cache owner of the account settings: tools pass `ctx.config`. */
  readonly cacheOwner: object;
  readonly signal?: AbortSignal | undefined;
}

/** A contact as the matcher sees it. */
interface ContactMatchRow {
  readonly contact: ContactDto;
  /** `vatNumber`, normalized like VAT ids. */
  readonly vatId?: string | undefined;
  /** `bankAccount`, normalized like IBANs. */
  readonly iban?: string | undefined;
}

/** The contacts read for matching. */
export interface ContactIndex {
  readonly rows: readonly ContactMatchRow[];
  readonly scanned: number;
  readonly complete: boolean;
}

/** Inputs of the pure {@link suggestVoucherFields}. */
export interface SuggestionInputs {
  readonly regime: TaxRegime | undefined;
  readonly company: AccountCompany | undefined;
  readonly contacts: ContactIndex;
  /**
   * Revenue only: whether sevDesk already has an invoice with the e-invoice's number
   * (`found` with its id, `none`, or `failed` when the lookup could not run). Absent means not
   * checked, which blocks a revenue import like `failed`.
   */
  readonly ownInvoice?: OwnInvoiceCheck | undefined;
}

/** The result of looking up the e-invoice's number among the account's own invoices. */
export type OwnInvoiceCheck =
  | { readonly status: "found"; readonly invoiceId: number }
  | { readonly status: "none" }
  | { readonly status: "failed" };

/**
 * Reads what the suggestion needs (account settings and company, contacts) and builds it.
 * Reads only; throws what the client throws.
 */
export async function planVoucherFromEInvoice(
  parsed: ParsedEInvoice,
  ctx: EInvoiceSuggestionContext,
): Promise<EInvoiceVoucherSuggestion> {
  const options = { cacheOwner: ctx.cacheOwner, signal: ctx.signal };
  // Sequential on purpose: the second call is served from the cache the first one filled.
  const settings = await loadAccountSettings(ctx.client, options);
  const company = await loadAccountCompany(ctx.client, options);
  const direction = directionOf(parsed, company);
  const counterparty = direction.kind === "expense" ? parsed.seller : parsed.buyer;
  const contacts = await loadContactIndex(ctx.client, counterparty, ctx.signal);
  const ownInvoice =
    direction.kind === "revenue"
      ? await findOwnInvoice(ctx.client, parsed.number, ctx.signal)
      : undefined;
  return suggestVoucherFields(parsed, {
    regime: taxRegimeOf(settings),
    company,
    contacts,
    ownInvoice,
  });
}

/** Most invoices read when looking for the e-invoice's number. */
const OWN_INVOICE_LIMIT = 10;

/**
 * Looks the invoice number (BT-1) up among the account's invoices (`GET /Invoice` with the
 * `invoiceNumber` filter, re-checked exactly by `listInvoices`, D-035). A failed lookup is
 * reported as `failed` (the import is then blocked); a cancellation is rethrown.
 */
export async function findOwnInvoice(
  client: SevdeskClient,
  number: string,
  signal?: AbortSignal,
): Promise<OwnInvoiceCheck> {
  try {
    const page = await listInvoices(
      client,
      { number, limit: OWN_INVOICE_LIMIT, offset: 0 },
      signal,
    );
    const match = page.items[0];
    return match === undefined ? { status: "none" } : { status: "found", invoiceId: match.id };
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return { status: "failed" };
    throw error;
  }
}

/** The suggestion from already loaded inputs (no I/O); see the module doc. */
export function suggestVoucherFields(
  parsed: ParsedEInvoice,
  inputs: SuggestionInputs,
): EInvoiceVoucherSuggestion {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const direction = directionOf(parsed, inputs.company);
  if (direction.basis === "assumed_expense") {
    warnings.push(
      "Neither party matched the account's company (VAT id, tax number or name in the sevDesk " +
        "settings), so the invoice is assumed to be a supplier invoice (expense). Check it.",
    );
  }
  if (direction.ambiguous) {
    warnings.push(
      "Both the seller and the buyer match the account's company; the invoice is treated as an " +
        "expense. Check it.",
    );
  }
  const counterpartyRole = direction.kind === "expense" ? "seller" : "buyer";
  const counterparty = counterpartyRole === "seller" ? parsed.seller : parsed.buyer;
  const counterpartyIban = counterpartyRole === "seller" ? parsed.payment.iban : undefined;

  const regime = inputs.regime ?? "regular";
  if (inputs.regime === undefined) {
    warnings.push(
      "The account's VAT regulation could not be read; the tax rule assumes regular VAT " +
        "(Regelbesteuerung), not Kleinunternehmer.",
    );
  }

  addFindingNotes(parsed, blocking, warnings);
  if (parsed.documentKind === "credit_note") {
    blocking.push(
      "The document is a credit note (Gutschrift, type code " +
        `${safeCode(parsed.typeCode)}). Credit notes are not imported automatically: book it with ` +
        "sevdesk_voucher_create_draft, choosing the direction and accounts by hand.",
    );
  } else if (parsed.documentKind === "other") {
    blocking.push(
      "The type code (BT-3) does not mark an invoice, so the document is not imported " +
        "automatically.",
    );
  }
  if (parsed.currency !== "EUR") {
    blocking.push(
      `The invoice is in ${parsed.currency}. Foreign-currency invoices are not imported ` +
        "automatically: book them with sevdesk_voucher_create_draft and the EUR amounts.",
    );
  }
  const ownInvoiceId =
    inputs.ownInvoice?.status === "found" ? inputs.ownInvoice.invoiceId : undefined;
  if (direction.kind === "revenue" && parsed.documentKind === "invoice") {
    if (ownInvoiceId !== undefined) {
      blocking.push(
        "The e-invoice is your own invoice: sevDesk already has invoice " +
          `${String(ownInvoiceId)} with the same invoice number. Booking it as a revenue voucher ` +
          "would count the revenue twice, so it is not imported.",
      );
    } else if (inputs.ownInvoice?.status !== "none") {
      blocking.push(
        "The account is the seller of this e-invoice (revenue), but it could not be checked " +
          "whether sevDesk already has this invoice (lookup by invoice number). Revenue " +
          "e-invoices are only imported after that check, so it is not imported.",
      );
    }
  }
  if (parsed.totals.prepaid !== undefined && !isZero(parsed.totals.prepaid)) {
    warnings.push(
      `The invoice states ${parsed.totals.prepaid} ${parsed.currency} as already paid (BT-113); ` +
        "book that payment separately.",
    );
  }

  const rule = suggestRule(parsed, direction.kind, regime);
  if (rule.id === undefined) blocking.push(rule.reason);
  for (const note of rule.warnings) warnings.push(note);

  const { positions, fold } = buildPositions(parsed, rule.id, blocking);
  if (fold !== undefined) warnings.push(fold);

  const matches = matchContacts(inputs.contacts.rows, counterparty, counterpartyIban);
  const candidates = matches.map((match) => match.candidate);
  const strong = candidates.filter((candidate) => candidate.matchedBy !== "name");
  const byVat = matches.filter((match) => match.candidate.matchedBy === "vat_id");
  const byIban = matches.filter((match) => match.candidate.matchedBy === "iban");
  const picked =
    byVat.length === 1
      ? byVat[0]
      : byVat.length === 0 && byIban.length === 1
        ? byIban[0]
        : undefined;
  const ibanConflict =
    picked !== undefined &&
    counterpartyIban !== undefined &&
    picked.iban !== undefined &&
    picked.iban !== counterpartyIban;
  const supplierId = picked === undefined || ibanConflict ? undefined : picked.candidate.contactId;
  if (ibanConflict) {
    warnings.push(
      `The invoice's payee IBAN ${maskIban(counterpartyIban) ?? "(unknown)"} differs from the ` +
        `IBAN stored for the matching supplier contact ${String(picked.candidate.contactId)} ` +
        `(${maskIban(picked.iban) ?? "(unknown)"}). Check the bank details with the supplier ` +
        "before paying (possible payment redirection); the contact is not chosen automatically.",
    );
  } else if (candidates.length === 0) {
    warnings.push(
      "No sevDesk contact matches the " +
        (counterpartyRole === "seller" ? "supplier" : "customer") +
        " (VAT id, IBAN or exact name). Create one with sevdesk_contact_create, or book the " +
        "voucher with the name only.",
    );
  } else if (supplierId === undefined && strong.length > 1) {
    warnings.push(
      "Several contacts share the VAT id or IBAN; pick the right one from supplierCandidates.",
    );
  } else if (supplierId === undefined) {
    warnings.push("The contact matched by name only; confirm it before booking.");
  }
  if (!inputs.contacts.complete) {
    warnings.push(
      `Only the first ${String(inputs.contacts.scanned)} contacts were compared; a matching ` +
        "contact may exist beyond them (search with sevdesk_contacts_search).",
    );
  }

  const ruleInfo = rule.id === undefined ? undefined : taxRuleById(rule.id);
  const { currency, totals } = parsed;
  const deliveryDate = parsed.deliveryDate ?? parsed.periodStart;
  return einvoiceVoucherSuggestionSchema.parse({
    kind: direction.kind,
    kindBasis: direction.basis,
    counterparty: compactObject({
      role: counterpartyRole,
      name: counterparty.name,
      vatId: counterparty.vatId,
      ibanMasked: maskIban(counterpartyIban),
    }),
    supplierCandidates: candidates.slice(0, MAX_CANDIDATES),
    ...(supplierId === undefined ? {} : { supplierId }),
    supplierSearch: { scanned: inputs.contacts.scanned, complete: inputs.contacts.complete },
    ...(rule.id === undefined ? {} : { taxRuleId: rule.id }),
    foldVatForZeroRule: fold !== undefined,
    ...(fold === undefined ? {} : { foldVatReason: fold }),
    ...(ownInvoiceId === undefined ? {} : { ownInvoiceId }),
    ...(ruleInfo === undefined ? {} : { taxRuleName: ruleInfo.nameDe }),
    taxRuleReason: rule.reason,
    positions,
    voucherDate: parsed.issueDate,
    number: parsed.number,
    ...(deliveryDate === undefined ? {} : { deliveryDate }),
    ...(parsed.periodEnd === undefined ? {} : { deliveryDateUntil: parsed.periodEnd }),
    ...(parsed.dueDate === undefined ? {} : { paymentDeadline: parsed.dueDate }),
    currency,
    totals: {
      net: money(totals.net, currency),
      tax: money(totals.tax, currency),
      gross: money(totals.gross, currency),
      due: money(totals.due, currency),
    },
    blocking: unique(blocking),
    warnings: unique(warnings),
  });
}

// ---------------------------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------------------------

interface Direction {
  readonly kind: "expense" | "revenue";
  readonly basis: (typeof KIND_BASES)[number];
  readonly ambiguous: boolean;
}

/** Whether the account's company is the buyer (expense) or the seller (revenue). */
export function directionOf(
  parsed: ParsedEInvoice,
  company: AccountCompany | undefined,
): Direction {
  const ownVat = normalizeVatId(company?.vatNumber);
  const ownTax = normalizeTaxNumber(company?.taxNumber);
  const ownName = normalizeName(company?.name);
  const buyerByVat = ownVat !== undefined && normalizeVatId(parsed.buyer.vatId) === ownVat;
  const sellerByVat = ownVat !== undefined && normalizeVatId(parsed.seller.vatId) === ownVat;
  const sellerByTax =
    ownTax !== undefined && normalizeTaxNumber(parsed.seller.taxNumber) === ownTax;
  const buyerByName = ownName !== undefined && partyNames(parsed.buyer).includes(ownName);
  const sellerByName = ownName !== undefined && partyNames(parsed.seller).includes(ownName);

  const buyer = buyerByVat || buyerByName;
  const seller = sellerByVat || sellerByTax || sellerByName;
  if (buyer) {
    return {
      kind: "expense",
      basis: buyerByVat ? "buyer_vat_id" : "buyer_name",
      ambiguous: seller,
    };
  }
  if (seller) {
    return {
      kind: "revenue",
      basis: sellerByVat ? "seller_vat_id" : sellerByTax ? "seller_tax_number" : "seller_name",
      ambiguous: false,
    };
  }
  return { kind: "expense", basis: "assumed_expense", ambiguous: false };
}

// ---------------------------------------------------------------------------------------------
// Tax rule
// ---------------------------------------------------------------------------------------------

interface RuleSuggestion {
  readonly id: number | undefined;
  readonly reason: string;
  readonly warnings: readonly string[];
}

function suggestRule(
  parsed: ParsedEInvoice,
  kind: "expense" | "revenue",
  regime: TaxRegime,
): RuleSuggestion {
  const categories = usedCategories(parsed);
  if (categories.length === 0) {
    return {
      id: undefined,
      reason: "The invoice has no VAT breakdown, so no tax rule can be suggested.",
      warnings: [],
    };
  }
  const choices = categories.map((category) => ({
    category,
    ...ruleFor(category, kind, regime, parsed),
  }));
  const missing = choices.find((choice) => choice.id === undefined);
  if (missing !== undefined) return { id: undefined, reason: missing.reason, warnings: [] };
  const ids = [...new Set(choices.map((choice) => choice.id))];
  if (ids.length > 1) {
    return {
      id: undefined,
      reason:
        `The invoice mixes VAT categories (${categories.join(", ")}) that need different sevDesk ` +
        `tax rules (${ids.join(", ")}), but a voucher has one tax rule. Book it as separate ` +
        "vouchers with sevdesk_voucher_create_draft.",
      warnings: [],
    };
  }
  return {
    id: ids[0],
    reason: unique(choices.map((choice) => choice.reason)).join(" "),
    warnings: unique(choices.flatMap((choice) => choice.warnings)),
  };
}

function ruleFor(
  category: VatCategoryCode,
  kind: "expense" | "revenue",
  regime: TaxRegime,
  parsed: ParsedEInvoice,
): RuleSuggestion {
  const sellerCountry = parsed.seller.address.countryCode;
  const buyerCountry = parsed.buyer.address.countryCode;
  if (kind === "expense") {
    if (regime === "small_business") {
      if (category === "AE") {
        return rule(
          13,
          "Reverse charge on a Kleinunternehmer account: the VAT is owed without input VAT deduction (rule 13, §13b Abs. 5, §19 UStG).",
        );
      }
      return rule(
        10,
        "Kleinunternehmer accounts cannot deduct input VAT (rule 10, §19 UStG).",
        category === "K"
          ? [
              "An intra-EU acquisition can be taxable for a Kleinunternehmer (§1a UStG, Erwerbsschwelle); check it with the tax advisor.",
            ]
          : [],
      );
    }
    switch (category) {
      case "S":
        if (sellerCountry !== undefined && sellerCountry !== "DE") {
          return noRule(FOREIGN_VAT_REASON);
        }
        return rule(9, "Domestic invoice with VAT: input VAT is deductible (rule 9, §15 UStG).");
      case "Z":
      case "E":
      case "O":
        return rule(9, `No VAT on the invoice (category ${category}): booked with rule 9 at 0 %.`);
      case "G":
        return rule(9, "No VAT on the invoice (category G, export): booked with rule 9 at 0 %.", [
          "The invoice is marked as an export (G) although the account is the buyer; check it.",
        ]);
      case "AE":
        if (sellerCountry === undefined || sellerCountry === "DE") {
          return rule(
            12,
            "Domestic reverse charge (§13b Abs. 2 UStG, e.g. construction services): rule 12.",
          );
        }
        if (EU_COUNTRIES.has(sellerCountry)) {
          return rule(
            14,
            "Reverse charge for services from another EU state (§13b Abs. 1 UStG): rule 14.",
          );
        }
        return rule(
          12,
          "Reverse charge for services from outside the EU (§13b Abs. 2 Nr. 1 UStG): rule 12.",
        );
      case "K":
        return rule(
          8,
          "Intra-community acquisition (innergemeinschaftlicher Erwerb, §1a UStG): rule 8.",
          [
            "For an intra-community acquisition sevDesk may expect the German rate (19 % or 7 %) on the position; the invoice states 0 %.",
          ],
        );
      case "L":
      case "M":
        return noRule(FOREIGN_VAT_REASON);
    }
  }
  if (regime === "small_business") {
    return rule(
      11,
      "Kleinunternehmer revenue (rule 11, §19 UStG).",
      parsed.vatBreakdown.some((row) => !isZero(row.taxAmount))
        ? [
            "The invoice shows VAT although the account is a Kleinunternehmer; VAT shown on an invoice is owed (§14c UStG).",
          ]
        : [],
    );
  }
  switch (category) {
    case "S":
    case "Z":
      return rule(1, "Domestic taxable revenue (rule 1).");
    case "E":
      return rule(4, "Tax-exempt revenue (§4 UStG): rule 4.");
    case "AE":
      if (buyerCountry === undefined || buyerCountry === "DE") {
        return rule(5, "Domestic reverse charge revenue (§13b UStG): rule 5.");
      }
      if (EU_COUNTRIES.has(buyerCountry)) {
        return {
          id: undefined,
          reason:
            "Reverse charge revenue from a buyer in another EU state needs tax rule 21, which " +
            "sevDesk does not allow on vouchers; write it as an invoice in sevDesk instead.",
          warnings: [],
        };
      }
      return rule(17, "Service to a buyer outside the EU, not taxable in Germany: rule 17.");
    case "K":
      return rule(3, "Intra-community supply (innergemeinschaftliche Lieferung): rule 3.");
    case "G":
      return rule(2, "Export outside the EU (Ausfuhr): rule 2.");
    case "O":
    case "L":
    case "M":
      return {
        id: undefined,
        reason:
          `Revenue of VAT category ${category} needs a case-by-case rule (17 not taxable in ` +
          "Germany, or 22 not taxable); book it with sevdesk_voucher_create_draft.",
        warnings: [],
      };
  }
}

/**
 * VAT a foreign seller charged (or Canary / Ceuta tax) is not German input VAT. sevDesk's rule for
 * non-deductible expenses (10) is not offered on regular-VAT accounts: the ReceiptGuidance
 * recorded on 2026-11-07 (regular VAT, 652 accounts) allows it for no account.
 */
const FOREIGN_VAT_REASON =
  "The invoice carries foreign VAT, which is not deductible in the German VAT return (refund " +
  "only through the Vorsteuervergütungsverfahren), and sevDesk offers no tax rule for " +
  "non-deductible expenses on a regular-VAT account. Book it with sevdesk_voucher_create_draft: " +
  "tax rule 9 at 0 % with the gross amount.";

function noRule(reason: string): RuleSuggestion {
  return { id: undefined, reason, warnings: [] };
}

function rule(id: number, reason: string, warnings: readonly string[] = []): RuleSuggestion {
  return { id, reason, warnings };
}

function usedCategories(parsed: ParsedEInvoice): VatCategoryCode[] {
  const used = new Set<VatCategoryCode>(parsed.vatBreakdown.map((row) => row.category));
  return VAT_CATEGORY_CODES.filter((category) => used.has(category));
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/**
 * One position per VAT breakdown row, as on the invoice. When the rule allows only 0 % but the
 * invoice shows VAT, the rows stay as they are and `fold` carries the reason: the import books
 * each position at 0 % with amount = gross (folding happens in one place, the importer).
 */
function buildPositions(
  parsed: ParsedEInvoice,
  ruleId: number | undefined,
  blocking: string[],
): { positions: EInvoiceVoucherSuggestion["positions"]; fold: string | undefined } {
  const allowed = ruleId === undefined ? undefined : taxRuleById(ruleId)?.allowedTaxRates;
  const zeroOnly = allowed !== undefined && allowed.length === 1 && allowed[0] === 0;
  const { currency } = parsed;
  const fold =
    zeroOnly && parsed.vatBreakdown.some((row) => !isZero(row.taxAmount))
      ? `Tax rule ${String(ruleId)} allows only 0 %, so the VAT on the invoice is not deductible ` +
        "and is booked as part of the expense: each position at 0 % with amount = gross."
      : undefined;
  const positions = parsed.vatBreakdown.map((row) => {
    const rate = row.rate ?? "0";
    if (
      fold === undefined &&
      allowed !== undefined &&
      !allowed.some((value) => compare(rate, value) === 0)
    ) {
      blocking.push(
        `The VAT rate ${rate} % is not allowed with tax rule ${String(ruleId)} in sevDesk ` +
          `(allowed: ${allowed.join(", ")} %).`,
      );
    }
    return position(
      row.category,
      rate,
      money(row.taxableAmount, currency),
      money(row.taxAmount, currency),
      money(add(row.taxableAmount, row.taxAmount), currency),
    );
  });
  if (positions.length === 0) {
    blocking.push(
      "The invoice has no VAT breakdown (BG-23), so no voucher positions can be built.",
    );
  }
  return { positions, fold };
}

function position(
  vatCategory: VatCategoryCode,
  taxRate: string,
  net: Money,
  tax: Money,
  gross: Money,
): EInvoiceVoucherSuggestion["positions"][number] {
  return { vatCategory, taxRate, net, tax, gross };
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

function addFindingNotes(parsed: ParsedEInvoice, blocking: string[], warnings: string[]): void {
  const errors = parsed.findings.filter((finding) => finding.severity === "error");
  const amountErrors = errors.filter((finding) => BLOCKING_FINDING.test(finding.code));
  const formal = errors.filter((finding) => !BLOCKING_FINDING.test(finding.code));
  if (amountErrors.length > 0) {
    blocking.push(
      `The e-invoice has ${String(amountErrors.length)} error(s) in its amounts, VAT breakdown ` +
        `or profile (${unique(amountErrors.map((finding) => finding.code)).join(", ")}); see ` +
        "findings. Ask the sender for a corrected invoice.",
    );
  }
  if (formal.length > 0) {
    warnings.push(
      `The e-invoice has ${String(formal.length)} formal defect(s) ` +
        `(${unique(formal.map((finding) => finding.code)).join(", ")}); see findings. The amounts ` +
        "are consistent, but the input VAT deduction (§15 UStG) needs a correct invoice.",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

const contactBankSchema = z.object({
  vatNumber: zText.catch(undefined),
  bankAccount: zText.catch(undefined),
});

/**
 * Reads contacts for matching: up to {@link MAX_SCANNED_CONTACTS} (`GET /Contact?depth=1`), plus
 * a `name` search for the counterparty when the scan was cut off.
 */
export async function loadContactIndex(
  client: SevdeskClient,
  counterparty: EInvoiceParty,
  signal?: AbortSignal,
): Promise<ContactIndex> {
  const scan = await client.listAll(
    "/Contact",
    { depth: "1" },
    {
      max: MAX_SCANNED_CONTACTS,
      pageSize: CONTACT_PAGE_SIZE,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const rows = scan.items.map(toMatchRow);
  if (scan.truncated && counterparty.name !== "") {
    const page = await client.list(
      "/Contact",
      { depth: "1", name: counterparty.name },
      { limit: NAME_SEARCH_LIMIT, offset: 0, ...(signal === undefined ? {} : { signal }) },
    );
    const known = new Set(rows.map((row) => row.contact.id));
    for (const raw of page.items) {
      const row = toMatchRow(raw);
      if (!known.has(row.contact.id)) rows.push(row);
    }
  }
  return { rows, scanned: rows.length, complete: !scan.truncated };
}

function toMatchRow(raw: unknown): ContactMatchRow {
  const contact = toContactDto(parseContactRecord(raw));
  const extra = parseUpstream(contactBankSchema, raw, "a contact");
  return {
    contact,
    vatId: normalizeVatId(extra.vatNumber),
    iban: normalizeIban(extra.bankAccount),
  };
}

interface ContactMatch {
  readonly candidate: Candidate;
  /** The contact's stored IBAN (normalized), for the payee check; never shown unmasked. */
  readonly iban: string | undefined;
}

function matchContacts(
  rows: readonly ContactMatchRow[],
  counterparty: EInvoiceParty,
  iban: string | undefined,
): ContactMatch[] {
  const vatId = normalizeVatId(counterparty.vatId);
  const names = partyNames(counterparty);
  const order: Readonly<Record<MatchKind, number>> = { vat_id: 0, iban: 1, name: 2 };
  const matches: ContactMatch[] = [];
  for (const row of rows) {
    let matchedBy: MatchKind | undefined;
    if (vatId !== undefined && row.vatId === vatId) matchedBy = "vat_id";
    else if (iban !== undefined && row.iban === iban) matchedBy = "iban";
    else {
      const name = normalizeName(row.contact.displayName);
      if (name !== undefined && names.includes(name)) matchedBy = "name";
    }
    if (matchedBy === undefined) continue;
    matches.push({
      candidate: compactObject({
        contactId: row.contact.id,
        displayName: row.contact.displayName,
        customerNumber: row.contact.customerNumber,
        vatNumber: row.contact.vatNumber,
        matchedBy,
      }),
      iban: row.iban,
    });
  }
  return matches.sort(
    (a, b) =>
      order[a.candidate.matchedBy] - order[b.candidate.matchedBy] ||
      a.candidate.contactId - b.candidate.contactId,
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Lower case, punctuation removed, whitespace collapsed; `undefined` when empty. */
export function normalizeName(name: string | undefined): string | undefined {
  const normalized = name
    ?.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function normalizeTaxNumber(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D+/g, "");
  return digits === undefined || digits === "" ? undefined : digits;
}

function partyNames(party: EInvoiceParty): string[] {
  return [normalizeName(party.name), normalizeName(party.tradingName)].filter(
    (name): name is string => name !== undefined,
  );
}

function safeCode(code: string): string {
  return /^\d{1,4}$/.test(code) ? code : "unknown";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}
