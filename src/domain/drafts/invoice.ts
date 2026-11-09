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
 * `discount: 0` (required: "Otherwise provide zero"), `taxRate: 0`, `invoicePosDelete: null` and
 * none of the optional trailing parameters (`discountSave`, `discountDelete`,
 * `takeDefaultAddress`), which that accepted request did not send.
 *
 * Update body: every writable field the server knows, stored values carried over (see
 * `current.ts`), the stored number unchanged, and either no position changes
 * (`invoicePosSave`/`invoicePosDelete` null) or all stored positions deleted and the new ones
 * saved in the same request, so a failure cannot leave half the positions behind.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { statusDto } from "../common.js";
import { getInvoice, type InvoiceDetails } from "../invoices.js";
import { documentTypeByCode } from "../reference-data.js";
import { berlinDay, type CurrentInvoice, loadCurrentInvoice } from "./current.js";
import {
  assertChanges,
  ChangeLog,
  draftPreview,
  numberLabel,
  positionCount,
  ref,
  storedNumber,
  storedRef,
  storedTotalText,
  structuredAddress,
  taxText,
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
  expectedTotals,
  MAX_POSITIONS,
  type PositionInput,
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
  addressBlock,
  type CreateArgs,
  type DraftCallOptions,
  resolveCreateBasics,
  resolveUpdateBasics,
  type StoredAddress,
  type UpdateArgs,
} from "./shared.js";
import { DEFAULT_TAX_RULE_ID, type RuleScope, SALES_TAX_RULE_IDS } from "./tax.js";

const INVOICE_SCOPE: RuleScope = { allowedRuleIds: SALES_TAX_RULE_IDS, documents: "invoices" };
const DEFAULT_HEADER = "Rechnung";
const FINALIZE_TOOL = "sevdesk_invoice_finalize";

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
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
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
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
};

export interface InvoiceCreateArgs extends CreateArgs {
  readonly positions: readonly PositionInput[];
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

export interface InvoiceUpdateArgs extends UpdateArgs {
  readonly id: number;
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

/** What `execute` needs: the exact body the preview describes. */
export interface InvoiceDraftState {
  readonly body: SaveInvoiceBody;
  /** Set for updates: the invoice the save must keep. */
  readonly invoiceId?: number | undefined;
  /** Expected totals when the call set the positions. */
  readonly expected?: Amounts | undefined;
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
  const basics = await resolveCreateBasics(
    client,
    args,
    { scope: INVOICE_SCOPE, defaultRuleId: DEFAULT_TAX_RULE_ID },
    options,
  );
  const { contact, contactPerson, address, currency, expected, mode } = basics;
  const duplicateQuery = { contactId: args.contactId, date, gross: expected.gross, currency };
  const duplicates = await findDuplicates(client, { kind: "invoice" }, duplicateQuery, signal);

  const header = args.header ?? DEFAULT_HEADER;
  const body = strictBody(
    saveInvoiceBodySchema,
    {
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        invoiceType: "RE",
        status: 100,
        contact: ref(args.contactId, "Contact"),
        contactPerson: ref(contactPerson.id, "SevUser"),
        invoiceDate: wireDocumentDate(date),
        deliveryDate: wireTimestamp(delivery.from),
        deliveryDateUntil: delivery.until === undefined ? undefined : wireTimestamp(delivery.until),
        header,
        headText: args.headText,
        footText: args.footText,
        timeToPay: args.timeToPay,
        discount: 0,
        currency,
        showNet: mode === "net",
        ...basics.tax,
        ...structuredAddress(address),
      },
      invoicePosSave: basics.positions.map((position, index) =>
        positionPayload(position, index, "InvoicePos"),
      ),
      invoicePosDelete: null,
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
    fact("Prices entered as", mode),
    fact("Tax", taxText(basics.rule, basics.tax)),
    fact("Tax text", basics.tax.taxText),
    ...positionFacts(basics.positions, mode, currency),
    fact("Total (expected)", totalsText(expected, currency)),
  ];
  const preview = draftPreview(
    `Create a draft invoice (Rechnungsentwurf) for ` +
      `${customerText(contact.contact.displayName, args.contactId)} with ` +
      `${positionCount(basics.positions.length)}, gross ${moneyText(expected.gross, currency)}.`,
    facts,
    [duplicateWarning("invoice", duplicates, duplicateQuery), ...basics.warnings],
  );
  return { preview, state: { body, expected } };
}

/** Prepares an update of a draft invoice. */
export async function prepareInvoiceUpdate(
  client: SevdeskClient,
  args: InvoiceUpdateArgs,
  options: DraftCallOptions,
): Promise<InvoiceDraftPlan> {
  const { signal } = options;
  assertChanges(args, "invoice");
  const current = await loadCurrentInvoice(client, args.id, signal);
  const doc = current.document;
  checkUpdatable(doc);

  const basics = await resolveUpdateBasics(
    client,
    doc,
    invoiceStoredAddress(doc),
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
  const expected =
    basics.positions === undefined ? undefined : expectedTotals(basics.positions, basics.mode);

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
        headText: args.headText ?? doc.headText,
        footText: args.footText ?? doc.footText,
        timeToPay: args.timeToPay ?? doc.timeToPay,
        discount: wireNumber(doc.discount ?? "0", "the stored cash discount (Skonto)"),
        discountTime: doc.discountTime,
        currency: basics.currency,
        showNet: basics.mode === "net",
        ...basics.tax,
        ...(basics.address === undefined
          ? {
              address: doc.address,
              addressName: doc.addressName,
              addressStreet: doc.addressStreet,
              addressZip: doc.addressZip,
              addressCity: doc.addressCity,
              addressCountry: storedRef(doc.addressCountry, "StaticCountry"),
            }
          : { address: addressBlock(basics.address), ...structuredAddress(basics.address) }),
        customerInternalNote: doc.customerInternalNote,
        paymentMethod: storedRef(doc.paymentMethod, "PaymentMethod"),
        costCentre: storedRef(doc.costCentre, "CostCentre"),
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
    },
    "invoice",
  );

