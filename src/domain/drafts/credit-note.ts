/**
 * Credit note drafts (Gutschriften, status 100) through `POST /CreditNote/Factory/saveCreditNote`.
 *
 * Body: the request shape of jernoxit/sevdesk-rs (rebuilt from its source; it stores only the
 * response, recorded on Update 2.0 on 2026-10-01, which shows the request was accepted):
 * `creditNoteType: "CN"`, `bookingCategory`, `deliveryDate` (required: sevDesk answers 422
 * "Must set deliveryDate" without it, recorded by sevDesk.NET), `discount: 0`, `taxRate: 0`,
 * `creditNotePosDelete: null`, and none of `invoiceType`, `discountSave`, `discountDelete`,
 * `takeDefaultAddress`, `forCashRegister`, which the spec lists but that accepted request did not
 * send. Like sevdesk-rs (GU-1048 in that run) it sends a `creditNoteNumber` from the number
 * range: without one the draft is accepted, but `sendBy` then answers HTTP 500 (PHP TypeError,
 * `fileName` null; recorded 2026-11-07) and may finalize the credit note without a number anyway.
 * `prepare` peeks the next number for the preview; `execute` reserves it and skips numbers that
 * existing credit notes carry already (`numbering.ts`). The number is never invented (B4).
 *
 * Booking category (spec tag `CreditNote` → "Credit note booking categories"; measured by
 * sevdesk-rs in `credit_note.rs`, 2026-09-29):
 * - `UNDERACHIEVEMENT` (Minderleistung) needs `refSrcInvoice`, the invoice must not be a draft
 *   (422/251), and every position must carry one of the invoice's tax rates (else 456 "Different
 *   taxRate than origin document");
 * - `PROVISION` takes tax rule 9 (rule 1 → "Invalid tax rule");
 * - `ROYALTY_ASSIGNED` / `ROYALTY_UNASSIGNED`: requirements unrecorded; sales rules are allowed
 *   and the preview says so;
 * - `ACCOUNTING_TYPE` is not supported on Update 2.0 and not offered.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { type CreditNoteDetails, getCreditNote } from "../credit-notes.js";
import { checkInvoiceCreditable, findCreditNotesForInvoice } from "../derived-documents.js";
import { getInvoice, type InvoiceDetails } from "../invoices.js";
import { compare, toDecimalString } from "../money.js";
import { taxRuleById } from "../reference-data.js";
import { draftPreview, positionCount, ref, structuredAddress, taxText } from "./document.js";
import { duplicateWarning, findDuplicates } from "./duplicates.js";
import {
  contactIdInput,
  contactPersonIdInput,
  currencyInput,
  deliveryDateInput,
  deliveryDateUntilInput,
  documentDateInput,
  footTextInput,
  formatPeriod,
  headerInput,
  headTextInput,
  priceModeInput,
  resolveDeliveryPeriod,
  taxRuleInput,
  taxTextInput,
  todayInBerlin,
  wireDocumentDate,
  wireTimestamp,
} from "./fields.js";
import {
  changedNumberNote,
  CREDIT_NOTE_SCAN_MAX,
  numberList,
  peekNextNumber,
  quotableNumber,
  reservationWarning,
  reservedNumberError,
  reserveFreeCreditNoteNumber,
  storedNumberNote,
} from "./numbering.js";
import {
  CREDIT_NOTE_BOOKING_CATEGORIES,
  type SaveCreditNoteBody,
  saveCreditNoteBodySchema,
  savedDocumentId,
  strictBody,
} from "./payloads.js";
import {
  type Amounts,
  draftPositionInput,
  MAX_POSITIONS,
  type PositionInput,
  positionPayload,
} from "./positions.js";
import {
  addressText,
  customerText,
  type DraftPreview,
  fact,
  moneyText,
  positionFacts,
  type PreviewFact,
  totalsText,
} from "./preview.js";
import { readBack, readBackNotes } from "./read-back.js";
import { addressInputShape } from "./recipient.js";
import {
  type CreateArgs,
  type DraftCallOptions,
  resolveCreateBasics,
  type TaxOptions,
} from "./shared.js";
import {
  DEFAULT_TAX_RULE_ID,
  type RegimeMessage,
  regimeReason,
  SALES_TAX_RULE_IDS,
} from "./tax.js";

/** Readable booking categories → sevDesk's `bookingCategory`. */
const BOOKING_CATEGORY_NAMES = {
  underachievement: "UNDERACHIEVEMENT",
  provision: "PROVISION",
  royalty_assigned: "ROYALTY_ASSIGNED",
  royalty_unassigned: "ROYALTY_UNASSIGNED",
} as const satisfies Record<string, (typeof CREDIT_NOTE_BOOKING_CATEGORIES)[number]>;
export type BookingCategoryName = keyof typeof BOOKING_CATEGORY_NAMES;

