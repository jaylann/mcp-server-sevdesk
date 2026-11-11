/**
 * Documents sevDesk derives from other documents (Factory endpoints), behind
 * `sevdesk_invoice_create_from_order`, `sevdesk_credit_note_create_from_invoice` and
 * `sevdesk_invoice_create_reminder`. Each creates a draft; numbers, positions and totals are
 * sevDesk's (B4: no number is ever invented here), and nothing becomes binding until the draft is
 * finalized with the lifecycle tools.
 *
 * Endpoints and evidence:
 * - `POST /Invoice/Factory/createInvoiceFromOrder`, body `Model_CreateInvoiceFromOrder`
 *   `{order: {id, objectName: "Order"}, partialType: RE | TR | AR, type: percentage | net | gross,
 *   amount}`; only `order` is required (D-010). Update 2.0 creates advance (AR) and partial (TR)
 *   invoices only with tax rule 1 or 11 (spec section "sevdesk-Update 2.0"). The answer is the new
 *   invoice wrapped in `objects` (D-001); a nested `{invoice: …}` is accepted too.
 * - `POST /CreditNote/Factory/createFromInvoice`, body `{invoice: {id, objectName: "Invoice"}}`;
 *   the answer is `{creditNote, creditNotePos, discount}` per the spec, and sevdesk-rs
 *   (https://github.com/jernoxit/sevdesk-rs, `tests/number_probe/calls.rs`, live) reads the id
 *   from `creditNote.id` or `id`; both are accepted. The credit note's `origin` is the invoice.
 *   It gives the draft the credit note counter's current value without advancing the counter
 *   (recorded 2026-11-07: draft GU-1000, and a credit note finalized 11 s later got GU-1000 too),
 *   so afterwards the counter is moved past the new number when it still points at it
 *   (`getNextCreditNoteNumber`, `useNextNumber=true`, see `drafts/numbering.ts`).
 * - `POST /Invoice/Factory/createInvoiceReminder` with `invoice[id]`/`invoice[objectName]` in
 *   the query AND `{invoice}` in the body (the spec requires both); the answer is the reminder
 *   (invoice type MA) wrapped in `objects` (j-mastr/sevdesk-api#12). Update 2.0 rejects a
 *   reminder fee (`reminderCharge` > 0), so none is sent.
 *
 * Guards before writing:
 * - Duplicates (a retried call must not create a second draft): drafts already derived from the
 *   same source are refused unless `allowDuplicate`. Invoices from an order come from
 *   `getRelatedObjects`; reminders from `GET /Invoice` filtered by contact and `origin[id]`;
 *   credit notes from `GET /CreditNote` filtered by contact only (see
 *   {@link findCreditNotesForInvoice}: underachievement credit notes have `refSrcInvoice` but no
 *   `origin`, D-039). Every row is re-checked locally, since sevDesk ignores filters it does not
 *   know (D-035).
 * - Cancelled invoices: a cancelled original keeps status 1000 with nothing paid and does not
 *   point to its cancellation; only the cancellation invoice (type SR) points back through
 *   `origin` (D-037, sevdesk-rs recordings). {@link checkInvoiceCreditable} looks for that SR, so a
 *   cancelled invoice is never credited a second time.
 *
 * After writing, the new document is read back and must be a draft (status 100) of the expected
 * type; otherwise the call fails with the document in `completedWrites` instead of claiming a
 * draft. The source document is read again too and listed in `affected` when sevDesk changed it
 * (e.g. the order's status).
 */
import { z } from "zod";

import type {
  ConfirmationFact,
  ConfirmationPreview,
  SevdeskObjectRef,
} from "../safety/write-types.js";
import { berlinDateOf } from "../sevdesk/dates.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { type CompletedWrite, SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId, zIntish, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import { type CreditNoteDetails, getCreditNote } from "./credit-notes.js";
import type { DocumentTotals } from "./document-positions.js";
import {
  findCreditNotesWithNumber,
  peekNextNumber,
  quotableNumber,
  reserveNextNumber,
} from "./drafts/numbering.js";
import {
  getInvoice,
  type InvoiceDetail,
  type InvoiceDetails,
  mapInvoiceDetail,
} from "./invoices.js";
import { compare, format } from "./money.js";
import { getOrder, mapOrderDetail, type OrderDetail } from "./orders.js";
import { jsonNumber } from "./parts-write.js";

const DISPLAY_MAX = 200;
/** Rows read when looking for documents derived from the same source. */
const DERIVED_SCAN_MAX = 5000;
const SCAN_PAGE_SIZE = 1000;
/** Update 2.0 tax rules that allow advance (AR) and partial (TR) invoices. */
const PARTIAL_TAX_RULES: ReadonlySet<number> = new Set([1, 11]);
/** Invoice types that are real receivables (not cancellations, reminders or templates). */
const REVENUE_INVOICE_TYPES: ReadonlySet<string> = new Set(["RE", "AR", "TR", "ER"]);

// ---------------------------------------------------------------------------------------------
// Invoice from order
// ---------------------------------------------------------------------------------------------

/** full: the whole order (RE); partial: Teilrechnung (TR); advance: Abschlagsrechnung (AR). */
type OrderInvoiceMode = "full" | "partial" | "advance";
type OrderAmountType = "percentage" | "net" | "gross";

const PARTIAL_TYPES: Readonly<Record<OrderInvoiceMode, "RE" | "TR" | "AR">> = {
  full: "RE",
  partial: "TR",
  advance: "AR",
};

/**
 * Invoice types the read-back may show per mode. `partialType: RE` is documented as
 * "Schlussrechnung", so a full invoice after advance invoices may come back as ER (final invoice).
 */
