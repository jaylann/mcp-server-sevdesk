/**
 * Invoice drafts (Rechnungsentwürfe, type RE, status 100) through
 * `POST /Invoice/Factory/saveInvoice`: create a new draft, or update one by sending its id (spec
 * tag `InvoicePos`, "How to create/update an invoice position"; used this way in production by
 * FSCreative, which replaces all positions with `invoicePosDelete` as an array of
 * `{id, objectName: "InvoicePos"}`).
 *
 * Create body: the request shape of jernoxit/sevdesk-rs (rebuilt from its source; it stores only
 * the response, recorded on Update 2.0 on 2026-10-01, which shows the request was accepted): no
 * number (the recorded draft has `invoiceNumber: null`; sevDesk assigns it at finalization),
 * `discount: 0` (required: "Otherwise provide zero"; it is the cash discount, Skonto), `taxRate: 0`,
 * `invoicePosDelete: null` and none of the optional trailing parameters (`discountSave`,
 * `discountDelete`, `takeDefaultAddress`), which that accepted request did not send. A discount on
 * the whole document adds `discountSave` and `discountDelete` after the positions, as recorded
 * (`discount.ts`, spec/deviations.md D-116).
 *
 * Update body: every writable field the server knows, stored values carried over (see
 * `current.ts`), the stored number unchanged, and either no position changes
 * (`invoicePosSave`/`invoicePosDelete` null) or all stored positions deleted and the new ones
 * saved in the same request, so a failure cannot leave half the positions behind. The stored
 * document discounts are read first (`getDiscounts`): kept without discount keys, or replaced or
 * removed through `discountDelete`.
 *
 * Both previews add a hint (never a refusal) when the tax rule is not one a sale to the customer
 * usually takes (`src/domain/vat/sales-tax-rule.ts`); an update judges it again only when it
 * changes the rule, the contact or the address.
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
import { type CountryReadOptions, loadCountryCodes } from "../country-codes.js";
import { readDocumentDiscounts } from "../document-discounts.js";
import { getInvoice, type InvoiceDetails } from "../invoices.js";
import { documentTypeByCode } from "../reference-data.js";
import { invoiceTaxRuleHint } from "../vat/tax-rule-helper.js";
import { berlinDay, loadCurrentInvoice } from "./current.js";
import {
  createDiscountBody,
  createTotals,
  type DiscountInput,
  discountInput,
  discountReadBackNote,
  discountText,
  discountUpdateInput,
  type DraftDiscount,
  planDiscountChange,
  resolveDiscount,
  updateTotals,
} from "./discount.js";
import {
  assertChanges,
  ChangeLog,
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
  savedDocumentId,
  type SaveInvoiceBody,
  saveInvoiceBodySchema,
  strictBody,
} from "./payloads.js";
import {
  type Amounts,
  draftPositionInput,
  MAX_POSITIONS,
  type PositionInput,
  type PositionPayload,
  positionPayload,
  wireNumber,
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
  type CreateBasics,
  type DraftCallOptions,
  resolveCreateBasics,
  resolveUpdateBasics,
  structuredStoredAddress,
  type TaxOptions,
  type UpdateArgs,
} from "./shared.js";
import {
  DEFAULT_TAX_RULE_ID,
  type DocumentTaxFields,
  type RuleScope,
  SALES_TAX_RULE_IDS,
} from "./tax.js";
import {
  footTextTemplateInput,
  headTextTemplateInput,
  resolveTemplateTexts,
  type TextArgs,
} from "./template-texts.js";

const INVOICE_SCOPE: RuleScope = { allowedRuleIds: SALES_TAX_RULE_IDS, documents: "invoices" };
const DEFAULT_HEADER = "Rechnung";
/** The text template type (`objectType`) of invoices (recorded, D-115). */
const INVOICE_TEXT_TYPE = "RE";
const FINALIZE_TOOL = "sevdesk_invoice_finalize";

/**
 * How a new invoice resolves its tax rule: the sales rules of invoices, rule 1 by default (rule 11
 * on a Kleinunternehmer account). Shared with recurring invoice templates (`../recurring/`), which
 * become invoices and must pass the same checks.
 */
export const INVOICE_TAX_OPTIONS: TaxOptions = {
  scope: INVOICE_SCOPE,
  defaultRuleId: DEFAULT_TAX_RULE_ID,
};