/** Tax rule of provision credit notes (Vorsteuerabziehbare Aufwendungen; measured, see above). */
const PROVISION_TAX_RULE_ID = 9;
/**
 * Tax rules of provision credit notes on a Kleinunternehmer account: sevDesk refused to finalize
 * one with rule 9 there and named 10 (Nicht vorsteuerabziehbare Aufwendungen) and 13 (Reverse
 * Charge ohne Vorsteuerabzug) as the allowed rules, both 0 % (422, recorded 2026-11-07). Saving
 * with them is not recorded yet; the preview says so.
 */
const SMALL_BUSINESS_PROVISION_RULE_IDS = [10, 13];
const SMALL_BUSINESS_PROVISION_DEFAULT = 10;
const DEFAULT_HEADER = "Gutschrift";
/**
 * Read-back note for a credit note without a number: unlike invoices, sevDesk does not assign one
 * reliably at finalize, and sevdesk_credit_note_finalize refuses such drafts (recorded 2026-11-07).
 */
const NUMBERLESS_CREDIT_NOTE =
  "The credit note has no number, and sevdesk_credit_note_finalize refuses credit notes without " +
  "one (sevDesk can fail half-way on them). Create it again with " +
  "sevdesk_credit_note_create_draft, which reserves a number, or set a number in the sevDesk " +
  "web app.";
const FINALIZE_TOOL = "sevdesk_credit_note_finalize";

/** Input fields of `sevdesk_credit_note_create_draft` (without `dryRun`). */
export const creditNoteCreateInputShape = {
  contactId: contactIdInput,
  bookingCategory: z
    .enum(Object.keys(BOOKING_CATEGORY_NAMES) as [BookingCategoryName, ...BookingCategoryName[]])
    .describe(
      "Buchungskategorie: underachievement (Minderleistung: reduces an issued invoice, needs " +
        "sourceInvoiceId), provision (Provisionsgutschrift, tax rule 9), royalty_assigned or " +
        "royalty_unassigned (Lizenzgebühren).",
    ),
  sourceInvoiceId: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "underachievement only: id of the finalized invoice this credit note reduces (refSrcInvoice).",
    ),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe(
      "underachievement only: create it even though a credit note for the source invoice " +
        "exists (e.g. a second partial refund). Default false.",
    ),
  positions: z
    .array(draftPositionInput)
    .min(1)
    .max(MAX_POSITIONS)
    .describe("Positionen in printed order; prices per priceMode."),
  date: documentDateInput.describe("Gutschriftsdatum, YYYY-MM-DD; default today (Europe/Berlin)."),
  deliveryDate: deliveryDateInput,
  deliveryDateUntil: deliveryDateUntilInput,
  priceMode: priceModeInput,
  taxRule: taxRuleInput.describe(
    "Tax rule (Steuerregel) id. Default: the source invoice's rule (underachievement), 9 " +
      "(provision; 10 on a Kleinunternehmer account) or the account's: 1 for regular VAT, 11 " +
      "for Kleinunternehmer. See sevdesk_reference_lookup kind=tax_rules.",
  ),
  taxText: taxTextInput,
  currency: currencyInput.describe("ISO 4217 code; default EUR or the source invoice's currency."),
  header: headerInput.describe('Document title (Betreff); default "Gutschrift".'),
  headText: headTextInput,
  footText: footTextInput,
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
};