const EXPECTED_TYPES: Readonly<Record<OrderInvoiceMode, readonly string[]>> = {
  full: ["RE", "ER"],
  partial: ["TR"],
  advance: ["AR"],
};

const MODE_LABELS: Readonly<Record<OrderInvoiceMode, string>> = {
  full: "invoice for the whole order (Rechnung)",
  partial: "partial invoice (Teilrechnung)",
  advance: "advance invoice (Abschlagsrechnung)",
};

const orderToInvoicePayloadSchema = z.strictObject({
  order: z.strictObject({ id: z.number().int().positive(), objectName: z.literal("Order") }),
  partialType: z.enum(["RE", "TR", "AR"]),
  type: z.enum(["percentage", "net", "gross"]).optional(),
  amount: z.number().positive().optional(),
});

export interface OrderToInvoiceInput {
  readonly orderId: number;
  readonly mode: OrderInvoiceMode;
  /** Exact decimal string; required for partial and advance invoices. */
  readonly amount?: string | undefined;
  readonly amountType: OrderAmountType;
  readonly allowDuplicate: boolean;
}

export interface OrderToInvoiceState {
  readonly orderId: number;
  readonly payload: z.output<typeof orderToInvoicePayloadSchema>;
  /** Invoice types the new draft may have (see {@link EXPECTED_TYPES}). */
  readonly expectedTypes: readonly string[];
  /** The order as `prepare` saw it, to tell whether sevDesk changed it. */
  readonly orderFingerprint: string;
}

/**
 * Checks that the order can be invoiced (an offer or order confirmation, sent or accepted or
 * partly invoiced; amounts within the order; AR/TR only with tax rule 1 or 11; no invoice draft
 * from it yet) and builds the preview. Reads only.
 */