/** What {@link newInvoiceContent} reads from the arguments of a create call. */
export interface InvoiceContentArgs {
  readonly contactId: number;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

/** The document fields of {@link newInvoiceContent}. */
export type NewInvoiceContent = {
  readonly contact: { readonly id: number; readonly objectName: "Contact" };
  readonly contactPerson: { readonly id: number; readonly objectName: "SevUser" };
  readonly header: string;
  readonly headText: string | undefined;
  readonly footText: string | undefined;
  readonly timeToPay: number | undefined;
  readonly discount: 0;
  readonly currency: string;
  readonly showNet: boolean;
} & DocumentTaxFields &
  ReturnType<typeof structuredAddress>;

/**
 * The fields a new invoice prints, without type, status and dates: customer and contact person,
 * title (default "Rechnung"), texts, payment term, prices, tax and the address. Shared with
 * recurring invoice templates (`../recurring/`), so a template carries exactly what a draft would.
 */
export function newInvoiceContent(
  args: InvoiceContentArgs,
  basics: CreateBasics,
): NewInvoiceContent {
  return {
    contact: ref(args.contactId, "Contact"),
    contactPerson: ref(basics.contactPerson.id, "SevUser"),
    header: args.header ?? DEFAULT_HEADER,
    headText: args.headText,
    footText: args.footText,
    timeToPay: args.timeToPay,
    discount: 0,
    currency: basics.currency,
    showNet: basics.mode === "net",
    ...basics.tax,
    ...structuredAddress(basics.address),
  };
}

/** The positions of a new invoice (or template) as `invoicePosSave`, in the order given. */
export function newInvoicePositions(basics: CreateBasics): PositionPayload[] {
  return basics.positions.map((position, index) => positionPayload(position, index, "InvoicePos"));
}

const timeToPayInput = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .optional()
  .describe("Zahlungsziel in days, e.g. 14.");

const positionsInput = z
  .array(draftPositionInput)
  .min(1)
  .max(MAX_POSITIONS)
  .describe("Positionen in printed order; prices per priceMode.");

/** Input fields of `sevdesk_invoice_create_draft` (without `dryRun`). */
export const invoiceCreateInputShape = {
  contactId: contactIdInput,
  positions: positionsInput,
  date: documentDateInput.describe("Rechnungsdatum, YYYY-MM-DD; default today (Europe/Berlin)."),
  deliveryDate: deliveryDateInput,
  deliveryDateUntil: deliveryDateUntilInput,
  timeToPay: timeToPayInput,
  priceMode: priceModeInput,
  taxRuleId: taxRuleInput,
  taxText: taxTextInput,
  currency: currencyInput,
  header: headerInput.describe('Document title (Betreff); default "Rechnung".'),
  headText: headTextInput,
  footText: footTextInput,
  headTextTemplate: headTextTemplateInput,
  footTextTemplate: footTextTemplateInput,
  discount: discountInput.optional(),
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
  costCentre: costCentreInput,
};

/** Input fields of `sevdesk_invoice_update_draft` (without `dryRun`). */
export const invoiceUpdateInputShape = {
  id: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Id of the draft invoice (not its number), e.g. from sevdesk_invoices_list."),
  positions: positionsInput
    .optional()
    .describe("When given, replaces ALL positions; leave out to keep them."),
  contactId: contactIdInput.optional(),
  date: invoiceCreateInputShape.date.describe("Rechnungsdatum, YYYY-MM-DD."),
  deliveryDate: deliveryDateInput.describe("Liefer-/Leistungsdatum, YYYY-MM-DD."),
  deliveryDateUntil: deliveryDateUntilInput,
  timeToPay: timeToPayInput,
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
  headTextTemplate: headTextTemplateInput,
  footTextTemplate: footTextTemplateInput,
  discount: discountUpdateInput,
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
  ...costCentreUpdateInputShape,
};

export interface InvoiceCreateArgs extends CreateArgs, TextArgs {
  readonly positions: readonly PositionInput[];
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  readonly discount?: DiscountInput | undefined;
  readonly costCentre?: CostCentreArg | undefined;
}

export interface InvoiceUpdateArgs extends UpdateArgs, TextArgs {
  readonly id: number;
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  /** A new document discount, `null` to remove the stored one, left out to keep it. */
  readonly discount?: DiscountInput | null | undefined;
  readonly costCentre?: CostCentreArg | undefined;
  readonly removeCostCentre?: boolean | undefined;
}

/** What `execute` needs: the exact body the preview describes. */
export interface InvoiceDraftState {
  readonly body: SaveInvoiceBody;
  /** Set for updates: the invoice the save must keep. */
  readonly invoiceId?: number | undefined;
  /** Expected totals when the call set the positions or the discount. */
  readonly expected?: Amounts | undefined;
  /** The discount the call sent (`null`: removed), checked in the read-back. */
  readonly discount?: DraftDiscount | null | undefined;
}

export interface InvoiceDraftPlan {
  readonly preview: DraftPreview;
  readonly state: InvoiceDraftState;
}

/** Prepares a new draft invoice: validates, reads, builds the body and the preview. */
export async function prepareInvoiceCreate(
  client: SevdeskClient,
  args: InvoiceCreateArgs,
  options: DraftCallOptions,
): Promise<InvoiceDraftPlan> {
  const { signal } = options;
  const date = args.date ?? todayInBerlin();
  const delivery = resolveDeliveryPeriod(date, args.deliveryDate, args.deliveryDateUntil, true);
  const discount = args.discount === undefined ? undefined : resolveDiscount(args.discount);
  const centre =
    args.costCentre === undefined
      ? undefined
      : await resolveCostCentre(client, args.costCentre, signal);
  const texts = await resolveTemplateTexts(client, args, INVOICE_TEXT_TYPE, signal);
  const basics = await resolveCreateBasics(client, args, INVOICE_TAX_OPTIONS, options);
  const { contact, contactPerson, address, currency, mode } = basics;
  // With the document discount, which `basics.expected` leaves out.
  const expected = createTotals(basics.positions, mode, discount, currency);
  const duplicateQuery = { contactId: args.contactId, date, gross: expected.gross, currency };
  const duplicates = await findDuplicates(client, { kind: "invoice" }, duplicateQuery, signal);

  // The texts as resolved, a text template's included.
  const content = newInvoiceContent(
    { ...args, headText: texts.headText, footText: texts.footText },
    basics,
  );
  const header = content.header;
  const body = strictBody(
    saveInvoiceBodySchema,
    {
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        invoiceType: "RE",
        status: 100,
        invoiceDate: wireDocumentDate(date),
        deliveryDate: wireTimestamp(delivery.from),
        deliveryDateUntil: delivery.until === undefined ? undefined : wireTimestamp(delivery.until),
        ...content,
        // Not part of `newInvoiceContent`: recurring templates do not take a cost centre.
        costCentre: centre === undefined ? undefined : costCentreRef(centre.id),
      },
      invoicePosSave: newInvoicePositions(basics),
      invoicePosDelete: null,
      ...createDiscountBody(discount),
    },
    "invoice",
  );