export interface CreditNoteCreateArgs extends CreateArgs {
  readonly bookingCategory: BookingCategoryName;
  readonly sourceInvoiceId?: number | undefined;
  readonly allowDuplicate?: boolean | undefined;
  readonly positions: readonly PositionInput[];
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

export interface CreditNoteDraftState {
  /** The body to save; its `creditNoteNumber` is the peeked one, replaced by the reserved. */
  readonly body: SaveCreditNoteBody;
  readonly expected: Amounts;
  /** The number the preview showed. */
  readonly peekedNumber: string;
}

export interface CreditNoteDraftPlan {
  readonly preview: DraftPreview;
  readonly state: CreditNoteDraftState;
}

/**
 * Prepares a new draft credit note: validates, reads, peeks the next number, builds the body and
 * the preview.
 */
export async function prepareCreditNoteCreate(
  client: SevdeskClient,
  args: CreditNoteCreateArgs,
  options: DraftCallOptions,
): Promise<CreditNoteDraftPlan> {
  const { signal } = options;
  const category = BOOKING_CATEGORY_NAMES[args.bookingCategory];
  const date = args.date ?? todayInBerlin();
  const delivery = resolveDeliveryPeriod(date, args.deliveryDate, args.deliveryDateUntil, false);
  if (
    category !== "UNDERACHIEVEMENT" &&
    (args.sourceInvoiceId !== undefined || args.allowDuplicate !== undefined)
  ) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "sourceInvoiceId and allowDuplicate only apply to bookingCategory underachievement (a " +
        "credit note that reduces an invoice).",
    });
  }
  const sourceCheck =
    category === "UNDERACHIEVEMENT" ? await checkSourceInvoice(client, args, signal) : undefined;
  const source = sourceCheck?.source;

  const basics = await resolveCreateBasics(
    client,
    { ...args, currency: args.currency ?? source?.invoice.currency },
    taxOptions(category, source),
    options,
  );
  const { contact, contactPerson, address, currency, expected, mode } = basics;
  if (source !== undefined && source.invoice.currency !== currency) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `The source invoice ${source.invoice.id} is in ${source.invoice.currency}; the credit ` +
        "note must use the same currency.",
    });
  }
  const duplicateQuery = { contactId: args.contactId, date, gross: expected.gross, currency };
  const duplicates = await findDuplicates(client, { kind: "creditNote" }, duplicateQuery, signal);
  const peeked = await peekNextNumber(client, { kind: "creditNote" }, signal);

  const header = args.header ?? DEFAULT_HEADER;
  const body = strictBody(
    saveCreditNoteBodySchema,
    {
      creditNote: {
        objectName: "CreditNote",
        mapAll: true,
        creditNoteNumber: peeked,
        creditNoteType: "CN",
        status: 100,
        contact: ref(args.contactId, "Contact"),
        contactPerson: ref(contactPerson.id, "SevUser"),
        creditNoteDate: wireDocumentDate(date),
        deliveryDate: wireTimestamp(delivery.from),
        deliveryDateUntil: delivery.until === undefined ? undefined : wireTimestamp(delivery.until),
        header,
        headText: args.headText,
        footText: args.footText,
        discount: 0,
        currency,
        showNet: mode === "net",
        ...basics.tax,
        bookingCategory: category,
        refSrcInvoice: source === undefined ? undefined : ref(source.invoice.id, "Invoice"),
        ...structuredAddress(address),
      },
      creditNotePosSave: basics.positions.map((position, index) =>
        positionPayload(position, index, "CreditNotePos"),
      ),
      creditNotePosDelete: null,
    },
    "credit note",
  );

  const facts: PreviewFact[] = [
    fact("Number", `${peeked} (reserved when the draft is saved)`),
    fact("Customer", customerText(contact.contact.displayName, args.contactId)),
    fact("Booking category", category),
    ...(source === undefined
      ? []
      : [
          fact(
            "Reduces invoice",
            `${source.invoice.id}${source.invoice.number === undefined ? "" : ` (${source.invoice.number})`}`,
          ),
        ]),
    fact("Address", addressText(address)),
    fact("Credit note date", date),
    fact("Delivery date", formatPeriod(delivery)),
    fact("Contact person", `${contactPerson.name} (user ${contactPerson.id})`),
    fact("Title", header),
    fact("Prices entered as", mode),
    fact("Tax", taxText(basics.rule, basics.tax)),
    fact("Tax text", basics.tax.taxText),
    ...positionFacts(basics.positions, mode, currency),
    fact("Total (expected)", totalsText(expected, currency)),
  ];
  const royaltyWarning = category.startsWith("ROYALTY")
    ? "sevDesk's requirements for royalty credit notes (tax rule, accounts) are not documented " +
      "or recorded; check the draft in sevDesk before finalizing."
    : undefined;
  const preview = draftPreview(
    `Create a draft credit note (Gutschrift, ${category}) for ` +
      `${customerText(contact.contact.displayName, args.contactId)} with ` +
      `${positionCount(basics.positions.length)}, gross ${moneyText(expected.gross, currency)}.`,
    facts,
    [
      ...(sourceCheck?.warnings ?? []),
      duplicateWarning("credit note", duplicates, duplicateQuery),
      reservationWarning("credit note", peeked),
      royaltyWarning,
      ...basics.warnings,
    ],
  );
  return { preview, state: { body, expected, peekedNumber: peeked } };
}

