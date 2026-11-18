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
 *
 * Update (recorded 2026-11-16, spec/deviations.md D-110): the same factory with the draft's id
 * updates it in place, like `saveInvoice` (D-054). The body carries every writable field this
 * server knows over from the stored draft (`current.ts`): the stored number unchanged (never
 * reserved anew), the booking category, `refSrcInvoice` and `origin` (a credit note made by
 * `createFromInvoice` kept both, its type and its number through an update). Positions are kept
 * (`creditNotePosSave: []`, `creditNotePosDelete: null`, the recorded shape) or replaced as a
 * whole: every stored row in `creditNotePosDelete` as a list of refs (a single object is refused
 * with 400) and the new ones in `creditNotePosSave`, in one request. Not sent, since no recorded
 * credit note has them set and sevDesk keeps what an update leaves out: `timeToPay`,
 * `propertyIsEInvoice`, `refSrcVoucher`. `costCentre` is sent only when the call sets one
 * (`costCentre`) or removes it (`removeCostCentre`: `null`, recorded 2026-11-17); otherwise it is
 * left out and sevDesk keeps the stored one (D-092). The booking category and the source invoice
 * cannot be changed here (that is a new credit note); the source invoice's rules are checked
 * again when the update changes what they depend on (see `prepareCreditNoteUpdate`).
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { statusDto } from "../common.js";
import {
  COST_CENTRE_FLAGS,
  type CostCentreArg,
  costCentreChange,
  costCentreInput,
  costCentreLabel,
  costCentreRef,
  costCentreUpdate,
  costCentreUpdateInputShape,
  costCentreUpdatePayload,
  resolveCostCentre,
} from "../cost-centres.js";
import type { CountryReadOptions } from "../country-codes.js";
import { type CreditNoteDetails, getCreditNote } from "../credit-notes.js";
import { checkInvoiceCreditable, findCreditNotesForInvoice } from "../derived-documents.js";
import { readDocumentDiscounts } from "../document-discounts.js";
import { BOOKING_CATEGORY_NAMES } from "../filter-keys.js";
import { getInvoice, type InvoiceDetails } from "../invoices.js";
import { compare, toDecimalString } from "../money.js";
import { taxRuleById } from "../reference-data.js";
import { berlinDay, type CurrentCreditNote, loadCurrentCreditNote } from "./current.js";
import {
  createDiscountBody,
  createTotals,
  type DiscountInput,
  discountInput,
  discountReadBackNote,
  discountText,
  discountUpdateInput,
  type DraftDiscount,
  expectedOfCreate,
  type ExpectedTotals,
  planDiscountChange,
  resolveDiscount,
  updateTotals,
} from "./discount.js";
import {
  assertChanges,
  ChangeLog,
  createTotalFact,
  draftPreview,
  logContactPersonChange,
  logDiscountChange,
  logPricingChanges,
  logRecipientChanges,
  logTextChanges,
  numberLabel,
  positionCount,
  ref,
  storedNumber,
  storedRef,
  structuredAddress,
  taxText,
  updatedAddressFields,
  updateTotalFact,
} from "./document.js";
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
  NUMBER_FIELDS,
  numberCount,
  peekNextNumber,
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
  draftPositionInput,
  MAX_POSITIONS,
  type PositionInput,
  positionPayload,
  wireNumber,
} from "./positions.js";
import {
  addressText,
  customerRef,
  customerText,
  type DraftPreview,
  fact,
  moneyText,
  positionFacts,
  type PreviewFact,
} from "./preview.js";
import { readBack, readBackNotes } from "./read-back.js";
import { addressInputShape } from "./recipient.js";
import {
  type CreateArgs,
  type DraftCallOptions,
  resolveCreateBasics,
  resolveUpdateBasics,
  structuredStoredAddress,
  type TaxOptions,
  type UpdateArgs,
} from "./shared.js";
import {
  DEFAULT_TAX_RULE_ID,
  type RegimeMessage,
  regimeReason,
  SALES_TAX_RULE_IDS,
} from "./tax.js";

/** Readable booking categories → sevDesk's `bookingCategory`. */
export type BookingCategoryName = keyof typeof BOOKING_CATEGORY_NAMES;

/** A booking category this server writes. */
type CreditNoteCategory = (typeof CREDIT_NOTE_BOOKING_CATEGORIES)[number];

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