  const facts: PreviewFact[] = [
    fact("Customer", customerText(contact.contact.displayName, args.contactId)),
    fact("Address", addressText(address)),
    fact("Invoice date", date),
    fact("Delivery date", formatPeriod(delivery)),
    ...(args.timeToPay === undefined ? [] : [fact("Payment term", `${args.timeToPay} days`)]),
    fact("Contact person", `${contactPerson.name} (user ${contactPerson.id})`),
    fact("Title", header),
    ...texts.facts,
    fact("Prices entered as", mode),
    fact("Tax", taxText(basics.rule, basics.tax)),
    fact("Tax text", basics.tax.taxText),
    ...(centre === undefined ? [] : [fact("Cost centre (Kostenstelle)", costCentreLabel(centre))]),
    ...positionFacts(basics.positions, mode, currency),
    ...(discount === undefined ? [] : [fact("Discount", discountText(discount, currency))]),
    fact("Total (expected)", totalsText(expected, currency)),
  ];
  const taxHint = invoiceTaxRuleHint(
    basics.rule.id,
    basics.regime,
    contact.contact,
    address.countryCode,
  );
  const preview = draftPreview(
    `Create a draft invoice (Rechnungsentwurf) for ` +
      `${customerText(contact.contact.displayName, args.contactId)} with ` +
      `${positionCount(basics.positions.length)}, gross ${moneyText(expected.gross, currency)}.`,
    facts,
    [duplicateWarning("invoice", duplicates, duplicateQuery), ...basics.warnings, taxHint],
  );
  return { preview, state: { body, expected, discount } };
}