export interface CreditNoteDraftResult {
  readonly id: number;
  readonly details: CreditNoteDetails;
  readonly notes: readonly string[];
}

/**
 * Reserves a free credit note number ({@link reserveFreeCreditNoteNumber}: numbers existing
 * credit notes carry are skipped), saves the prepared body with it (one request, never retried)
 * and reads the credit note back. When the save fails, the error names the reserved, now skipped
 * number.
 */
export async function executeCreditNoteDraft(
  client: SevdeskClient,
  state: CreditNoteDraftState,
  signal?: AbortSignal,
): Promise<CreditNoteDraftResult> {
  const reserved = await reserveFreeCreditNoteNumber(client, signal);
  const body = strictBody(
    saveCreditNoteBodySchema,
    { ...state.body, creditNote: { ...state.body.creditNote, creditNoteNumber: reserved.number } },
    "credit note",
  );
  let response: unknown;
  try {
    response = await client.request({
      method: "POST",
      path: "/CreditNote/Factory/saveCreditNote",
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError) {
      throw reservedNumberError(error, "credit note", reserved.number);
    }
    throw error;
  }
  const id = savedDocumentId(response, "creditNote", "credit note");
  const details = await readBack({ objectName: "CreditNote", id: String(id) }, () =>
    getCreditNote(client, id, signal),
  );
  const stored = storedNumberNote("credit note", reserved.number, details.creditNote.number);
  const notes = [
    ...numberNotes(state.peekedNumber, reserved),
    ...(stored === undefined ? [] : [stored]),
    ...readBackNotes(
      {
        number: details.creditNote.number,
        gross: details.creditNote.totals.gross?.amount,
        currency: details.creditNote.currency,
        positionsComplete: details.positionsComplete,
      },
      {
        noun: "credit note",
        finalizeTool: FINALIZE_TOOL,
        expected: state.expected,
        numberless: NUMBERLESS_CREDIT_NOTE,
      },
    ),
  ];
  return { id, details, notes };
}

/** Trusted result notes about the reserved number: skipped numbers, a cut scan, a new number. */
function numberNotes(
  peeked: string,
  reserved: {
    readonly number: string;
    readonly skipped: readonly string[];
    readonly truncated: boolean;
  },
): string[] {
  const notes: string[] = [];
  const number = quotableNumber(reserved.number) ?? "the reserved number";
  if (reserved.skipped.length > 0) {
    notes.push(
      `Skipped credit note number${reserved.skipped.length === 1 ? "" : "s"} ` +
        `${numberList(reserved.skipped)}: existing credit notes carry ` +
        `${reserved.skipped.length === 1 ? "it" : "them"} already (sevDesk's counter lagged ` +
        "behind, e.g. after sevdesk_credit_note_create_from_invoice). The draft was saved with " +
        `${number}.`,
    );
  } else {
    const changed = changedNumberNote("credit note", peeked, reserved.number);
    if (changed !== undefined) notes.push(changed);
  }
  if (reserved.truncated) {
    notes.push(
      `Only the first ${CREDIT_NOTE_SCAN_MAX} credit notes were checked for ${number}; make ` +
        "sure in sevDesk that no " +
        "other credit note carries it before finalizing.",
    );
  }
  return notes;
}

/** The checked source invoice of an underachievement credit note and its preview warnings. */
interface SourceCheck {
  readonly source: InvoiceDetails;
  readonly warnings: readonly string[];
}

/**
 * The invoice an underachievement credit note reduces, checked with the same rules as
 * `sevdesk_credit_note_create_from_invoice` so the two tools agree:
 * - it must exist and belong to the credit note's contact (checked first: no scan for a wrong id);
 * - `checkInvoiceCreditable` (master-data module): a finalized RE/AR/TR/ER that was not cancelled
 *   (a Storno found, or a paid-but-nothing-paid invoice whose scan was cut, is refused);
 * - `findCreditNotesForInvoice`: an existing credit note for it (from the invoice or with it as
 *   `refSrcInvoice`) is refused unless `allowDuplicate`, with the same wording.
 * Reads only.
 */
async function checkSourceInvoice(
  client: SevdeskClient,
  args: CreditNoteCreateArgs,
  signal: AbortSignal | undefined,
): Promise<SourceCheck> {
  if (args.sourceInvoiceId === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "bookingCategory underachievement needs sourceInvoiceId: the finalized invoice the " +
        "credit note reduces. To credit a whole invoice use sevdesk_credit_note_create_from_invoice.",
    });
  }
  let source: InvoiceDetails;
  try {
    source = await getInvoice(client, args.sourceInvoiceId, signal);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw new SevdeskError({
        kind: "validation",
        message: `Invoice ${args.sourceInvoiceId} does not exist. Find it with sevdesk_invoices_list.`,
      });
    }
    throw error;
  }
  const invoice = source.invoice;
  if (invoice.contact?.id !== args.contactId) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${invoice.id} belongs to contact ${invoice.contact?.id ?? "(none)"}, not to ` +
        `contact ${args.contactId}. Use the invoice's contact.`,
    });
  }
  const checked = await checkInvoiceCreditable(client, invoice, signal);

  const existing = await findCreditNotesForInvoice(
    client,
    { invoiceId: invoice.id, contactId: invoice.contact.id },
    signal,
  );
  const credits = creditNoteList(existing.ids);
  if (existing.ids.length > 0 && args.allowDuplicate !== true) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `A credit note for ${invoiceLabel(invoice.id, invoice.number)} exists already: ` +
        `${credits}. Check it with sevdesk_credit_note_get, or call again with ` +
        "allowDuplicate: true to create another one (e.g. a second partial refund).",
    });
  }
  const warnings = [...checked.warnings];
  if (existing.ids.length > 0) {
    warnings.push(`Creating another one (allowDuplicate): ${credits} exists already.`);
  }
  if (existing.truncated) {
    warnings.push("Not every credit note could be checked for an earlier one from this invoice.");
  }
  return { source, warnings };
}