const positionsInput = z
  .array(draftPositionInput)
  .min(1)
  .max(MAX_POSITIONS)
  .describe("Positionen in printed order; prices per priceMode.");

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
  positions: positionsInput,
  date: documentDateInput.describe("Gutschriftsdatum, YYYY-MM-DD; default today (Europe/Berlin)."),
  deliveryDate: deliveryDateInput,
  deliveryDateUntil: deliveryDateUntilInput,
  priceMode: priceModeInput,
  taxRuleId: taxRuleInput.describe(
    "Tax rule (Steuerregel) id. Default: the source invoice's rule (underachievement), 9 " +
      "(provision; 10 on a Kleinunternehmer account) or the account's: 1 for regular VAT, 11 " +
      "for Kleinunternehmer. See sevdesk_reference_lookup kind=tax_rules.",
  ),
  taxText: taxTextInput,
  currency: currencyInput.describe("ISO 4217 code; default EUR or the source invoice's currency."),
  header: headerInput.describe('Document title (Betreff); default "Gutschrift".'),
  headText: headTextInput,
  footText: footTextInput,
  discount: discountInput.optional(),
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
  costCentre: costCentreInput,
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
  readonly discount?: DiscountInput | undefined;
  readonly costCentre?: CostCentreArg | undefined;
}

/** Input fields of `sevdesk_credit_note_update_draft` (without `dryRun`). */
export const creditNoteUpdateInputShape = {
  id: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Id of the draft credit note (not its number), e.g. from sevdesk_credit_notes_list."),
  positions: positionsInput
    .optional()
    .describe("When given, replaces ALL positions; leave out to keep them."),
  contactId: contactIdInput.optional(),
  date: documentDateInput.describe("Gutschriftsdatum, YYYY-MM-DD."),
  deliveryDate: deliveryDateInput.describe("Liefer-/Leistungsdatum, YYYY-MM-DD."),
  deliveryDateUntil: deliveryDateUntilInput,
  priceMode: priceModeInput.describe(
    "Net or gross unit prices (showNet). Changing it requires positions too.",
  ),
  taxRuleId: taxRuleInput.describe(
    "New tax rule (Steuerregel) id; see sevdesk_reference_lookup kind=tax_rules.",
  ),
  taxText: taxTextInput,
  currency: currencyInput,
  header: headerInput,
  headText: headTextInput,
  footText: footTextInput,
  discount: discountUpdateInput,
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
  ...costCentreUpdateInputShape,
};

export interface CreditNoteUpdateArgs extends UpdateArgs {
  readonly id: number;
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
  /** A new document discount, `null` to remove the stored one, left out to keep it. */
  readonly discount?: DiscountInput | null | undefined;
  readonly costCentre?: CostCentreArg | undefined;
  readonly removeCostCentre?: boolean | undefined;
}

/** What `execute` needs: the exact body the preview describes. */
export interface CreditNoteDraftState {
  /**
   * The body to save. On a create its `creditNoteNumber` is the peeked one, replaced by the
   * reserved; on an update it is the stored number, sent unchanged.
   */
  readonly body: SaveCreditNoteBody;
  /** Set for updates: the credit note the save must keep (no number is reserved then). */
  readonly creditNoteId?: number | undefined;
  /**
   * Expected totals when the call set the positions or the discount (see `createTotals` and
   * `updateTotals`); the read-back compares them.
   */
  readonly expected?: ExpectedTotals | undefined;
  /** Create only: the number the preview showed. */
  readonly peekedNumber?: string | undefined;
  /** The discount the call sent (`null`: removed), checked in the read-back. */
  readonly discount?: DraftDiscount | null | undefined;
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
  const discount = args.discount === undefined ? undefined : resolveDiscount(args.discount);
  const centre =
    args.costCentre === undefined
      ? undefined
      : await resolveCostCentre(client, args.costCentre, signal);
  const sourceCheck =
    category === "UNDERACHIEVEMENT"
      ? await checkSourceInvoice(client, args, { signal, cacheOwner: options.cacheOwner })
      : undefined;
  const source = sourceCheck?.source;