export async function planOrderToInvoice(
  client: SevdeskClient,
  input: OrderToInvoiceInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: OrderToInvoiceState }> {
  const orderId = toSevdeskId(input.orderId);
  const details = await getOrder(client, orderId, signal);
  const { order } = details;
  const label = documentLabel("Order", order.id, order.number);
  const ref = `Order ${String(order.id)}`;

  if (order.type.code !== "AN" && order.type.code !== "AB") {
    throw validation(
      `${ref} is a ${order.type.label.toLowerCase()} (${order.type.code}); only offers (AN) and ` +
        "order confirmations (AB) can be turned into an invoice. Use the offer or confirmation " +
        "it belongs to, or create the invoice with sevdesk_invoice_create_draft.",
    );
  }
  switch (order.status.code) {
    case 100:
      throw validation(
        `${ref} is still a draft. Finalize it first (sevdesk_order_finalize), or create the ` +
          "invoice draft directly with sevdesk_invoice_create_draft.",
      );
    case 300:
      throw validation(`${ref} was rejected (status 300); a rejected order is not invoiced.`);
    case 1000:
      throw validation(
        `${ref} is already fully invoiced (status 1000, Berechnet). sevdesk_order_get lists ` +
          "the invoices created from it.",
      );
    case 200:
    case 500:
    case 750:
      break;
    default:
      throw validation(
        `${ref} has status ${order.status.code}, which this tool does not know; only sent ` +
          "(200), accepted (500) or partially invoiced (750) orders are invoiced.",
      );
  }

  const partial = input.mode !== "full";
  if (partial && input.amount === undefined) {
    throw validation(`mode ${input.mode} needs amount (with amountType percentage, net or gross).`);
  }
  if (!partial && input.amount !== undefined) {
    throw validation(
      "amount only applies to partial and advance invoices; leave it out to invoice the whole " +
        "order, or set mode to partial or advance.",
    );
  }
  if (partial && input.amount !== undefined) {
    checkOrderAmount(input.amount, input.amountType, order.totals, ref);
  }
  const ruleId = order.tax.rule?.id;
  if (partial && ruleId !== undefined && !PARTIAL_TAX_RULES.has(ruleId)) {
    throw validation(
      `${ref} uses tax rule ${ruleId}; sevDesk creates advance and partial invoices only with ` +
        "tax rule 1 (Umsatzsteuerpflichtige Umsätze) or 11 (Kleinunternehmer). Invoice the " +
        "whole order instead (mode full).",
    );
  }

  const drafts = (details.related ?? []).filter(
    (doc) => doc.objectName === "Invoice" && doc.status?.code === 100,
  );
  if (drafts.length > 0 && !input.allowDuplicate) {
    throw validation(
      `An invoice draft from ${ref} exists already: ${idList(
        "invoice",
        drafts.map((doc) => doc.id),
      )}. ` +
        "Finish or delete that draft (sevdesk_invoice_get), or call again with allowDuplicate: " +
        "true to create another one.",
    );
  }

  const payload = orderToInvoicePayloadSchema.parse({
    order: { id: orderId, objectName: "Order" },
    partialType: PARTIAL_TYPES[input.mode],
    ...(partial && input.amount !== undefined
      ? { type: input.amountType, amount: jsonNumber(input.amount) }
      : {}),
  });

  const facts: ConfirmationFact[] = [
    { label: "Order", value: `${label} (${order.type.labelDe ?? order.type.label})` },
    ...customerFact(order.contact),
    ...totalsFacts("Order", order.totals, order.currency),
    { label: "Creates", value: MODE_LABELS[input.mode] },
  ];
  if (partial && input.amount !== undefined) {
    facts.push({
      label: "Amount",
      value:
        input.amountType === "percentage"
          ? `${input.amount} % of the order`
          : `${format(input.amount, 2)} ${order.currency} ${input.amountType}`,
    });
  }
  const warnings = [
    "The invoice is created as a draft (Entwurf) with the order's positions; check it with " +
      "sevdesk_invoice_get and finalize it with sevdesk_invoice_finalize.",
  ];
  if (drafts.length > 0) {
    warnings.push(
      `Creating it anyway (allowDuplicate): ${idList(
        "invoice draft",
        drafts.map((doc) => doc.id),
      )} from this order exists already.`,
    );
  }
  if (details.related === undefined) {
    warnings.push(
      "sevDesk did not list the order's related documents, so earlier invoice drafts could not be checked.",
    );
  }
  if (partial && order.currency !== "EUR") {
    warnings.push(
      "sevDesk refuses advance and partial invoices in a currency other than the account's " +
        "default currency.",
    );
  }
  if (!details.positionsComplete) {
    warnings.push(
      "sevDesk had more order positions than could be read; the totals shown are sevDesk's.",
    );
  }
  const earlier = (details.related ?? []).filter(
    (doc) => doc.objectName === "Invoice" && doc.status?.code !== 100,
  );
  if (partial && (earlier.length > 0 || order.status.code === 750)) {
    const which =
      earlier.length === 0
        ? ""
        : ` (${idList(
            "invoice",
            earlier.map((doc) => doc.id),
          )})`;
    warnings.push(
      `Invoices from this order exist already${which}: the amount is checked against the whole ` +
        "order, not against what is still open on it. Check the earlier invoices with " +
        "sevdesk_order_get before invoicing more.",
    );
  }
  return {
    preview: {
      action: `Create a draft ${MODE_LABELS[input.mode]} from ${label}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: {
      orderId,
      payload,
      expectedTypes: EXPECTED_TYPES[input.mode],
      orderFingerprint: orderFingerprint(order),
    },
  };
}

/**
 * Sends `createInvoiceFromOrder` (never retried), reads the new invoice back and checks that it
 * is a draft of the expected type, then reads the order again: it is listed in `affected` (with
 * its new status) when sevDesk changed it, or when that could not be read.
 */
export async function executeOrderToInvoice(
  client: SevdeskClient,
  state: OrderToInvoiceState,
  signal?: AbortSignal,
): Promise<{
  details: InvoiceDetails;
  affected: SevdeskObjectRef[];
  order: OrderDetail | undefined;
}> {
  const answer = await client.request({
    method: "POST",
    path: "/Invoice/Factory/createInvoiceFromOrder",
    body: state.payload,
    ...(signal === undefined ? {} : { signal }),
  });
  const invoiceId = createdDocumentId(answer, "invoice", "the created invoice");
  const created = [{ objectName: "Invoice", id: String(invoiceId) }];
  const details = await readBack(() => getInvoice(client, invoiceId, signal), created);
  const order = await readQuietly(() => readOrder(client, state.orderId, signal));
  const affected = [
    ...created,
    ...(order === undefined || orderFingerprint(order) !== state.orderFingerprint
      ? [{ objectName: "Order", id: String(state.orderId) }]
      : []),
  ];
  verifyDraft(
    { what: "invoice", id: invoiceId, tool: "sevdesk_invoice_get" },
    details.invoice.status.code,
    [
      ...typeProblem(details.invoice.type.code, state.expectedTypes),
      ...(details.invoice.origin?.objectName === "Order" &&
      details.invoice.origin.id !== state.orderId
        ? ["it points to another order"]
        : []),
    ],
    affected,
  );
  return { details, affected, order };
}

/** The order's status, version and last update: what changes when sevDesk touches it. */
function orderFingerprint(order: OrderDetail): string {
  return JSON.stringify([order.status.code, order.version ?? null, order.updatedAt ?? null]);
}

async function readOrder(
  client: SevdeskClient,
  orderId: number,
  signal: AbortSignal | undefined,
): Promise<OrderDetail> {
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Order", orderId),
    query: { embed: "contact" },
    ...(signal === undefined ? {} : { signal }),
  });
  return mapOrderDetail(expectSingle(payload, `order ${orderId}`));
}

function checkOrderAmount(
  amount: string,
  type: OrderAmountType,
  totals: DocumentTotals["totals"],
  label: string,
): void {
  if (compare(amount, 0) <= 0) {
    throw validation("amount must be greater than 0.");
  }
  if (type === "percentage") {
    if (compare(amount, 100) > 0) throw validation("A percentage amount is at most 100.");
    return;
  }
  const total = type === "net" ? totals.net : totals.gross;
  if (total !== undefined && compare(amount, total.amount) > 0) {
    throw validation(
      `amount (${format(amount, 2)} ${type}) is more than the ${type} total of ${label} ` +
        `(${total.amount} ${total.currency}).`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Credit note from invoice
// ---------------------------------------------------------------------------------------------

const invoiceRefPayloadSchema = z.strictObject({
  invoice: z.strictObject({ id: z.number().int().positive(), objectName: z.literal("Invoice") }),
});

export interface CreditNoteFromInvoiceInput {
  readonly invoiceId: number;
  readonly allowDuplicate: boolean;
}

export interface CreditNoteFromInvoiceState {
  readonly invoiceId: number;
  readonly payload: z.output<typeof invoiceRefPayloadSchema>;
  /** The invoice as `prepare` saw it, to tell whether sevDesk changed it. */
  readonly invoiceFingerprint: string;
}

/**
 * Checks that a credit note can be derived from the invoice ({@link checkInvoiceCreditable}: a
 * finalized RE/AR/TR/ER that was not cancelled) and that none refers to it yet unless
 * `allowDuplicate` ({@link findCreditNotesForInvoice}), and builds the preview. Reads only.
 */
export async function planCreditNoteFromInvoice(
  client: SevdeskClient,
  input: CreditNoteFromInvoiceInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: CreditNoteFromInvoiceState }> {
  const invoiceId = toSevdeskId(input.invoiceId);
  const snapshot = await readInvoiceSnapshot(client, invoiceId, berlinDateOf(Date.now()), signal);
  const invoice = snapshot.detail;
  const label = documentLabel("Invoice", invoice.id, invoice.number);
  const ref = `Invoice ${String(invoice.id)}`;
  const checked = await checkInvoiceCreditable(client, invoice, signal);

  const existing = await findCreditNotesForInvoice(
    client,
    { invoiceId, contactId: invoice.contact?.id },
    signal,
  );
  if (existing.ids.length > 0 && !input.allowDuplicate) {
    throw validation(
      `A credit note for ${ref} exists already: ${idList("credit note", existing.ids)}. Check it ` +
        "with sevdesk_credit_note_get, or call again with allowDuplicate: true to create another " +
        "one (e.g. a second partial refund).",
    );
  }

  const facts: ConfirmationFact[] = [
    { label: "Invoice", value: `${label} (${invoice.status.label})` },
    ...customerFact(invoice.contact),
    ...totalsFacts("Invoice", invoice.totals, invoice.currency),
  ];
  if (invoice.paid !== undefined) {
    facts.push({ label: "Paid so far", value: `${invoice.paid.amount} ${invoice.paid.currency}` });
  }
  const warnings = [
    "The credit note (Gutschrift) is created as a draft with all positions of the invoice; adjust " +
      "it if only part is refunded, then finalize it with sevdesk_credit_note_finalize.",
    "sevDesk gives the draft the next credit note number without advancing its counter, so the " +
      "counter is moved past the new number afterwards; otherwise the next credit note could " +
      "get the same number.",
    ...checked.warnings,
  ];
  if (invoice.status.code !== 1000) {
    warnings.push(
      "The invoice is not fully paid: to void it completely, cancelling it (Storno, " +
        "sevdesk_invoice_cancel) is usually the right correction.",
    );
  }
  if (existing.ids.length > 0) {
    warnings.push(
      `Creating another one (allowDuplicate): ${idList("credit note", existing.ids)} exists already.`,
    );
  }
  if (existing.truncated) {
    warnings.push("Not every credit note could be checked for an earlier one from this invoice.");
  }
  return {
    preview: {
      action: `Create a credit note (Gutschrift) draft from ${label}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: {
      invoiceId,
      payload: invoiceRefPayloadSchema.parse({ invoice: { id: invoiceId, objectName: "Invoice" } }),
      invoiceFingerprint: snapshot.fingerprint,
    },
  };
}

/**
 * Sends `createFromInvoice` (never retried), reads the new credit note back and checks that it is
 * a draft that refers to the invoice; the invoice is listed in `affected` when sevDesk changed it.
 * Then moves the credit note counter past the new number ({@link advanceCreditNoteCounter});
 * what happened there is reported in `notes`.
 */
export async function executeCreditNoteFromInvoice(
  client: SevdeskClient,
  state: CreditNoteFromInvoiceState,
  signal?: AbortSignal,
): Promise<{ details: CreditNoteDetails; affected: SevdeskObjectRef[]; notes: string[] }> {
  const answer = await client.request({
    method: "POST",
    path: "/CreditNote/Factory/createFromInvoice",
    body: state.payload,
    ...(signal === undefined ? {} : { signal }),
  });
  const creditNoteId = createdDocumentId(answer, "creditNote", "the created credit note");
  const created = [{ objectName: "CreditNote", id: String(creditNoteId) }];
  const details = await readBack(() => getCreditNote(client, creditNoteId, signal), created);
  const affected = [
    ...created,
    ...(await sourceInvoiceChanges(client, state.invoiceId, state.invoiceFingerprint, signal)),
  ];
  // The credit note DTO has no type field; its link to the invoice is checked instead.
  verifyDraft(
    { what: "credit note", id: creditNoteId, tool: "sevdesk_credit_note_get" },
    details.creditNote.status.code,
    details.creditNote.sourceInvoiceId === state.invoiceId
      ? []
      : ["it does not refer to the invoice it was created from"],
    affected,
  );
  const notes = await advanceCreditNoteCounter(
    client,
    creditNoteId,
    details.creditNote.number,
    signal,
  );
  return { details, affected, notes };
}

/**
 * After `createFromInvoice`: when the credit note counter still offers the new draft's number
 * (peek, `useNextNumber=false`), reserves it once (`useNextNumber=true`, a write-tier side-effect
 * GET) so that the next credit note cannot get the same number. When the counter offers another
 * number, someone moved it since the draft got its number (the tools of this server run one at a
 * time on the number range, so that is the web app or another client), and whoever did may have
 * taken the same number: the credit notes are then checked for it ({@link sameNumberNotes}). The
 * credit note exists already, so a failure here never fails the call: it becomes a trusted note.
 * Returns the notes.
 */
async function advanceCreditNoteCounter(
  client: SevdeskClient,
  draftId: number,
  draftNumber: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (draftNumber === undefined) {
    return [
      "The new credit note has no number, so sevDesk's credit note counter was not checked; " +
        "sevdesk_credit_note_finalize refuses credit notes without a number (sevDesk can fail " +
        "half-way on them), so set one in the sevDesk web app first.",
    ];
  }
  const label = quotableNumber(draftNumber) ?? "the new draft's number";
  const range = { kind: "creditNote" } as const;
  const same = (number: string) => number.trim().toLowerCase() === draftNumber.trim().toLowerCase();
  try {
    if (!same(await peekNextNumber(client, range, signal))) {
      return await sameNumberNotes(client, draftId, draftNumber, label, signal);
    }
    const reserved = await reserveNextNumber(client, range, signal);
    if (!same(reserved)) {
      // The counter moved between the peek and the reservation (another client): the reserved
      // number is lost, and whoever took the draft's number may carry it as well.
      const taken = quotableNumber(reserved) ?? "another number";
      return [
        `sevDesk's credit note counter moved on while it was being moved past ${label}: the ` +
          `reservation took ${taken} instead, which is now skipped (a gap in the number range, ` +
          `Nummernkreis). Check that no other credit note carries ${label} before finalizing.`,
      ];
    }
    return [
      `sevDesk's credit note counter was moved past ${label} (the new draft's number), so the ` +
        "next credit note cannot get it again.",
      ...(await laggingCounterNotes(client, draftId, draftNumber, label, signal)),
    ];
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    return [
      `sevDesk's credit note counter could not be checked or moved past ${label}: the next ` +
        "credit note may get the same number. sevdesk_credit_note_create_draft skips numbers in " +
        "use; elsewhere check the number before finalizing.",
    ];
  }
}

/**
 * The counter can lag behind the numbers in use (`createFromInvoice` never advances it, see
 * `drafts/numbering.ts`), so the number it just handed out may belong to an older credit note
 * already. A trusted note when one carries it; nothing when none does or when the check could
 * not be made (the counter itself was handled, and that note stands).
 */
async function laggingCounterNotes(
  client: SevdeskClient,
  draftId: number,
  draftNumber: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  let others: Awaited<ReturnType<typeof findCreditNotesWithNumber>>;
  try {
    others = await findCreditNotesWithNumber(client, draftNumber, draftId, signal);
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    return [];
  }
  if (others.ids.length === 0) return [];
  return [
    `The new draft has the same number (${label}) as ${idList("credit note", others.ids)}: ` +
      "sevDesk's counter was behind the numbers in use when it handed that number out. Give " +
      "one of them another number in the sevDesk web app before finalizing either.",
  ];
}

/**
 * Trusted notes about other credit notes that carry the new draft's number (review 2026-11,
 * round 3: before, a counter that had moved on was taken as "nothing to do", although that is
 * exactly when another credit note may have got the same number). Nothing when none does; a note
 * too when the check was incomplete or failed, since the number then cannot be called unique.
 */
async function sameNumberNotes(
  client: SevdeskClient,
  draftId: number,
  draftNumber: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  let others: Awaited<ReturnType<typeof findCreditNotesWithNumber>>;
  try {
    others = await findCreditNotesWithNumber(client, draftNumber, draftId, signal);
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    return [
      `sevDesk's credit note counter does not offer ${label} (the new draft's number) any more, ` +
        "and whether another credit note carries the same number could not be checked. Check " +
        "it with sevdesk_credit_notes_list before finalizing.",
    ];
  }
  if (others.ids.length > 0) {
    return [
      `The new draft has the same number (${label}) as ${idList("credit note", others.ids)}: ` +
        "sevDesk's counter was moved on by someone else after it handed out that number. " +
        "Give one of them another number in the sevDesk web app before finalizing either.",
    ];
  }
  return others.truncated
    ? [
        `sevDesk's credit note counter does not offer ${label} (the new draft's number) any ` +
          "more, and not every credit note could be checked for the same number. Check it with " +
          "sevdesk_credit_notes_list before finalizing.",
      ]
    : [];
}

/**
 * Throws a `validation` SevdeskError when no credit note may correct `invoice`, for every path
 * that creates one (from the invoice, or an underachievement draft):
 * - its type must be RE, AR, TR or ER (not a cancellation SR, reminder MA or template WKR);
 * - it must be finalized: open (200), partially paid (750) or paid (1000), not a draft;
 * - it must not be cancelled. A cancelled invoice also shows status 1000 (D-037), so the
 *   cancellation invoice (SR whose `origin` is this invoice) is looked up: `GET /Invoice` with
 *   the documented `contact[id]` parameter and the `origin[id]` filter, re-checked locally. When
 *   that scan was cut and the invoice looks cancelled (status 1000, nothing paid) it is refused
 *   too, because it cannot be verified.
 * Returns trusted warnings for what could not be checked completely.
 */
export async function checkInvoiceCreditable(
  client: SevdeskClient,
  invoice: InvoiceDetail,
  signal?: AbortSignal,
): Promise<{ readonly warnings: readonly string[] }> {
  const ref = `Invoice ${String(invoice.id)}`;
  requireRevenueInvoice(invoice.type.code, ref, "a credit note");
  if (invoice.status.code === 100) {
    throw validation(
      `${ref} is still a draft: change it with sevdesk_invoice_update_draft instead; a credit ` +
        "note corrects finalized invoices only.",
    );
  }
  if (![200, 750, 1000].includes(invoice.status.code)) {
    throw validation(
      `${ref} has status ${invoice.status.code}; credit notes are created from open, ` +
        "partially paid or paid invoices only.",
    );
  }
  const cancellations = await findDerived(
    client,
    "/Invoice",
    {
      ...contactQuery(invoice.contact?.id),
      "origin[id]": invoice.id,
      "origin[objectName]": "Invoice",
    },
    (row) => isInvoiceRef(row.origin, invoice.id) && invoiceTypeOf(row) === "SR",
    signal,
  );
  if (cancellations.ids.length > 0) {
    throw validation(
      `${ref} was cancelled (Storno) by ${idList("cancellation invoice", cancellations.ids)}; ` +
        "its revenue is already reversed, so a credit note would reverse it twice. Use " +
        "sevdesk_invoice_get on the cancellation invoice to check.",
    );
  }
  // D-037: a cancelled original is paid (1000) with paidAmount 0. Foreign-currency invoices show no
  // paid amount at all (its currency is undocumented), so they are never taken for cancelled.
  const paidNothing =
    invoice.status.code === 1000 &&
    invoice.paid !== undefined &&
    compare(invoice.paid.amount, 0) === 0;
  if (cancellations.truncated && paidNothing) {
    throw validation(
      `${ref} is marked paid but nothing was paid, which is how a cancelled invoice looks, and ` +
        "sevDesk listed too many invoices to find its cancellation. Check with " +
        "sevdesk_invoices_list (type cancellation) first; no credit note was created.",
    );
  }
  const warnings: string[] = [];
  if (cancellations.truncated) {
    warnings.push(
      "Not every invoice could be checked for a cancellation (Storno) of this invoice.",
    );
  } else if (paidNothing) {
    warnings.push(
      "The invoice is marked paid but sevDesk shows no payment on it; make sure it was not " +
        "settled another way before crediting it.",
    );
  }
  return { warnings };
}

/** Credit notes that already refer to an invoice, see {@link findCreditNotesForInvoice}. */
export interface CreditNotesForInvoice {
  /** Their ids, ascending. */
  readonly ids: readonly number[];
  /** True when the scan stopped at its cap: a matching credit note may have been missed. */
  readonly truncated: boolean;
}

/**
 * Credit notes that refer to invoice `invoiceId`: created from it (`origin` = the invoice) or an
 * underachievement credit note for it (`refSrcInvoice` = the invoice, as a reference or a bare
 * id; such notes have no `origin`, D-039). Lists `GET /CreditNote` by the invoice's contact (the
 * documented `contact[id]` parameter; all credit notes when `contactId` is undefined), at most
 * {@link DERIVED_SCAN_MAX} rows, and matches every row locally. Deliberately no `origin[id]`
 * filter: it would hide the underachievement notes. Reads only.
 */
export async function findCreditNotesForInvoice(
  client: SevdeskClient,
  params: { readonly invoiceId: number; readonly contactId: number | undefined },
  signal?: AbortSignal,
): Promise<CreditNotesForInvoice> {
  const invoiceId = toSevdeskId(params.invoiceId);
  return findDerived(
    client,
    "/CreditNote",
    contactQuery(params.contactId),
    (row) => isInvoiceRef(row.origin, invoiceId) || refId(row.refSrcInvoice) === invoiceId,
    signal,
  );
}

// ---------------------------------------------------------------------------------------------
// Reminder (Mahnung)
// ---------------------------------------------------------------------------------------------

export interface InvoiceReminderInput {
  readonly invoiceId: number;
  readonly allowDuplicate: boolean;
  /** Berlin `YYYY-MM-DD` used as "today" (tests); defaults to the current date. */
  readonly today?: string | undefined;
}

export interface InvoiceReminderState {
  readonly invoiceId: number;
  readonly payload: z.output<typeof invoiceRefPayloadSchema>;
  /** The invoice as `prepare` saw it, to tell whether sevDesk changed it. */
  readonly invoiceFingerprint: string;
}

/**
 * Checks that the invoice can be dunned (an open or partially paid RE/AR/TR/ER whose due date
 * has passed, no unsent reminder draft for it yet) and builds the preview. Reads only.
 */
export async function planInvoiceReminder(
  client: SevdeskClient,
  input: InvoiceReminderInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: InvoiceReminderState }> {
  const invoiceId = toSevdeskId(input.invoiceId);
  const today = input.today ?? berlinDateOf(Date.now());
  const snapshot = await readInvoiceSnapshot(client, invoiceId, today, signal);
  const invoice = snapshot.detail;
  const label = documentLabel("Invoice", invoice.id, invoice.number);
  // Refusals name the invoice by its id, never by its stored number (see documentLabel).
  const ref = `Invoice ${String(invoice.id)}`;
  requireRevenueInvoice(invoice.type.code, ref, "a reminder");
  switch (invoice.status.code) {
    case 100:
      throw validation(`${ref} is still a draft; only finalized, unpaid invoices are dunned.`);
    case 1000:
      throw validation(`${ref} is paid (or cancelled); there is nothing to remind of.`);
    case 200:
    case 750:
      break;
    default:
      throw validation(
        `${ref} has status ${invoice.status.code}; reminders are created for open or partially ` +
          "paid invoices only.",
      );
  }
  const dueDate = invoice.dueDate ?? invoice.date;
  if (dueDate === undefined) {
    throw validation(`${ref} has no invoice date, so it cannot be overdue.`);
  }
  if (dueDate >= today) {
    throw validation(
      `${ref} is due on ${dueDate}; a reminder (Mahnung) is only possible after the due date.`,
    );
  }

  const existing = await findDerived(
    client,
    "/Invoice",
    {
      ...contactQuery(invoice.contact?.id),
      "origin[id]": invoiceId,
      "origin[objectName]": "Invoice",
      invoiceType: "MA",
      showMa: "all",
    },
    (row) =>
      isInvoiceRef(row.origin, invoiceId) && invoiceTypeOf(row) === "MA" && row.status === 100,
    signal,
  );
  if (existing.ids.length > 0 && !input.allowDuplicate) {
    throw validation(
      `An unsent reminder draft for ${ref} exists already: ${idList("invoice", existing.ids)}. ` +
        "Finalize or send that one (sevdesk_invoice_finalize, sevdesk_invoice_send_email), or " +
        "call again with allowDuplicate: true.",
    );
  }

  const facts: ConfirmationFact[] = [
    { label: "Invoice", value: `${label} (${invoice.status.label})` },
    ...customerFact(invoice.contact),
    ...totalsFacts("Invoice", invoice.totals, invoice.currency),
  ];
  if (invoice.paid !== undefined) {
    facts.push({ label: "Paid so far", value: `${invoice.paid.amount} ${invoice.paid.currency}` });
  }
  facts.push({
    label: "Due date",
    value: `${dueDate} (${daysBetween(dueDate, today)} days overdue)`,
  });
  if (invoice.reminder?.dunningLevel !== undefined) {
    facts.push({
      label: "Current dunning level (Mahnstufe)",
      value: String(invoice.reminder.dunningLevel),
    });
  }
  const warnings = [
    "The reminder (Mahnung, invoice type MA) is created as a draft and not sent. Finalize or " +
      "send it with sevdesk_invoice_finalize or sevdesk_invoice_send_email.",
    "sevDesk does not accept a reminder fee (Mahngebühr) through the API on Update 2.0.",
  ];
  if (existing.ids.length > 0) {
    warnings.push(
      `Creating another one (allowDuplicate): ${idList("reminder draft", existing.ids)} exists already.`,
    );
  }
  if (existing.truncated) {
    warnings.push("Not every reminder could be checked for an unsent draft for this invoice.");
  }
  return {
    preview: {
      action: `Create a reminder (Mahnung) draft for ${label}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: {
      invoiceId,
      payload: invoiceRefPayloadSchema.parse({ invoice: { id: invoiceId, objectName: "Invoice" } }),
      invoiceFingerprint: snapshot.fingerprint,
    },
  };
}

/**
 * Sends `createInvoiceReminder` (never retried), reads the reminder back and checks that it is a
 * draft of type MA; the dunned invoice is listed in `affected` when sevDesk changed it.
 */
export async function executeInvoiceReminder(
  client: SevdeskClient,
  state: InvoiceReminderState,
  signal?: AbortSignal,
): Promise<{ details: InvoiceDetails; affected: SevdeskObjectRef[] }> {
  const answer = await client.request({
    method: "POST",
    path: "/Invoice/Factory/createInvoiceReminder",
    query: { "invoice[id]": state.invoiceId, "invoice[objectName]": "Invoice" },
    body: state.payload,
    ...(signal === undefined ? {} : { signal }),
  });
  const reminderId = createdDocumentId(answer, "invoice", "the created reminder");
  const created = [{ objectName: "Invoice", id: String(reminderId) }];
  const details = await readBack(() => getInvoice(client, reminderId, signal), created);
  const affected = [
    ...created,
    ...(await sourceInvoiceChanges(client, state.invoiceId, state.invoiceFingerprint, signal)),
  ];
  verifyDraft(
    { what: "reminder", id: reminderId, tool: "sevdesk_invoice_get" },
    details.invoice.status.code,
    typeProblem(details.invoice.type.code, ["MA"]),
    affected,
  );
  return { details, affected };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A document row as far as the guards need it. */
const derivedRowSchema = z.object({
  id: zId,
  origin: zOptionalRef,
  refSrcInvoice: z.unknown().optional(),
  invoiceType: zText,
  status: zIntish.optional(),
});

type DerivedRow = z.output<typeof derivedRowSchema>;

/**
 * Documents of `path` matching `matches`, read with `query` (filters sevDesk may ignore; every
 * row is checked locally) up to {@link DERIVED_SCAN_MAX} rows.
 */
async function findDerived(
  client: SevdeskClient,
  path: string,
  query: Readonly<Record<string, QueryValue>>,
  matches: (row: DerivedRow) => boolean,
  signal: AbortSignal | undefined,
): Promise<{ ids: number[]; truncated: boolean }> {
  const list = await client.listAll(path, query, {
    max: DERIVED_SCAN_MAX,
    pageSize: SCAN_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const ids = list.items
    .map((raw) => parseUpstream(derivedRowSchema, raw, "documents"))
    .filter(matches)
    .map((row) => row.id);
  return { ids: [...new Set(ids)].sort((a, b) => a - b), truncated: list.truncated };
}

/** The documented `contact[id]` list parameter, or nothing without a contact. */
function contactQuery(contactId: number | undefined): Record<string, QueryValue> {
  return contactId === undefined
    ? {}
    : { "contact[id]": contactId, "contact[objectName]": "Contact" };
}

function isInvoiceRef(
  ref: { readonly id: number; readonly objectName: string } | undefined,
  invoiceId: number,
): boolean {
  return ref?.objectName === "Invoice" && ref.id === invoiceId;
}

function invoiceTypeOf(row: DerivedRow): string | undefined {
  return row.invoiceType?.trim().toUpperCase();
}

/** An invoice's detail DTO plus what changes when sevDesk touches it (status, last update). */
interface InvoiceSnapshot {
  readonly detail: InvoiceDetail;
  readonly fingerprint: string;
}

/** `GET /Invoice/{id}` (contact embedded) without positions: enough for checks and previews. */
async function readInvoiceSnapshot(
  client: SevdeskClient,
  invoiceId: number,
  today: string,
  signal: AbortSignal | undefined,
): Promise<InvoiceSnapshot> {
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Invoice", invoiceId),
    query: { embed: "contact" },
    ...(signal === undefined ? {} : { signal }),
  });
  const raw = expectSingle(payload, `invoice ${invoiceId}`);
  const detail = mapInvoiceDetail(raw, today);
  const { update } = parseUpstream(z.object({ update: z.unknown().optional() }), raw, "an invoice");
  return {
    detail,
    fingerprint: JSON.stringify([
      detail.status.code,
      update ?? null,
      detail.reminder?.dunningLevel ?? null,
      detail.paid?.amount ?? null,
    ]),
  };
}

/**
 * The source invoice as a changed record when its fingerprint differs from the one `prepare`
 * saw, or when it could not be read again (listed to be safe); otherwise nothing.
 */
async function sourceInvoiceChanges(
  client: SevdeskClient,
  invoiceId: number,
  before: string,
  signal: AbortSignal | undefined,
): Promise<SevdeskObjectRef[]> {
  const after = await readQuietly(() =>
    readInvoiceSnapshot(client, invoiceId, berlinDateOf(Date.now()), signal),
  );
  return after?.fingerprint === before ? [] : [{ objectName: "Invoice", id: String(invoiceId) }];
}

/**
 * A read after the write that must not turn a successful write into an error: any failure gives
 * `undefined`, and the caller treats the record as possibly changed.
 */
async function readQuietly<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** A problem when the type is not one of `expected` (only known-looking codes are named). */
function typeProblem(type: string, expected: readonly string[]): string[] {
  if (expected.includes(type)) return [];
  const shown = /^[A-Z]{2,3}$/.test(type) ? `type ${type}` : "another type";
  return [`it has ${shown} instead of ${expected.join(" or ")}`];
}

/**
 * Fails when the read-back is not a draft (status 100) or `problems` is not empty: sevDesk then
 * did something other than what the preview promised, so no "draft created" is claimed. The
 * error carries `completed` so the records are known to exist.
 */
function verifyDraft(
  created: { readonly what: string; readonly id: number; readonly tool: string },
  status: number,
  problems: readonly string[],
  completed: readonly CompletedWrite[],
): void {
  const all = [
    ...(status === 100 ? [] : [`its status is ${status}, not 100 (draft)`]),
    ...problems,
  ];
  if (all.length === 0) return;
  throw new SevdeskError({
    kind: "unexpected_response",
    message:
      `sevDesk created ${created.what} ${created.id}, but not as the expected draft: ` +
      `${all.join("; ")}. Check it with ${created.tool} before doing anything else.`,
    completedWrites: completed,
  });
}

/** The id of `{id}`, a bare id, or `undefined`. */
function refId(raw: unknown): number | undefined {
  const parsed = z.union([z.object({ id: zId }), zId]).safeParse(raw);
  if (!parsed.success) return undefined;
  return typeof parsed.data === "number" ? parsed.data : parsed.data.id;
}

/**
 * The id of a document a Factory endpoint created: the answer's object itself (`{id, …}`), its
 * nested `key` member (`{creditNote: {id}}`, `{invoice: {id}}`), or either inside an array of one.
 */
function createdDocumentId(payload: unknown, key: string, what: string): number {
  const single =
    Array.isArray(payload) && payload.length === 1 ? (payload as unknown[])[0] : payload;
  const nested = z.object({ [key]: z.object({ id: zId }) }).safeParse(single);
  if (nested.success) return (nested.data[key] as { id: number }).id;
  return parseUpstream(z.object({ id: zId }), single, what).id;
}

/** Reads the created record back; a failure carries `written` as completed writes. */
async function readBack<T>(read: () => Promise<T>, written: readonly CompletedWrite[]): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, written);
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "The document was created, but reading it back failed unexpectedly.",
      cause: error,
      completedWrites: written,
    });
  }
}

/**
 * Refuses an invoice that is no receivable. `ref` names it by its id (trusted); the stored type
 * is quoted only when it looks like one of sevDesk's codes, like in {@link typeProblem}.
 */
function requireRevenueInvoice(typeCode: string, ref: string, what: string): void {
  if (REVENUE_INVOICE_TYPES.has(typeCode)) return;
  const reason: Readonly<Record<string, string>> = {
    SR: "a cancellation invoice (Stornorechnung)",
    MA: "a reminder (Mahnung); use the invoice it reminds of",
    WKR: "a recurring invoice template (Abo-Rechnung); use one of the invoices it created",
  };
  const known = Object.hasOwn(reason, typeCode) ? reason[typeCode] : undefined;
  const why = known ?? (/^[A-Z]{2,3}$/.test(typeCode) ? `of type ${typeCode}` : "of another type");
  throw validation(`${ref} is ${why}, so ${what} cannot be created from it.`);
}

/**
 * "Invoice RE-1001 (id 1001)", or "Invoice 1001" without a number: for previews only. Error texts
 * name a document by its id (`ref`): the number is sevDesk text, and a hostile one read like
 * instructions inside a trusted error (security review 2026-11, wave 2).
 */
function documentLabel(kind: "Invoice" | "Order", id: number, number: string | undefined): string {
  const shown = cleanText(number, DISPLAY_MAX);
  return shown === undefined ? `${kind} ${id}` : `${kind} ${shown} (id ${id})`;
}

function customerFact(
  contact: { readonly id: number; readonly name?: string | undefined } | undefined,
): ConfirmationFact[] {
  if (contact === undefined) return [];
  return [
    {
      label: "Customer",
      value:
        contact.name === undefined
          ? `contact ${contact.id}`
          : `${contact.name} (contact ${contact.id})`,
    },
  ];
}

function totalsFacts(
  what: string,
  totals: DocumentTotals["totals"],
  currency: string,
): ConfirmationFact[] {
  const facts: ConfirmationFact[] = [];
  const line = (label: string, amount: { readonly amount: string } | undefined): void => {
    if (amount !== undefined)
      facts.push({ label: `${what} ${label}`, value: `${amount.amount} ${currency}` });
  };
  line("net", totals.net);
  line("tax", totals.tax);
  line("gross", totals.gross);
  return facts;
}

function idList(noun: string, ids: readonly number[]): string {
  const shown = ids.slice(0, 5).map((id) => `${noun} ${id}`);
  return ids.length > 5 ? `${shown.join(", ")} and ${ids.length - 5} more` : shown.join(", ");
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
