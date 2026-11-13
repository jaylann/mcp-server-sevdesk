/**
 * E-invoice preflight for an outgoing invoice: checks whether sevDesk has everything an
 * XRechnung / ZUGFeRD needs before the invoice is finalized and sent, and, for an invoice that is
 * already finalized, parses the XML sevDesk generated and runs the EN 16931 checks on it.
 *
 * Reads only: `GET /Invoice/{id}`, `GET /InvoicePos`, `GET /Contact/{id}` with its addresses and
 * communication ways, `GET /Unity`, the cached `GET /SevClient`, and for finalized invoices
 * `GET /Invoice/{id}/getXml` (no side effects; `document-files.ts`).
 *
 * What is required comes from three sources, each check names its rule:
 * - sevDesk's own list for e-invoices (spec, `Model_Invoice.propertyIsEInvoice`): company
 *   street, zip, city, IBAN, BIC, e-mail, phone, tax number (VAT id optional for small
 *   businesses); contact buyer reference and e-mail; invoice payment method, street, zip, city,
 *   country and contact;
 * - EN 16931 / XRechnung 3.0: seller and buyer name and address (BR-06–BR-11, BR-DE-3/4/8/9),
 *   seller contact (BR-DE-2/6/7), buyer reference (BR-DE-15, a Leitweg-ID for public buyers, whose
 *   check digits are verified with ISO 7064 MOD 97-10 as the KoSIT Leitweg-ID format
 *   specification describes), unit codes (BT-130, UN/ECE Rec 20/21), VAT ids for reverse charge
 *   and intra-EU supplies (BR-AE-02, BR-K-02), payment account for credit transfer (BR-DE-23);
 * - German VAT law (§14 Abs. 4 UStG): date of supply (Leistungsdatum), the §19 UStG note on a
 *   Kleinunternehmer invoice.
 * Tax rules 18–20 (One-Stop-Shop) are not supported for e-invoices (`reference-data.ts`).
 *
 * Every message is trusted text; values from sevDesk never appear in it. Each issue names the
 * field and the tool that fixes it.
 */
import { z } from "zod";