  const basics = await resolveCreateBasics(
    client,
    { ...args, currency: args.currency ?? source?.invoice.currency },
    taxOptions(category, source),
    options,
  );
  const { contact, contactPerson, address, currency, mode } = basics;
  if (source !== undefined) checkSourceCurrency(source, currency);
  const totals = createTotals(basics.positions, mode, discount);
  const duplicateQuery = { contactId: args.contactId, date, gross: totals.gross, currency };
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
        costCentre: centre === undefined ? undefined : costCentreRef(centre.id),
      },
      creditNotePosSave: basics.positions.map((position, index) =>
        positionPayload(position, index, "CreditNotePos"),
      ),
      creditNotePosDelete: null,
      ...createDiscountBody(discount),
    },
    "credit note",
  );

  const facts: PreviewFact[] = [
    fact("Number", `${peeked} (reserved when the draft is saved)`),
    fact("Customer", customerText(contact.contact.displayName, args.contactId)),
    fact("Booking category", category),
    ...(source === undefined
      ? []
      : [fact("Reduces invoice", sourceLabel(source.invoice.id, source.invoice.number))]),
    fact("Address", addressText(address)),
    fact("Credit note date", date),
    fact("Delivery date", formatPeriod(delivery)),
    fact("Contact person", `${contactPerson.name} (user ${contactPerson.id})`),
    fact("Title", header),
    fact("Prices entered as", mode),
    fact("Tax", taxText(basics.rule, basics.tax)),
    fact("Tax text", basics.tax.taxText),
    ...(centre === undefined ? [] : [fact("Cost centre (Kostenstelle)", costCentreLabel(centre))]),
    ...positionFacts(basics.positions, mode, currency),
    ...(discount === undefined ? [] : [fact("Discount", discountText(discount, currency, mode))]),
    createTotalFact(totals, currency),
  ];
  const preview = draftPreview(
    `Create a draft credit note (Gutschrift, ${category}) for ${customerRef(args.contactId)} ` +
      `with ${positionCount(basics.positions.length)}, gross ` +
      `${moneyText(totals.gross, currency)}.`,
    facts,
    [
      ...(sourceCheck?.warnings ?? []),
      duplicateWarning("credit note", duplicates, duplicateQuery),
      reservationWarning("credit note"),
      royaltyWarning(category),
      ...basics.warnings,
    ],
  );
  return {
    preview,
    state: { body, expected: expectedOfCreate(totals), peekedNumber: peeked, discount },
  };
}

/**
 * Prepares an update of a draft credit note: reads the stored draft, refuses anything but a
 * regular draft (status 100, type CN, a booking category this server writes), merges the call
 * into it and builds the body and the preview. The stored number is kept (never reserved anew).
 *
 * An underachievement credit note that refers to an invoice (`refSrcInvoice`, or `origin` on one
 * made by `createFromInvoice`) has the source invoice's rules checked again when the call changes
 * what they depend on: the contact (the invoice must be the contact's), the positions or the tax
 * rule (only the invoice's rates; a rule that does not fit the account names one that allows
 * them) and the currency (the invoice's). Whether the invoice is still creditable and whether
 * other credit notes exist for it were checked when the credit note was created and do not
 * depend on these fields, so they are not repeated. Reads only.
 */