/** "Invoice RE-1001 (id 1001)", as the master-data tools label invoices. */
function invoiceLabel(id: number, number: string | undefined): string {
  return number === undefined ? `Invoice ${id}` : `Invoice ${number} (id ${id})`;
}

/** "credit note 7, credit note 9", at most five, as the master-data tools list them. */
function creditNoteList(ids: readonly number[]): string {
  const shown = ids.slice(0, 5).map((id) => `credit note ${id}`);
  return ids.length > 5 ? `${shown.join(", ")} and ${ids.length - 5} more` : shown.join(", ");
}

/** The tax rules and rates a credit note of `category` accepts. */
function taxOptions(
  category: (typeof CREDIT_NOTE_BOOKING_CATEGORIES)[number],
  source: InvoiceDetails | undefined,
): TaxOptions {
  if (category === "PROVISION") {
    return {
      scope: { allowedRuleIds: [PROVISION_TAX_RULE_ID], documents: "provision credit notes" },
      defaultRuleId: PROVISION_TAX_RULE_ID,
      smallBusiness: {
        scope: {
          allowedRuleIds: SMALL_BUSINESS_PROVISION_RULE_IDS,
          documents: "provision credit notes on a Kleinunternehmer account",
        },
        defaultRuleId: SMALL_BUSINESS_PROVISION_DEFAULT,
        warning:
          "On a Kleinunternehmer account provision credit notes take tax rule 10 or 13 at 0 % " +
          "(sevDesk names them when it refuses rule 9); saving one this way is not verified " +
          "live yet, so check the draft in sevDesk before finalizing.",
      },
    };
  }
  const scope = { allowedRuleIds: SALES_TAX_RULE_IDS, documents: "credit notes" };
  if (source === undefined) return { scope, defaultRuleId: DEFAULT_TAX_RULE_ID };
  const rates: string[] = [];
  for (const position of source.positions) {
    const rate = position.taxRate;
    if (rate !== undefined && !rates.some((known) => compare(known, rate) === 0)) rates.push(rate);
  }
  const sourceRule = source.invoice.tax.rule?.id;
  return {
    scope,
    // The source invoice's rule stays the default on every account: a credit note keeps the
    // invoice's rates, so the regime's own default (rule 11) would only dead-end on them.
    defaultRuleId:
      sourceRule !== undefined && SALES_TAX_RULE_IDS.includes(sourceRule)
        ? sourceRule
        : DEFAULT_TAX_RULE_ID,
    keepDefault: true,
    regimeMessage: sourceRegimeMessage(source.invoice.id, rates),
    rateLimit:
      rates.length === 0 ? undefined : { rates, owner: `the source invoice ${source.invoice.id}` },
  };
}