/** Prepares an update of a draft invoice. */
export async function prepareInvoiceUpdate(
  client: SevdeskClient,
  args: InvoiceUpdateArgs,
  options: DraftCallOptions,
): Promise<InvoiceDraftPlan> {
  const { signal } = options;
  const given = assertChanges(args, "invoice", COST_CENTRE_FLAGS);
  const current = await loadCurrentInvoice(client, args.id, signal);
  const doc = current.document;
  checkUpdatable(doc);
  const centre = await costCentreUpdate(
    client,
    args,
    { storedId: doc.costCentre?.id, given },
    signal,
  );
  const texts = await resolveTemplateTexts(client, args, INVOICE_TEXT_TYPE, signal);
  const discounts = await readDocumentDiscounts(client, "invoice", doc.id, signal);
  const change = planDiscountChange(args.discount, discounts, `Invoice ${doc.id}`);

  const basics = await resolveUpdateBasics(
    client,
    doc,
    structuredStoredAddress(doc),
    current.positions,
    args,
    {
      scope: INVOICE_SCOPE,
      useCase:
        doc.propertyIsEInvoice === true ? { label: "e-invoices", noun: "invoice" } : undefined,
    },
    options,
  );

  const storedDate = berlinDay(doc.invoiceDate);
  const date = args.date ?? storedDate ?? todayInBerlin();
  const storedDelivery = berlinDay(doc.deliveryDate);
  const storedUntil = berlinDay(doc.deliveryDateUntil);
  const delivery = resolveDeliveryPeriod(
    date,
    args.deliveryDate ?? storedDelivery ?? date,
    args.deliveryDateUntil ?? storedUntil,
    true,
  );
  const totals = updateTotals({
    change,
    positions: basics.positions,
    storedPositions: current.positions,
    mode: basics.mode,
    currency: basics.currency,
    currencyChanged: basics.currencyChanged,
    stored: doc,
    eInvoice: doc.propertyIsEInvoice === true,
  });
  const expected = totals.expected;

  const body = strictBody(
    saveInvoiceBodySchema,
    {
      invoice: {
        id: doc.id,
        objectName: "Invoice",
        mapAll: true,
        invoiceNumber: storedNumber(doc.invoiceNumber),
        invoiceType: "RE",
        status: 100,
        contact: ref(basics.contact.contact.id, "Contact"),
        contactPerson: ref(basics.contactPerson.id, "SevUser"),
        invoiceDate: wireDocumentDate(date),
        deliveryDate: wireTimestamp(delivery.from),
        deliveryDateUntil: delivery.until === undefined ? undefined : wireTimestamp(delivery.until),
        header: args.header ?? doc.header,
        headText: texts.headText ?? doc.headText,
        footText: texts.footText ?? doc.footText,
        timeToPay: args.timeToPay ?? doc.timeToPay,
        discount: wireNumber(doc.discount ?? "0", "the stored cash discount (Skonto)"),
        discountTime: doc.discountTime,
        currency: basics.currency,
        showNet: basics.mode === "net",
        ...basics.tax,
        ...updatedAddressFields(doc, basics.address),
        customerInternalNote: doc.customerInternalNote,
        paymentMethod: storedRef(doc.paymentMethod, "PaymentMethod"),
        costCentre: costCentreUpdatePayload(centre, doc.costCentre?.id),
        origin:
          doc.origin === undefined
            ? undefined
            : { id: doc.origin.id, objectName: doc.origin.objectName },
        propertyIsEInvoice: doc.propertyIsEInvoice,
      },
      invoicePosSave:
        basics.positions === undefined
          ? null
          : basics.positions.map((position, index) =>
              positionPayload(position, index, "InvoicePos"),
            ),
      invoicePosDelete:
        basics.positions === undefined || current.positions.length === 0
          ? null
          : current.positions.map((row) => ref(row.id, "InvoicePos")),
      ...change.body,
    },
    "invoice",
  );

  const log = new ChangeLog();
  logRecipientChanges(log, doc, basics);
  log.value("date", "Invoice date", storedDate, date);
  log.value(
    "delivery date",
    "Delivery date",
    storedDelivery === undefined
      ? undefined
      : formatPeriod({ from: storedDelivery, until: storedUntil }),
    formatPeriod(delivery),
  );
  log.value(
    "payment term",
    "Payment term",
    doc.timeToPay === undefined ? undefined : `${doc.timeToPay} days`,
    args.timeToPay === undefined
      ? doc.timeToPay === undefined
        ? undefined
        : `${doc.timeToPay} days`
      : `${args.timeToPay} days`,
  );
  logContactPersonChange(log, doc, basics);
  logTextChanges(log, doc.header, { ...args, ...texts });
  logPricingChanges(log, doc, basics, current.positions.length);
  if (centre !== undefined) {
    log.value("cost centre", "Cost centre (Kostenstelle)", ...costCentreChange(centre));
  }
  const keptDiscount = logDiscountChange(log, change, discounts.rows, basics.currency);

  // The tax rule is judged again only when the call changes what it depends on.
  const taxHint =
    basics.rule !== undefined &&
    (args.taxRuleId !== undefined || basics.contactChanged || basics.address !== undefined)
      ? invoiceTaxRuleHint(
          basics.rule.id,
          basics.regime,
          basics.contact.contact,
          basics.address?.countryCode ??
            (await storedCountryCode(client, doc.addressCountry?.id, options)),
        )
      : undefined;

  const customer = customerText(basics.contact.contact.displayName, basics.contact.contact.id);
  const facts: PreviewFact[] = [
    fact("Invoice", `${doc.id} (${numberLabel(doc.invoiceNumber)}, draft)`),
    fact("Customer", customer),
    ...log.facts,
    ...texts.facts,
    ...(basics.positions === undefined
      ? []
      : positionFacts(basics.positions, basics.mode, basics.currency)),
    ...keptDiscount,
    updateTotalFact(totals, doc, basics.currency),
  ];
  const preview = draftPreview(
    `Update draft invoice ${doc.id} for ${customer}: change ${log.changed.join(", ") || "nothing visible"}.`,
    facts,
    [...basics.warnings, taxHint, totals.warning],
  );
  return {
    preview,
    state: { body, invoiceId: doc.id, expected, discount: change.planned },
  };
}