export async function prepareCreditNoteUpdate(
  client: SevdeskClient,
  args: CreditNoteUpdateArgs,
  options: DraftCallOptions,
): Promise<CreditNoteDraftPlan> {
  const { signal } = options;
  const given = assertChanges(args, "credit note", COST_CENTRE_FLAGS);
  const current = await loadCurrentCreditNote(client, args.id, signal);
  const doc = current.document;
  const category = checkUpdatable(doc);
  const centre = await costCentreUpdate(
    client,
    args,
    { storedId: doc.costCentre?.id, given },
    signal,
  );
  const discounts = await readDocumentDiscounts(client, "creditNote", doc.id, signal);
  const change = planDiscountChange(args.discount, discounts, `Credit note ${doc.id}`);

  const sourceId = category === "UNDERACHIEVEMENT" ? sourceInvoiceIdOf(doc) : undefined;
  const contactId = args.contactId ?? doc.contact?.id;
  const recheck =
    args.contactId !== undefined ||
    args.positions !== undefined ||
    args.taxRuleId !== undefined ||
    args.currency !== undefined;
  const source =
    sourceId !== undefined && contactId !== undefined && recheck
      ? await loadSourceInvoice(
          client,
          sourceId,
          contactId,
          `The source invoice ${sourceId} of credit note ${doc.id} does not exist any more, so ` +
            "the change cannot be checked against it. Check the credit note in sevDesk.",
          { signal, cacheOwner: options.cacheOwner },
        )
      : undefined;

  const basics = await resolveUpdateBasics(
    client,
    doc,
    structuredStoredAddress(doc),
    current.positions,
    args,
    taxOptions(category, source),
    options,
  );
  if (source !== undefined) checkSourceCurrency(source, basics.currency);

  const storedDate = berlinDay(doc.creditNoteDate);
  const date = args.date ?? storedDate ?? todayInBerlin();
  const storedDelivery = berlinDay(doc.deliveryDate);
  const storedUntil = berlinDay(doc.deliveryDateUntil);
  const delivery = resolveDeliveryPeriod(
    date,
    args.deliveryDate ?? storedDelivery ?? date,
    args.deliveryDateUntil ?? storedUntil,
    false,
  );
  const totals = updateTotals({
    change,
    positions: basics.positions,
    storedPositions: current.positions,
    mode: basics.mode,
    currencyChanged: basics.currencyChanged,
    stored: doc,
  });
  const expected = totals.expected;

  const body = strictBody(
    saveCreditNoteBodySchema,
    {
      creditNote: {
        id: doc.id,
        objectName: "CreditNote",
        mapAll: true,
        creditNoteNumber: storedNumber(doc.creditNoteNumber),
        creditNoteType: "CN",
        status: 100,
        contact: ref(basics.contact.contact.id, "Contact"),
        contactPerson: ref(basics.contactPerson.id, "SevUser"),
        creditNoteDate: wireDocumentDate(date),
        deliveryDate: wireTimestamp(delivery.from),
        deliveryDateUntil: delivery.until === undefined ? undefined : wireTimestamp(delivery.until),
        header: args.header ?? doc.header,
        headText: args.headText ?? doc.headText,
        footText: args.footText ?? doc.footText,
        discount: wireNumber(doc.discount ?? "0", "the stored cash discount (Skonto)"),
        discountTime: doc.discountTime,
        currency: basics.currency,
        showNet: basics.mode === "net",
        ...basics.tax,
        bookingCategory: category,
        refSrcInvoice: storedRef(doc.refSrcInvoice, "Invoice"),
        ...updatedAddressFields(doc, basics.address),
        customerInternalNote: doc.customerInternalNote,
        paymentMethod: storedRef(doc.paymentMethod, "PaymentMethod"),
        // Only when the call sets or removes it: left out, sevDesk keeps the stored one (D-092).
        costCentre:
          centre === undefined ? undefined : costCentreUpdatePayload(centre, doc.costCentre?.id),
        origin:
          doc.origin === undefined
            ? undefined
            : { id: doc.origin.id, objectName: doc.origin.objectName },
      },
      creditNotePosSave:
        basics.positions === undefined
          ? []
          : basics.positions.map((position, index) =>
              positionPayload(position, index, "CreditNotePos"),
            ),
      creditNotePosDelete:
        basics.positions === undefined || current.positions.length === 0
          ? null
          : current.positions.map((row) => ref(row.id, "CreditNotePos")),
      ...change.body,
    },
    "credit note",
  );

  const log = new ChangeLog();
  logRecipientChanges(log, doc, basics);
  log.value("date", "Credit note date", storedDate, date);
  log.value(
    "delivery date",
    "Delivery date",
    storedDelivery === undefined
      ? undefined
      : formatPeriod({ from: storedDelivery, until: storedUntil }),
    formatPeriod(delivery),
  );
  logContactPersonChange(log, doc, basics);
  logTextChanges(log, doc.header, args);
  logPricingChanges(log, doc, basics, current.positions.length);
  if (centre !== undefined) {
    log.value("cost centre", "Cost centre (Kostenstelle)", ...costCentreChange(centre));
  }
  const keptDiscount = logDiscountChange(log, change, discounts.rows, basics.currency, basics.mode);

  const customer = customerText(basics.contact.contact.displayName, basics.contact.contact.id);
  const facts: PreviewFact[] = [
    fact("Credit note", `${doc.id} (${numberLabel(doc.creditNoteNumber)}, draft)`),
    fact("Customer", customer),
    fact("Booking category", category),
    ...(sourceId === undefined
      ? []
      : [fact("Reduces invoice", sourceLabel(sourceId, source?.invoice.number))]),
    ...log.facts,
    ...(basics.positions === undefined
      ? []
      : positionFacts(basics.positions, basics.mode, basics.currency)),
    ...keptDiscount,
    updateTotalFact(totals, doc, basics.currency),
  ];
  const preview = draftPreview(
    `Update draft credit note ${doc.id} for ${customerRef(basics.contact.contact.id)}: change ` +
      `${log.changed.join(", ") || "nothing visible"}.`,
    facts,
    [royaltyWarning(category), ...basics.warnings, totals.warning],
  );
  return {
    preview,
    state: { body, creditNoteId: doc.id, expected, discount: change.planned },
  };
}