/**
 * The refusal for an underachievement credit note whose rule does not fit the account's regime:
 * it names a rule of the regime that allows all the source invoice's rates, or says that none
 * does (the invoice was issued under the other regulation, so the correction belongs in sevDesk
 * or with the tax advisor). Trusted text: ids and rates only.
 */
function sourceRegimeMessage(invoiceId: number, rates: readonly string[]): RegimeMessage {
  return (rule, regime) => {
    const reason = regimeReason(rule, regime, "credit notes");
    const rateText =
      rates.length === 0 ? "" : `: ${rates.map((rate) => toDecimalString(rate)).join(", ")} %`;
    const alternative = SALES_TAX_RULE_IDS.map((id) => taxRuleById(id)).find(
      (candidate) =>
        candidate !== undefined &&
        candidate.regimes.includes(regime) &&
        candidate.allowedTaxRates !== undefined &&
        rates.every((rate) =>
          candidate.allowedTaxRates?.some((allowed) => compare(allowed, rate) === 0),
        ),
    );
    if (alternative !== undefined) {
      return (
        `${reason} Pass taxRule ${alternative.id} (${alternative.nameDe}) instead: it allows the ` +
        `rates of invoice ${invoiceId}${rateText}.`
      );
    }
    return (
      `${reason} An underachievement credit note must keep the rates of the invoice it reduces ` +
      `(invoice ${invoiceId}${rateText}), and no tax rule of this regulation allows them: the ` +
      "invoice was issued under the other regulation. Correct it in the sevDesk web app or with " +
      "your tax advisor."
    );
  };
}