  const log = new ChangeLog();
  if (basics.contactChanged) {
    log.value(
      "contact",
      "Customer",
      `contact ${doc.contact?.id ?? "none"}`,
      `contact ${basics.contact.contact.id}`,
    );
  }
  if (basics.address !== undefined) {
    log.value("address", "Address", basics.addressBefore, addressText(basics.address));
  }
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
  if (basics.contactPersonChanged) {
    log.value(
      "contact person",
      "Contact person",
      doc.contactPerson === undefined ? undefined : `user ${doc.contactPerson.id}`,
      `${basics.contactPerson.name ?? "user"} (user ${basics.contactPerson.id})`,
    );
  }
  if (args.header !== undefined) log.value("title", "Title", doc.header, args.header);
  if (args.headText !== undefined) log.note("intro text", "Intro text", "replaced");
  if (args.footText !== undefined) log.note("closing text", "Closing text", "replaced");
  if (basics.modeChanged) {
    log.value(
      "price mode",
      "Prices entered as",
      basics.mode === "net" ? "gross" : "net",
      basics.mode,
    );
  }
  if (basics.taxChanged)
    log.note(
      "tax",
      "Tax",
      `${taxText(basics.rule, basics.tax)}; text: ${basics.tax.taxText ?? "(none)"}`,
    );
  if (basics.currencyChanged) log.value("currency", "Currency", doc.currency, basics.currency);
  if (basics.positions !== undefined) {
    log.note(
      "positions",
      "Positions",
      `replace ${positionCount(current.positions.length)} with ${positionCount(basics.positions.length)}`,
    );
  }

  const customer = customerText(basics.contact.contact.displayName, basics.contact.contact.id);
  const facts: PreviewFact[] = [
    fact("Invoice", `${doc.id} (${numberLabel(doc.invoiceNumber)}, draft)`),
    fact("Customer", customer),
    ...log.facts,
    ...(basics.positions === undefined
      ? []
      : positionFacts(basics.positions, basics.mode, basics.currency)),
    expected === undefined
      ? fact("Total (unchanged)", storedTotalText(doc))
      : fact("Total (expected)", totalsText(expected, basics.currency)),
  ];
  const preview = draftPreview(
    `Update draft invoice ${doc.id} for ${customer}: change ${log.changed.join(", ") || "nothing visible"}.`,
    facts,
    basics.warnings,
  );
  return { preview, state: { body, invoiceId: doc.id, expected } };
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
  signal?: AbortSignal,
): Promise<InvoiceDraftResult> {
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
  const details = await readBack(saved, () => getInvoice(client, id, signal));
  const notes = readBackNotes(
    {
      number: details.invoice.number,
      gross: details.invoice.totals.gross?.amount,
      currency: details.invoice.currency,
      positionsComplete: details.positionsComplete,
    },
    { noun: "invoice", finalizeTool: FINALIZE_TOOL, expected: state.expected },
  );
  return { id, details, notes };
}

/**
 * The stored address of an invoice: its structured fields when any is set (drafts saved through
 * the API), else the free-text `address` (web-app drafts), else none.
 */
function invoiceStoredAddress(doc: CurrentInvoice): StoredAddress {
  const countryId = doc.addressCountry?.id;
  const parts = {
    name: doc.addressName,
    street: doc.addressStreet,
    zip: doc.addressZip,
    city: doc.addressCity,
  };
  if (Object.values(parts).some((part) => part !== undefined)) {
    const place = [parts.zip, parts.city].filter((part) => part !== undefined).join(" ");
    return {
      base: { kind: "parts", parts: { ...parts, countryId } },
      lines: [parts.name, parts.street, place],
      countryId,
    };
  }
  if (doc.address !== undefined) {
    return { base: { kind: "text", countryId }, lines: [doc.address], countryId };
  }
  return { base: { kind: "none" }, lines: [], countryId };
}

/** Only regular draft invoices that are not enshrined can be updated here. */
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
  if (doc.status !== 100) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${doc.id} is not a draft (status: ${statusDto("invoice", doc.status).label}); ` +
        'only drafts can be changed. Reset it to a draft first with sevdesk_invoice_reset (to: "draft") ' +
        "or cancel it with sevdesk_invoice_cancel.",
    });
  }
  const type = doc.invoiceType?.trim().toUpperCase() ?? "RE";
  if (type !== "RE") {
    const known = documentTypeByCode("invoice", type);
    throw new SevdeskError({
      kind: "validation",
      message:
        `Invoice ${doc.id} is ${known === undefined ? "not a regular invoice" : `a ${known.label.toLowerCase()} (${known.code})`}; ` +
        "this tool only changes regular invoices (RE). Edit it in sevDesk.",
    });
  }
}