/** Result of a saved invoice draft: the read-back invoice and trusted notes. */
export interface InvoiceDraftResult {
  readonly id: number;
  readonly details: InvoiceDetails;
  readonly notes: readonly string[];
}

/** Sends the prepared body (one request, never retried) and reads the invoice back. */
export async function executeInvoiceDraft(
  client: SevdeskClient,
  state: InvoiceDraftState,
  options: CountryReadOptions,
): Promise<InvoiceDraftResult> {
  const { signal, cacheOwner } = options;
  const response = await client.request({
    method: "POST",
    path: "/Invoice/Factory/saveInvoice",
    body: state.body,
    ...(signal === undefined ? {} : { signal }),
  });
  const id = savedDocumentId(response, "invoice", "invoice");
  const saved = { objectName: "Invoice", id: String(id) };
  if (state.invoiceId !== undefined && id !== state.invoiceId) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk saved invoice ${id} instead of updating invoice ${state.invoiceId}. Check ` +
        "both drafts in sevDesk and delete the extra one there before repeating the call.",
      completedWrites: [saved],
    });
  }
  const details = await readBack(saved, () =>
    getInvoice(client, id, { signal, cacheOwner, withDiscount: true }),
  );
  const discountNote = discountReadBackNote(state.discount, details.discount, "invoice");
  const notes = [
    ...readBackNotes(
      {
        number: details.invoice.number,
        gross: details.invoice.totals.gross?.amount,
        currency: details.invoice.currency,
        positionsComplete: details.positionsComplete,
      },
      { noun: "invoice", finalizeTool: FINALIZE_TOOL, expected: state.expected },
    ),
    ...(discountNote === undefined ? [] : [discountNote]),
  ];
  return { id, details, notes };
}

/** The ISO code of the stored address's country (cached country list); undefined when unknown. */
async function storedCountryCode(
  client: SevdeskClient,
  countryId: number | undefined,
  options: DraftCallOptions,
): Promise<string | undefined> {
  if (countryId === undefined) return undefined;
  const codes = await loadCountryCodes(client, {
    cacheOwner: options.cacheOwner,
    signal: options.signal,
  });
  return codes.get(countryId);
}

/**
 * Only regular draft invoices that are not enshrined can be updated here. The type is checked
 * before the status, so a recurring template (WKR) at any status is pointed to its own tool
 * instead of being told to reset it to a draft, which the reset tool refuses for templates.
 */
function checkUpdatable(doc: {
  readonly id: number;
  readonly status: number;
  readonly invoiceType?: string | undefined;
  readonly enshrined?: unknown;
}): void {
  if (berlinDay(doc.enshrined) !== undefined) {
    throw new SevdeskError({
      kind: "validation",
      message: `Invoice ${doc.id} is enshrined (festgeschrieben) and can no longer be changed.`,
    });
  }
  const type = doc.invoiceType?.trim().toUpperCase() ?? "RE";
  if (type !== "RE") {
    const known = documentTypeByCode("invoice", type);
    const instead =
      type === "WKR"
        ? "Change a recurring invoice template with sevdesk_invoice_update_recurring."
        : "Edit it in sevDesk.";
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${doc.id} is ${known === undefined ? "not a regular invoice" : `a ${known.label.toLowerCase()} (${known.code})`}; ` +
        `this tool only changes regular invoices (RE). ${instead}`,
    });
  }
  if (doc.status !== 100) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${doc.id} is not a draft (status: ${statusDto("invoice", doc.status).label}); ` +
        'only drafts can be changed. Reset it to a draft first with sevdesk_invoice_reset (to: "draft") ' +
        "or cancel it with sevdesk_invoice_cancel.",
    });
  }
}