export interface CreditNoteDraftResult {
  readonly id: number;
  readonly details: CreditNoteDetails;
  readonly notes: readonly string[];
}

/**
 * Saves the prepared body (one request, never retried) and reads the credit note back. A create
 * first reserves a free credit note number ({@link reserveFreeCreditNoteNumber}: numbers existing
 * credit notes carry are skipped) and saves with it; when the save then fails, the error says
 * that the reserved number is now skipped. An update saves its stored number unchanged and fails
 * loudly when sevDesk's answer names another credit note.
 */
export async function executeCreditNoteDraft(
  client: SevdeskClient,
  state: CreditNoteDraftState,
  options: CountryReadOptions,
): Promise<CreditNoteDraftResult> {
  const { signal, cacheOwner } = options;
  const reserved =
    state.creditNoteId === undefined
      ? await reserveFreeCreditNoteNumber(client, signal)
      : undefined;
  const body =
    reserved === undefined
      ? state.body
      : strictBody(
          saveCreditNoteBodySchema,
          {
            ...state.body,
            creditNote: { ...state.body.creditNote, creditNoteNumber: reserved.number },
          },
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
    if (reserved !== undefined && error instanceof SevdeskError) {
      throw reservedNumberError(error, "credit note");
    }
    throw error;
  }
  const id = savedDocumentId(response, "creditNote", "credit note");
  const saved = { objectName: "CreditNote", id: String(id) };
  if (state.creditNoteId !== undefined && id !== state.creditNoteId) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk saved credit note ${id} instead of updating credit note ${state.creditNoteId}. ` +
        "Check both drafts in sevDesk and delete the extra one there before repeating the call.",
      completedWrites: [saved],
    });
  }
  const details = await readBack(saved, () =>
    getCreditNote(client, id, { signal, cacheOwner, withDiscount: true }),
  );
  const stored =
    reserved === undefined
      ? undefined
      : storedNumberNote(
          "credit note",
          NUMBER_FIELDS.creditNote,
          reserved.number,
          details.creditNote.number,
        );
  const discountNote = discountReadBackNote(state.discount, details.discount, "credit note");
  const notes = [
    ...(reserved === undefined ? [] : numberNotes(state.peekedNumber ?? reserved.number, reserved)),
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
    ...(discountNote === undefined ? [] : [discountNote]),
  ];
  return { id, details, notes };
}

/** "1001 (RE-1001)": the source invoice's id and, when known, its (cleaned) number. */
function sourceLabel(invoiceId: number, number: string | undefined): string {
  return `${invoiceId}${number === undefined ? "" : ` (${number})`}`;
}

/** Preview warning for royalty credit notes, whose requirements are not recorded. */
function royaltyWarning(category: CreditNoteCategory): string | undefined {
  return category.startsWith("ROYALTY")
    ? "sevDesk's requirements for royalty credit notes (tax rule, accounts) are not documented " +
        "or recorded; check the draft in sevDesk before finalizing."
    : undefined;
}

/**
 * The invoice a stored credit note refers to: `refSrcInvoice`, else the `origin` invoice of one
 * made by `createFromInvoice` (recorded with both; spec/deviations.md D-039, D-110).
 */
function sourceInvoiceIdOf(doc: CurrentCreditNote): number | undefined {
  return (
    doc.refSrcInvoice?.id ?? (doc.origin?.objectName === "Invoice" ? doc.origin.id : undefined)
  );
}

/**
 * Only regular draft credit notes (status 100, type CN, not enshrined) of a booking category this
 * server writes can be updated here; returns the category. Messages name no stored text.
 */
function checkUpdatable(doc: CurrentCreditNote): CreditNoteCategory {
  if (berlinDay(doc.enshrined) !== undefined) {
    throw new SevdeskError({
      kind: "validation",
      message: `Credit note ${doc.id} is enshrined (festgeschrieben) and can no longer be changed.`,
    });
  }
  if (doc.status !== 100) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Credit note ${doc.id} is not a draft (status: ${statusDto("creditNote", doc.status).label}); ` +
        'only drafts can be changed. Reset an open one to a draft first with sevdesk_credit_note_reset (to: "draft").',
    });
  }
  if ((doc.creditNoteType?.trim().toUpperCase() ?? "CN") !== "CN") {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Credit note ${doc.id} is not a regular credit note (type CN); this tool only changes ` +
        "those. Edit it in sevDesk.",
    });
  }
  const code = doc.bookingCategory?.trim().toUpperCase();
  const category = CREDIT_NOTE_BOOKING_CATEGORIES.find((known) => known === code);
  if (category === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Credit note ${doc.id} has a booking category this tool does not write (it writes ` +
        "underachievement, provision, royalty_assigned and royalty_unassigned). Edit it in sevDesk.",
    });
  }
  return category;
}