import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import { parseUpstream } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  type AccountCompany,
  loadAccountCompany,
  loadAccountSettings,
  taxRegimeOf,
} from "../account-settings.js";
import { statusDtoSchema } from "../common.js";
import { type ContactDetails, getContactDetails } from "../contacts.js";
import { fetchDocumentFile } from "../document-files.js";
import {
  listDocumentPositions,
  salesDocumentFields,
  zOptionalBool,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "../document-positions.js";
import { mapInvoiceDetail } from "../invoices.js";
import { listUnits, taxRuleById } from "../reference-data.js";
import { EINVOICE_PROFILES, EINVOICE_SYNTAXES, type ParsedEInvoice } from "./model.js";
import { parseEInvoice } from "./parse.js";

/** One issue: a trusted message, the field concerned and how to fix it. */
const preflightIssueSchema = z.object({
  code: z.string().describe("PF-… (ours) or the EN 16931 / XRechnung rule id from the XML."),
  message: z.string(),
  field: z.string().optional().describe("Where the data lives, e.g. contact.buyerReference."),
  fixWith: z.string().optional().describe("Tool or place that fixes it."),
});
type PreflightIssue = z.output<typeof preflightIssueSchema>;

/** The preflight result (also the tool's output). */
export const preflightResultSchema = z.object({
  invoice: z.object({
    id: z.number().int(),
    number: z.string().optional().describe("Rechnungsnummer (drafts have none yet)."),
    status: statusDtoSchema,
    type: z.string().describe("sevDesk invoice type: RE, AR, TR, ER, SR, MA, WKR."),
    contactId: z.number().int().optional(),
    eInvoice: z
      .boolean()
      .optional()
      .describe("propertyIsEInvoice when sevDesk sends it (reads usually do not)."),
  }),
  ready: z.boolean().describe("True when no problem was found."),
  problems: z.array(preflightIssueSchema).describe("Must be fixed before sending an e-invoice."),
  warnings: z.array(preflightIssueSchema).describe("Should be checked; not blocking."),
  xml: z
    .object({
      status: z
        .enum(["checked", "not_available", "not_finalized"])
        .describe(
          "checked: sevDesk's XML was parsed; not_available: sevDesk has none; not_finalized: " +
            "drafts get their XML when finalized.",
        ),
      syntax: z.enum(EINVOICE_SYNTAXES).optional(),
      profile: z.enum(EINVOICE_PROFILES).optional(),
      errors: z.number().int().optional(),
      warnings: z.number().int().optional(),
    })
    .describe("The e-invoice XML sevDesk generated (finalized invoices only)."),
});
export type PreflightResult = z.output<typeof preflightResultSchema>;

/** Options of {@link preflightInvoice}. */
export interface PreflightOptions {
  /** Cache owner of the account settings: tools pass `ctx.config`. */
  readonly cacheOwner: object;
  readonly signal?: AbortSignal | undefined;
  /** Berlin `YYYY-MM-DD` for the invoice DTO (tests); defaults to today. */
  readonly today?: string;
}

/** Invoice status codes: draft 100; open 200, partially paid 750, paid 1000 have XML. */
const DRAFT_STATUS = 100;

/** The invoice fields the checks read (lenient, like every upstream schema). */
const invoiceFieldsSchema = z.object({
  ...salesDocumentFields,
  invoiceType: zText,
  timeToPay: zOptionalInt,
  paymentMethod: zOptionalRef,
  propertyIsEInvoice: zOptionalBool,
});

/** Tax rules that need the buyer's VAT id: intra-EU supply, §13b and EU reverse charge. */
const BUYER_VAT_ID_RULES: ReadonlySet<number> = new Set([3, 5, 21]);
/** Leitweg-ID: Grobadressierung (2–12 digits), optional Feinadressierung, two check digits. */
const LEITWEG_ID = /^(\d{2,12})(?:-([0-9A-Za-z]{1,30}))?-(\d{2})$/;
const SMALL_BUSINESS_NOTE = /§\s*19|19\s*UStG|Kleinunternehmer/i;

/**
 * Runs the preflight for invoice `invoiceId`. A missing invoice is the client's `not_found`
 * error; everything else that is missing becomes a problem or a warning.
 */
export async function preflightInvoice(
  client: SevdeskClient,
  invoiceId: number,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const id = toSevdeskId(invoiceId);
  const { signal } = options;
  const withSignal = signal === undefined ? {} : { signal };
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Invoice", id),
    query: { embed: "contact" },
    ...withSignal,
  });
  const raw = expectSingle(payload, `invoice ${id}`);
  const invoice = parseUpstream(invoiceFieldsSchema, raw, "an invoice");
  const detail = mapInvoiceDetail(raw, options.today ?? berlinDateOf(Date.now()));

  const settingsOptions = { cacheOwner: options.cacheOwner, signal };
  const settings = await loadAccountSettings(client, settingsOptions);
  const company = await loadAccountCompany(client, settingsOptions);
  const [positions, units, contact] = await Promise.all([
    listDocumentPositions(
      client,
      {
        path: "/InvoicePos",
        parentKey: "invoice",
        objectName: "Invoice",
        what: "invoice positions",
      },
      id,
      signal,
    ),
    readUnitCodes(client, signal),
    detail.contact === undefined
      ? undefined
      : readContact(client, detail.contact.id, signal, options.cacheOwner),
  ]);

  const problems: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const isDraft = invoice.status === DRAFT_STATUS;
  const invoiceFix = isDraft
    ? "sevdesk_invoice_update_draft"
    : "sevdesk_invoice_reset (to draft), then sevdesk_invoice_update_draft";

  checkSeller(company, problems, warnings);
  checkBuyer({
    invoice,
    contact,
    contactName: detail.contact?.name,
    invoiceFix,
    problems,
    warnings,
  });

  // Invoice data.
  if (invoice.propertyIsEInvoice === false) {
    problems.push({
      code: "PF-NOT-EINVOICE",
      message:
        "sevDesk says this invoice is not an e-invoice (propertyIsEInvoice false): sevDesk " +
        "creates XRechnung/ZUGFeRD only for invoices created as e-invoices. Create a new " +
        "invoice as an e-invoice (E-Rechnung) in the sevDesk web app.",
      field: "invoice.propertyIsEInvoice",
      fixWith: "sevDesk web app",
    });
  }
  if (invoice.paymentMethod === undefined) {
    problems.push({
      code: "PF-PAYMENT-METHOD",
      message:
        "The invoice has no payment method (Zahlungsart); sevDesk requires one for e-invoices.",
      field: "invoice.paymentMethod",
      fixWith: "sevDesk web app (invoice: Zahlungsart)",
    });
  }
  if (detail.deliveryDate === undefined) {
    problems.push({
      code: "PF-DELIVERY-DATE",
      message:
        "The invoice has no delivery date (Leistungsdatum); §14 Abs. 4 UStG requires the date or " +
        "period of supply.",
      field: "invoice.deliveryDate",
      fixWith: invoiceFix,
    });
  }
  if (invoice.timeToPay === undefined) {
    warnings.push({
      code: "BR-CO-25",
      message:
        "The invoice has no payment term (Zahlungsziel); an e-invoice with an amount due needs a " +
        "due date or payment terms.",
      field: "invoice.timeToPay",
      fixWith: invoiceFix,
    });
  }
  if (detail.currency !== "EUR") {
    warnings.push({
      code: "PF-CURRENCY",
      message: `The invoice is in ${detail.currency}; check that the recipient accepts e-invoices in that currency.`,
      field: "invoice.currency",
    });
  }
  checkTaxRule({ invoice, regime: taxRegimeOf(settings), contact, invoiceFix, problems, warnings });

  // Positions and units.
  if (positions.rows.length === 0) {
    problems.push({
      code: "BR-16",
      message: "The invoice has no positions; an e-invoice needs at least one line.",
      field: "invoice.positions",
      fixWith: invoiceFix,
    });
  }
  if (!positions.complete) {
    warnings.push({
      code: "PF-POSITIONS-PARTIAL",
      message: "sevDesk had more positions than could be read; only the first ones were checked.",
    });
  }
  if (units === undefined) {
    warnings.push({
      code: "PF-UNITS-UNKNOWN",
      message: "The units (GET /Unity) could not be read, so unit codes were not checked.",
    });
  } else {
    const withoutCode = positions.rows.filter(
      (row) => row.unity === undefined || units.get(row.unity.id) === undefined,
    );
    if (withoutCode.length > 0) {
      problems.push({
        code: "PF-UNIT-CODE",
        message:
          `${String(withoutCode.length)} position(s) use a unit without a UN/ECE code (BT-130 ` +
          "needs one). Choose units that have one (sevdesk_reference_lookup kind=units).",
        field: "positions.unitId",
        fixWith: invoiceFix,
      });
    }
  }

  // The XML sevDesk generated.
  let xml: PreflightResult["xml"] = { status: "not_finalized" };
  if (!isDraft) {
    const parsed = await readGeneratedXml(client, id, signal);
    if (parsed === undefined) {
      xml = { status: "not_available" };
      if (invoice.propertyIsEInvoice !== false) {
        problems.push({
          code: "PF-NO-XML",
          message:
            "sevDesk has no e-invoice XML for this finalized invoice: it was not created as an " +
            "e-invoice or its e-invoice data was incomplete. Create the invoice as an e-invoice " +
            "(E-Rechnung) in the sevDesk web app.",
          fixWith: "sevDesk web app",
        });
      }
    } else if (parsed instanceof SevdeskError) {
      xml = { status: "checked", errors: 1, warnings: 0 };
      problems.push({
        code: "PF-XML-UNREADABLE",
        message: `The e-invoice XML sevDesk generated cannot be read: ${parsed.message}`,
      });
    } else {
      const errors = parsed.findings.filter((finding) => finding.severity === "error");
      const notes = parsed.findings.filter((finding) => finding.severity === "warning");
      xml = {
        status: "checked",
        syntax: parsed.syntax,
        profile: parsed.profile,
        errors: errors.length,
        warnings: notes.length,
      };
      for (const finding of errors) {
        problems.push({ code: finding.code, message: `XML: ${finding.message}` });
      }
      for (const finding of notes) {
        warnings.push({ code: finding.code, message: `XML: ${finding.message}` });
      }
    }
  }

  return preflightResultSchema.parse({
    invoice: {
      id: detail.id,
      ...(detail.number === undefined ? {} : { number: detail.number }),
      status: detail.status,
      type: detail.type.code,
      ...(detail.contact === undefined ? {} : { contactId: detail.contact.id }),
      ...(invoice.propertyIsEInvoice === undefined ? {} : { eInvoice: invoice.propertyIsEInvoice }),
    },
    ready: problems.length === 0,
    problems: dedupe(problems),
    warnings: dedupe(warnings),
    xml,
  });
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const SETTINGS_FIX = "sevDesk web app (Einstellungen > Unternehmen / Zahlungsdaten)";

function checkSeller(
  company: AccountCompany | undefined,
  problems: PreflightIssue[],
  warnings: PreflightIssue[],
): void {
  if (company === undefined) {
    warnings.push({
      code: "PF-SELLER-UNKNOWN",
      message:
        "The account settings (GET /SevClient) could not be read, so the seller data (your " +
        "company) was not checked.",
    });
    return;
  }
  const missing = (
    value: string | number | undefined,
    code: string,
    field: string,
    message: string,
  ): void => {
    if (value === undefined) problems.push({ code, message, field, fixWith: SETTINGS_FIX });
  };
  missing(company.name, "BR-06", "settings.name", "Your company name (seller name) is not set.");
  if (company.street === undefined || company.zip === undefined || company.city === undefined) {
    problems.push({
      code: "BR-DE-3",
      message: "Your company address (street, post code, city) is incomplete in the settings.",
      field: "settings.addressStreet/addressZip/addressCity",
      fixWith: SETTINGS_FIX,
    });
  }
  missing(
    company.countryId,
    "BR-09",
    "settings.addressCountry",
    "Your company country is not set.",
  );
  if (company.vatNumber === undefined && company.taxNumber === undefined) {
    problems.push({
      code: "BR-CO-26",
      message:
        "Neither a VAT id (USt-IdNr.) nor a tax number (Steuernummer) is set for your company; " +
        "an invoice needs one (§14 Abs. 4 Nr. 2 UStG).",
      field: "settings.vatNumber/taxNumber",
      fixWith: SETTINGS_FIX,
    });
  } else if (company.taxNumber === undefined) {
    warnings.push({
      code: "PF-SELLER-TAX-NUMBER",
      message:
        "sevDesk lists the tax number (Steuernummer) as required for e-invoices; it is not set.",
      field: "settings.taxNumber",
      fixWith: SETTINGS_FIX,
    });
  }
  missing(
    company.iban,
    "BR-DE-23-a",
    "settings.bankIban",
    "Your bank account (IBAN) is not set; an e-invoice paid by transfer needs the payee account.",
  );
  missing(
    company.bic,
    "PF-SELLER-BIC",
    "settings.bankBic",
    "Your bank's BIC is not set; sevDesk requires it for e-invoices.",
  );
  missing(
    company.email,
    "BR-DE-7",
    "settings.contactEmail",
    "Your company e-mail is not set; XRechnung needs a seller contact e-mail.",
  );
  missing(
    company.phone,
    "BR-DE-6",
    "settings.contactPhone",
    "Your company phone number is not set; XRechnung needs a seller contact phone.",
  );
}