/**
 * Trusted result notes about the reserved number: skipped numbers, a cut scan, a new number. They
 * point at the saved number's output field and count the skipped ones instead of quoting any
 * (#152).
 */
function numberNotes(
  peeked: string,
  reserved: {
    readonly number: string;
    readonly skipped: readonly string[];
    readonly truncated: boolean;
  },
): string[] {
  const notes: string[] = [];
  const field = NUMBER_FIELDS.creditNote;
  const count = reserved.skipped.length;
  if (count > 0) {
    notes.push(
      `Skipped ${numberCount(count)}: existing credit notes carry ${count === 1 ? "it" : "them"} ` +
        "already (sevDesk's counter lagged behind, e.g. after " +
        "sevdesk_credit_note_create_from_invoice). The draft was saved with the next free " +
        `number (${field}).`,
    );
  } else {
    const changed = changedNumberNote("credit note", field, peeked, reserved.number);
    if (changed !== undefined) notes.push(changed);
  }
  if (reserved.truncated) {
    notes.push(
      `Only the first ${CREDIT_NOTE_SCAN_MAX} credit notes were checked for the draft's number ` +
        `(${field}); make sure in sevDesk that no other credit note carries it before finalizing.`,
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
  options: CountryReadOptions,
): Promise<SourceCheck> {
  const { signal, cacheOwner } = options;
  if (args.sourceInvoiceId === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "bookingCategory underachievement needs sourceInvoiceId: the finalized invoice the " +
        "credit note reduces. To credit a whole invoice use sevdesk_credit_note_create_from_invoice.",
    });
  }
  const source = await loadSourceInvoice(
    client,
    args.sourceInvoiceId,
    args.contactId,
    `Invoice ${args.sourceInvoiceId} does not exist. Find it with sevdesk_invoices_list.`,
    { signal, cacheOwner },
  );
  const invoice = source.invoice;
  const checked = await checkInvoiceCreditable(client, invoice, signal);

  const existing = await findCreditNotesForInvoice(
    client,
    { invoiceId: invoice.id, contactId: args.contactId },
    signal,
  );
  const credits = creditNoteList(existing.ids);
  if (existing.ids.length > 0 && args.allowDuplicate !== true) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `A credit note for Invoice ${String(invoice.id)} exists already: ` +
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

/**
 * Reads the source invoice of an underachievement credit note and checks that it belongs to the
 * credit note's contact. A missing invoice is a `validation` error with `missing` (trusted text).
 */
async function loadSourceInvoice(
  client: SevdeskClient,
  invoiceId: number,
  contactId: number,
  missing: string,
  options: CountryReadOptions,
): Promise<InvoiceDetails> {
  let source: InvoiceDetails;
  try {
    source = await getInvoice(client, invoiceId, options);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw new SevdeskError({ kind: "validation", message: missing });
    }
    throw error;
  }
  const invoice = source.invoice;
  if (invoice.contact?.id !== contactId) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${invoice.id} belongs to contact ${invoice.contact?.id ?? "(none)"}, not to ` +
        `contact ${contactId}. Use the invoice's contact.`,
    });
  }
  return source;
}

/** Refuses a credit note whose currency differs from its source invoice's. */
function checkSourceCurrency(source: InvoiceDetails, currency: string): void {
  if (source.invoice.currency !== currency) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `The source invoice ${source.invoice.id} is in ${source.invoice.currency}; the credit ` +
        "note must use the same currency.",
    });
  }
}

/** "credit note 7, credit note 9", at most five, as the master-data tools list them. */
function creditNoteList(ids: readonly number[]): string {
  const shown = ids.slice(0, 5).map((id) => `credit note ${id}`);
  return ids.length > 5 ? `${shown.join(", ")} and ${ids.length - 5} more` : shown.join(", ");
}

/** The tax rules and rates a credit note of `category` accepts. */
function taxOptions(category: CreditNoteCategory, source: InvoiceDetails | undefined): TaxOptions {
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
        `${reason} Pass taxRuleId ${alternative.id} (${alternative.nameDe}) instead: it allows the ` +
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