interface InvoiceFields {
  readonly addressName?: string | undefined;
  readonly addressStreet?: string | undefined;
  readonly addressZip?: string | undefined;
  readonly addressCity?: string | undefined;
  readonly addressCountry?: { readonly id: number } | undefined;
  readonly taxRule?: { readonly id: number } | undefined;
  readonly smallSettlement?: boolean | undefined;
  readonly taxText?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

function checkBuyer(input: {
  readonly invoice: InvoiceFields;
  readonly contact: ContactDetails | SevdeskError | undefined;
  readonly contactName: string | undefined;
  readonly invoiceFix: string;
  readonly problems: PreflightIssue[];
  readonly warnings: PreflightIssue[];
}): void {
  const { invoice, contact, invoiceFix, problems, warnings } = input;
  if (contact === undefined) {
    problems.push({
      code: "PF-BUYER-CONTACT",
      message: "The invoice has no contact (Kunde); an e-invoice needs one.",
      field: "invoice.contact",
      fixWith: invoiceFix,
    });
  } else if (contact instanceof SevdeskError) {
    warnings.push({
      code: "PF-BUYER-UNREADABLE",
      message: "The invoice's contact could not be read, so its e-invoice data was not checked.",
      field: "invoice.contact",
    });
  }
  if (blank(invoice.addressName) && blank(input.contactName)) {
    problems.push({
      code: "BR-07",
      message: "The recipient name (buyer name) is missing on the invoice.",
      field: "invoice.addressName",
      fixWith: invoiceFix,
    });
  }
  if (blank(invoice.addressStreet) || blank(invoice.addressZip) || blank(invoice.addressCity)) {
    problems.push({
      code: "BR-DE-8",
      message:
        "The recipient address on the invoice is incomplete (street, post code and city are " +
        "required as separate fields for e-invoices).",
      field: "invoice.addressStreet/addressZip/addressCity",
      fixWith: invoiceFix,
    });
  }
  if (invoice.addressCountry === undefined) {
    problems.push({
      code: "BR-11",
      message: "The recipient country is missing on the invoice.",
      field: "invoice.addressCountry",
      fixWith: invoiceFix,
    });
  }
  if (contact === undefined || contact instanceof SevdeskError) return;

  const { buyerReference, governmentAgency } = contact.contact;
  if (buyerReference === undefined) {
    problems.push({
      code: "BR-DE-15",
      message:
        "The contact has no buyer reference (Leitweg-ID for public authorities, otherwise the " +
        "reference the customer gave); sevDesk requires it for e-invoices.",
      field: "contact.buyerReference",
      fixWith: "sevdesk_contact_update (buyerReference)",
    });
  } else if (governmentAgency === true && !isValidLeitwegId(buyerReference)) {
    problems.push({
      code: "PF-LEITWEG-ID",
      message:
        "The contact is a public authority, but its buyer reference is not a valid Leitweg-ID " +
        "(format 2–12 digits, optional sub-address, two check digits, e.g. 04011000-12345-03).",
      field: "contact.buyerReference",
      fixWith: "sevdesk_contact_update (buyerReference)",
    });
  }
  const hasEmail = contact.communicationWays.some((way) => way.type.toUpperCase() === "EMAIL");
  if (!hasEmail) {
    problems.push({
      code: "PF-BUYER-EMAIL",
      message: "The contact has no e-mail address; sevDesk requires one for e-invoices.",
      field: "contact.email",
      fixWith: "sevdesk_contact_update (email)",
    });
  }
  if (!contact.communicationWaysComplete) {
    warnings.push({
      code: "PF-BUYER-PARTIAL",
      message: "Not all communication ways of the contact could be read.",
    });
  }
}

function checkTaxRule(input: {
  readonly invoice: InvoiceFields;
  readonly regime: "regular" | "small_business" | undefined;
  readonly contact: ContactDetails | SevdeskError | undefined;
  readonly invoiceFix: string;
  readonly problems: PreflightIssue[];
  readonly warnings: PreflightIssue[];
}): void {
  const { invoice, contact, invoiceFix, problems, warnings } = input;
  const ruleId = invoice.taxRule?.id;
  if (ruleId === undefined) {
    warnings.push({
      code: "PF-TAX-RULE",
      message: "The invoice has no tax rule (Update 1.0 document?); it was not checked.",
      field: "invoice.taxRule",
    });
  } else {
    const rule = taxRuleById(ruleId);
    if (rule?.notSupportedFor?.includes("e-invoices") === true) {
      problems.push({
        code: "PF-TAX-RULE-OSS",
        message: `Tax rule ${String(ruleId)} (One-Stop-Shop) is not supported for e-invoices in sevDesk.`,
        field: "invoice.taxRule",
        fixWith: invoiceFix,
      });
    }
    if (
      BUYER_VAT_ID_RULES.has(ruleId) &&
      contact !== undefined &&
      !(contact instanceof SevdeskError) &&
      contact.contact.vatNumber === undefined
    ) {
      problems.push({
        code: ruleId === 3 ? "BR-K-02" : "BR-AE-02",
        message: `Tax rule ${String(ruleId)} needs the buyer's VAT id (USt-IdNr.) on the contact.`,
        field: "contact.vatNumber",
        fixWith: "sevdesk_contact_update (vatNumber)",
      });
    }
  }
  const smallBusiness =
    ruleId === 11 || invoice.smallSettlement === true || input.regime === "small_business";
  if (smallBusiness) {
    const texts = [invoice.taxText, invoice.headText, invoice.footText].join(" ");
    if (!SMALL_BUSINESS_NOTE.test(texts)) {
      warnings.push({
        code: "BR-E-10",
        message:
          "Kleinunternehmer invoice without a §19 UStG note in the tax text, head or foot text; " +
          "the e-invoice needs the exemption reason.",
        field: "invoice.footText",
        fixWith: invoiceFix,
      });
    }
  }
}

/** Leitweg-ID format and check digits (ISO/IEC 7064 MOD 97-10, KoSIT format specification). */
export function isValidLeitwegId(value: string): boolean {
  const match = LEITWEG_ID.exec(value.trim());
  if (match === null) return false;
  const body = `${match[1] ?? ""}${match[2] ?? ""}`.toUpperCase();
  const digits = body.replace(/[A-Z]/g, (char) => String(char.charCodeAt(0) - 55));
  let remainder = 0;
  for (const char of `${digits}00`) remainder = (remainder * 10 + Number(char)) % 97;
  return 98 - remainder === Number(match[3]);
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Unit id → UN/ECE code (only units that have one); `undefined` when units cannot be read. */
async function readUnitCodes(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<number, string> | undefined> {
  try {
    const units = await listUnits(client, signal);
    const codes = new Map<number, string>();
    for (const unit of units.items) {
      const code = unit.uneceCode?.trim();
      if (code !== undefined && code !== "") codes.set(unit.id, code);
    }
    return codes;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return undefined;
    throw error;
  }
}

/** The contact, or the error that kept it from being read (not fatal for the preflight). */
async function readContact(
  client: SevdeskClient,
  contactId: number,
  signal: AbortSignal | undefined,
  cacheOwner: object = client,
): Promise<ContactDetails | SevdeskError> {
  try {
    return await getContactDetails(client, contactId, signal, cacheOwner);
  } catch (error) {
    if (
      error instanceof SevdeskError &&
      (error.kind === "not_found" || error.kind === "unexpected_response")
    ) {
      return error;
    }
    throw error;
  }
}

/**
 * The parsed XML sevDesk generated; `undefined` when sevDesk has none (`not_found`, D-033), the
 * parser's refusal when it cannot be read.
 */
async function readGeneratedXml(
  client: SevdeskClient,
  invoiceId: number,
  signal: AbortSignal | undefined,
): Promise<ParsedEInvoice | SevdeskError | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = (await fetchDocumentFile(client, "invoice_xml", invoiceId, signal)).bytes;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") return undefined;
    throw error;
  }
  try {
    return await parseEInvoice(bytes);
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function dedupe(issues: readonly PreflightIssue[]): PreflightIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
