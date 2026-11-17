/**
 * Which lifecycle action is allowed for which document type and status. Status codes come from
 * the document's kind (`statusOf`): sales documents use draft 100 / open 200, vouchers draft 50 /
 * open 100; partially paid (750) and paid (1000) are shared. Every check throws a
 * `validation` SevdeskError with a trusted message (ids and reference-data labels only, never
 * upstream text) that says why and what to do instead; nothing has been sent at that point.
 *
 * Sources: spec operations `invoiceSendBy`, `cancelInvoice`, `invoiceEnshrine`,
 * `invoiceResetToOpen`, `invoiceResetToDraft` (and their credit note and order twins) and the
 * status tables of the tags `Invoice`, `CreditNote` and `Order`; behaviour measured by
 * jernoxit/sevdesk-rs (README, `src/endpoints/*.rs`, 2026-11-05): drafts get their number on
 * `sendBy`; `cancelInvoice` refuses drafts (code 423) and partially paid invoices (code 390);
 * `enshrine` answers 422 on drafts and is idempotent afterwards; `resetToDraft` on an enshrined
 * document answers 422/322; `resetToOpen` works on a paid, enshrined invoice unless a payment
 * transaction is enshrined (the spec says it never works on an enshrined invoice).
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import { compare } from "../money.js";
import {
  documentRef,
  KINDS,
  type LifecycleDocument,
  type PaymentKind,
  type SalesKind,
  STATUS,
  statusOf,
} from "./documents.js";

/** Invoice types that `cancelInvoice` applies to: normal, advance, partial and final invoices. */
const CANCELLABLE_INVOICE_TYPES: ReadonlySet<string> = new Set(["RE", "AR", "TR", "ER"]);

/** A local refusal: nothing was sent to sevDesk. */
export function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/** Whether sevDesk reports a non-zero paid amount for the document. */
export function hasPayments(doc: LifecycleDocument): boolean {
  return doc.paidAmount !== undefined && compare(doc.paidAmount, 0) !== 0;
}

/** "status 200, Open / due": trusted (code and reference-data label). */
function statusText(doc: LifecycleDocument): string {
  return `status ${String(doc.status)}, ${doc.statusLabel}`;
}

function isInvoiceType(doc: LifecycleDocument, code: string): boolean {
  return doc.kind === "invoice" && doc.typeCode === code;
}

/** Refuses recurring invoice templates (WKR, Abo-Rechnung): sevDesk only creates invoices from them. */
function refuseTemplate(doc: LifecycleDocument, action: string): void {
  if (isInvoiceType(doc, "WKR")) {
    refuse(
      `${documentRef(doc, true)} is a recurring invoice template (WKR, Abo-Rechnung); sevDesk ` +
        `creates invoices from it, and a template cannot be ${action}.`,
    );
  }
}

/** Refuses cancellation invoices (SR, Stornorechnung): sevDesk books them itself. */
function refuseCancellation(doc: LifecycleDocument, action: string): void {
  if (isInvoiceType(doc, "SR")) {
    refuse(
      `${documentRef(doc, true)} is a cancellation invoice (Stornorechnung, SR); sevDesk creates ` +
        `it already paid, and it cannot be ${action}.`,
    );
  }
}

/**
 * Refuses a credit note draft without a number. Recorded on 2026-11-07: `sendBy` on such a draft
 * answered HTTP 500 (PHP TypeError, `fileName` null) yet finalized the credit note anyway
 * (status 200, no number), while other numberless drafts got a number; the outcome is
 * unreliable and can leave a finalized credit note without a number. Invoices without a number
 * are fine (`sendBy` assigns one reliably, recorded); orders cannot be saved without one.
 */
function refuseNumberlessCreditNote(doc: LifecycleDocument, action: string): void {
  if (doc.kind !== "creditNote" || doc.status !== statusOf(doc).draft) return;
  if (doc.number !== undefined && doc.number.trim() !== "") return;
  refuse(
    `${documentRef(doc, true)} is a draft without a number, and ${action} it could fail half-way ` +
      "in sevDesk and leave a finalized credit note without a number. Create it again with " +
      "sevdesk_credit_note_create_draft (which takes a number from the number range) and delete " +
      "this draft with sevdesk_document_delete_draft, or give it a number in the sevDesk web " +
      "app first.",
  );
}

/** Finalize (`sendBy`): drafts only; credit note drafts need a number. */
export function assertFinalizable(doc: LifecycleDocument<SalesKind>): void {
  refuseTemplate(doc, "finalized");
  if (doc.status !== statusOf(doc).draft) {
    refuse(
      `${documentRef(doc, true)} is not a draft (${statusText(doc)}); only drafts can be ` +
        `finalized, and this one already was.`,
    );
  }
  refuseNumberlessCreditNote(doc, "finalizing");
}

/**
 * Send by email (`sendViaEmail`): any document except recurring invoice templates and credit
 * note drafts without a number (sending finalizes them, see {@link refuseNumberlessCreditNote}).
 * sevDesk finalizes a draft it sends, which is a commit-level step, so a draft is only accepted
 * when the caller may finalize (`finalizeAllowed`: the commit tier is enabled); an external-only
 * setup would otherwise finalize documents through the back door.
 */
export function assertEmailable(doc: LifecycleDocument<SalesKind>, finalizeAllowed: boolean): void {
  refuseTemplate(doc, "sent by email");
  refuseNumberlessCreditNote(doc, "sending (and so finalizing)");
  if (doc.status === statusOf(doc).draft && !finalizeAllowed) {
    const { toolPrefix } = KINDS[doc.kind];
    refuse(
      `${documentRef(doc, true)} is a draft: sending it by email would also finalize it ` +
        `(draft → ${doc.kind === "order" ? "sent" : "open"}), which needs the commit tier. ` +
        `Finalize it first with ${toolPrefix}_finalize (needs the commit tier), or enable commit ` +
        `(SEVDESK_ALLOW).`,
    );
  }
}

/** Book a payment (`bookAmount`): open or partially paid invoices, credit notes and vouchers. */
export function assertBookable(doc: LifecycleDocument<PaymentKind>): void {
  const { toolPrefix, noun } = KINDS[doc.kind];
  const codes = statusOf(doc);
  refuseTemplate(doc, "paid");
  refuseCancellation(doc, "paid");
  if (isInvoiceType(doc, "MA")) {
    refuse(
      `${documentRef(doc, true)} is a payment reminder (Mahnung, MA). Book the payment on the ` +
        `invoice it reminds of; sevdesk_invoice_get shows that invoice as origin.`,
    );
  }
  if (doc.status === codes.draft) {
    refuse(
      `${documentRef(doc, true)} is a draft; sevDesk books payments only on finalized ` +
        `documents. Finalize it first with ${toolPrefix}_finalize.`,
    );
  }
  if (doc.status === codes.paid) {
    refuse(
      `${documentRef(doc, true)} is already paid (${statusText(doc)}). To undo its payments, ` +
        `reset it to open with ${toolPrefix}_reset.`,
    );
  }
  if (doc.status !== codes.open && doc.status !== codes.partiallyPaid) {
    refuse(
      `${documentRef(doc, true)} has ${statusText(doc)}; payments can only be booked on open or ` +
        `partially paid ${noun}s.`,
    );
  }
}

/** Cancel (`cancelInvoice`, Storno): open, unpaid invoices of type RE, AR, TR or ER. */
export function assertCancellable(doc: LifecycleDocument<"invoice">): void {
  const ref = documentRef(doc, true);
  const codes = statusOf(doc);
  refuseCancellation(doc, "cancelled");
  refuseTemplate(doc, "cancelled");
  if (isInvoiceType(doc, "MA")) {
    refuse(`${ref} is a payment reminder (Mahnung, MA); reminders cannot be cancelled here.`);
  }
  if (doc.typeCode === undefined || !CANCELLABLE_INVOICE_TYPES.has(doc.typeCode)) {
    refuse(`${ref} has an invoice type that sevdesk_invoice_cancel does not handle.`);
  }
  if (doc.status === codes.draft) {
    refuse(
      `${ref} is a draft: a draft has no legal effect and needs no cancellation. Change it with ` +
        `sevdesk_invoice_update_draft or delete it with sevdesk_document_delete_draft.`,
    );
  }
  if (doc.status === codes.partiallyPaid || (doc.status === codes.open && hasPayments(doc))) {
    refuse(
      `${ref} is partially paid; sevDesk cancels only unpaid invoices. Create a credit note ` +
        `(Gutschrift) for it with sevdesk_credit_note_create_from_invoice.`,
    );
  }
  if (doc.status === codes.paid) {
    refuse(
      `${ref} has ${statusText(doc)}; cancelling only works for open, unpaid invoices. If it ` +
        `was paid, create a credit note with sevdesk_credit_note_create_from_invoice. If it was ` +
        `cancelled before (sevDesk keeps a cancelled invoice at status 1000 with nothing paid), ` +
        `its cancellation invoice is listed by sevdesk_invoices_list with type cancellation.`,
    );
  }
  if (doc.status !== codes.open) {
    refuse(`${ref} has ${statusText(doc)}; only open, unpaid invoices can be cancelled.`);
  }
}

/** Enshrine (`enshrine`, festschreiben): from status open (200; vouchers 100) on, once. */
export function assertEnshrinable(doc: LifecycleDocument<PaymentKind>): void {
  const ref = documentRef(doc, true);
  const codes = statusOf(doc);
  refuseTemplate(doc, "enshrined");
  if (doc.enshrined) {
    refuse(`${ref} is already enshrined (festgeschrieben); there is nothing to do.`);
  }
  if (doc.status === codes.draft) {
    refuse(
      `${ref} is a draft; sevDesk enshrines documents only from status open ` +
        `(${String(codes.open)}) on. Finalize ` +
        `it first with ${KINDS[doc.kind].toolPrefix}_finalize.`,
    );
  }
  if (doc.status < codes.open) {
    refuse(`${ref} has ${statusText(doc)}; only open or later documents can be enshrined.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Offers (Angebote): accept, reject, reopen; confirmations and delivery notes made from orders
// ---------------------------------------------------------------------------------------------

/** The offer statuses (spec tag `Order`): sent, and the customer's answers rejected and accepted. */
const ORDER_STATUS = { sent: 200, rejected: 300, accepted: 500 } as const;

export const OFFER_STATUS_ACTIONS = ["accept", "reject", "reopen"] as const;
export type OfferStatusAction = (typeof OFFER_STATUS_ACTIONS)[number];

/** The status an offer status action sets. */
export type OfferStatusTarget = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

const OFFER_TARGETS: Readonly<Record<OfferStatusAction, OfferStatusTarget>> = {
  accept: ORDER_STATUS.accepted,
  reject: ORDER_STATUS.rejected,
  reopen: ORDER_STATUS.sent,
};

/** "order confirmation (AB)": a trusted name of an order type for refusals. */
function orderTypeText(doc: LifecycleDocument<"order">): string {
  switch (doc.typeCode) {
    case "AN":
      return "an offer (Angebot, AN)";
    case "AB":
      return "an order confirmation (Auftragsbestätigung, AB)";
    case "LI":
      return "a delivery note (Lieferschein, LI)";
    default:
      return "an order of another type";
  }
}

/** Refuses an order draft that a status change would renumber (spec/deviations.md D-108). */
function refuseOfferDraft(doc: LifecycleDocument<"order">, what: string): void {
  if (doc.status !== STATUS.draft) return;
  refuse(
    `${documentRef(doc, true)} is a draft offer that was never sent, so ${what}. Send it first ` +
      "(sevdesk_order_finalize, or sevdesk_order_send_email).",
  );
}

/**
 * Accept (500), reject (300) or reopen (back to sent 200) an offer with `PUT /Order/{id}` and a
 * body of only `{status}` (D-108). Offers (AN) only, never drafts: on a draft the same request also
 * renumbers the offer. Accept and reject only from sent (200); reopen only from accepted or
 * rejected, which is the recorded way back. Returns the status to set.
 */
export function assertOfferStatusChange(
  doc: LifecycleDocument<"order">,
  action: OfferStatusAction,
): OfferStatusTarget {
  const ref = documentRef(doc, true);
  if (doc.typeCode !== "AN") {
    refuse(
      `${ref} is ${orderTypeText(doc)}; only offers (AN) are accepted, rejected or reopened. ` +
        "A confirmation is made from an accepted offer with sevdesk_order_create_confirmation.",
    );
  }
  refuseOfferDraft(doc, "sevDesk would also renumber it on a status change");
  const target = OFFER_TARGETS[action];
  if (doc.status === target) {
    refuse(`${ref} already has ${statusText(doc)}; there is nothing to change.`);
  }
  if (action === "reopen") {
    if (doc.status !== ORDER_STATUS.accepted && doc.status !== ORDER_STATUS.rejected) {
      refuse(`${ref} has ${statusText(doc)}; only accepted or rejected offers are reopened.`);
    }
    return target;
  }
  if (doc.status === ORDER_STATUS.accepted || doc.status === ORDER_STATUS.rejected) {
    refuse(
      `${ref} has ${statusText(doc)}. Reopen it first (sevdesk_order_set_offer_status with ` +
        `action "reopen", back to sent 200), then ${action} it.`,
    );
  }
  if (doc.status !== ORDER_STATUS.sent) {
    refuse(`${ref} has ${statusText(doc)}; only sent offers (status 200) are ${action}ed.`);
  }
  return target;
}

/**
 * The sources `createContractNoteFromOrder` may turn into an order confirmation (D-107): an offer
 * (AN) that was sent (200; sevDesk marks it accepted, 500) or is accepted already (500, stays).
 * Refused: drafts (sevDesk would accept an offer the customer never received), rejected offers
 * (sevDesk would silently turn the rejection into an acceptance: reopening is its own confirmed
 * step), every other status and every other order type. Returns whether the offer becomes
 * accepted by the request.
 */
export function assertConfirmable(doc: LifecycleDocument<"order">): { readonly accepts: boolean } {
  const ref = documentRef(doc, true);
  if (doc.typeCode !== "AN") {
    refuse(
      `${ref} is ${orderTypeText(doc)}; order confirmations are created from offers (AN) only.`,
    );
  }
  refuseOfferDraft(doc, "a confirmation would accept an offer the customer never received");
  if (doc.status === ORDER_STATUS.rejected) {
    refuse(
      `${ref} was rejected (status 300), and sevDesk would silently mark it as accepted when a ` +
        "confirmation is created from it. If the customer accepted after all, reopen it first " +
        '(sevdesk_order_set_offer_status with action "reopen", back to sent 200), then create ' +
        "the confirmation.",
    );
  }
  if (doc.status === ORDER_STATUS.sent) return { accepts: true };
  if (doc.status === ORDER_STATUS.accepted) return { accepts: false };
  return refuse(
    `${ref} has ${statusText(doc)}; order confirmations are created from sent (200) or accepted ` +
      "(500) offers only.",
  );
}

/**
 * The sources `createPackingListFromOrder` may turn into a delivery note (D-107): an offer that
 * was sent or accepted (200, 500), and an order confirmation that is a draft, sent or accepted
 * (100, 200, 500; sevDesk shows a sent confirmation as 500). sevDesk leaves the source alone,
 * whatever its status (recorded from sent and draft offers and from confirmations; the owner chose
 * to allow accepted offers too, 2026-11-17). Refused: offer drafts (sevDesk accepts them, but
 * nothing was offered to the customer yet, so there is nothing to deliver on), rejected offers,
 * delivery notes and every other status.
 */
export function assertDeliveryNoteSource(doc: LifecycleDocument<"order">): void {
  const ref = documentRef(doc, true);
  if (doc.typeCode === "AN") {
    refuseOfferDraft(doc, "nothing was offered to the customer yet to deliver on");
    if (doc.status === ORDER_STATUS.sent || doc.status === ORDER_STATUS.accepted) return;
    refuse(
      `${ref} has ${statusText(doc)}; delivery notes are created from sent or accepted offers ` +
        "(200, 500) or from order confirmations.",
    );
  }
  if (doc.typeCode === "AB") {
    if (
      doc.status === STATUS.draft ||
      doc.status === ORDER_STATUS.sent ||
      doc.status === ORDER_STATUS.accepted
    ) {
      return;
    }
    refuse(
      `${ref} has ${statusText(doc)}; delivery notes are created from order confirmations that ` +
        "are drafts, sent or accepted (100, 200, 500).",
    );
  }
  refuse(
    `${ref} is ${orderTypeText(doc)}; delivery notes are created from offers (AN) and order ` +
      "confirmations (AB) only.",
  );
}

export const RESET_TARGETS = ["draft", "open"] as const;
export type ResetTarget = (typeof RESET_TARGETS)[number];

/**
 * Reset (`resetToOpen` / `resetToDraft`). To open: paid or partially paid documents (also an
 * invoice still at status 200 with payments, as sevDesk showed partial payments before release
 * 4.181). To draft: open documents without payments that are not enshrined.
 */
export function assertResettable(doc: LifecycleDocument<PaymentKind>, to: ResetTarget): void {
  const ref = documentRef(doc, true);
  const { toolPrefix } = KINDS[doc.kind];
  const codes = statusOf(doc);
  refuseCancellation(doc, "reset");
  refuseTemplate(doc, "reset");
  if (to === "open") {
    if (doc.status === codes.draft) {
      refuse(
        `${ref} is a draft; a reset cannot raise the status. Open it by finalizing it with ` +
          `${toolPrefix}_finalize.`,
      );
    }
    if (
      doc.kind === "invoice" &&
      doc.status === codes.paid &&
      doc.paidAmount !== undefined &&
      !hasPayments(doc)
    ) {
      refuse(
        `${ref} is marked paid with nothing paid, which is how sevDesk shows a cancelled ` +
          `invoice (Storno); a cancelled invoice cannot be reset.`,
      );
    }
    if (doc.status === codes.open && !hasPayments(doc)) {
      refuse(`${ref} is already open with no payments booked; there is nothing to reset.`);
    }
    if (
      doc.status !== codes.partiallyPaid &&
      doc.status !== codes.paid &&
      doc.status !== codes.open
    ) {
      refuse(`${ref} has ${statusText(doc)}; only paid or partially paid documents reset to open.`);
    }
    return;
  }
  if (doc.status === codes.draft) {
    refuse(`${ref} is already a draft; there is nothing to reset.`);
  }
  if (doc.enshrined) {
    const instead =
      doc.kind === "invoice"
        ? "Correct it with a cancellation (sevdesk_invoice_cancel) or a credit note instead."
        : "Correct it with a new document instead.";
    refuse(
      `${ref} is enshrined (festgeschrieben); sevDesk never resets an enshrined document to ` +
        `draft. ${instead}`,
    );
  }
  if (doc.status === codes.partiallyPaid || doc.status === codes.paid || hasPayments(doc)) {
    refuse(
      `${ref} has payments booked (${statusText(doc)}); sevDesk resets only open documents to ` +
        `draft. Reset it to open first (${toolPrefix}_reset with to "open"), which unlinks the ` +
        `payments, then reset it to draft.`,
    );
  }
  if (doc.status !== codes.open) {
    refuse(`${ref} has ${statusText(doc)}; only open documents reset to draft.`);
  }
}

/** What to do instead of deleting a document that is no longer a draft, per kind. */
const INSTEAD_OF_DELETE: Readonly<Record<SalesKind, string>> = {
  invoice:
    "A finalized invoice stays in the books (GoBD): cancel it with sevdesk_invoice_cancel " +
    "(Storno), or correct a paid one with a credit note (sevdesk_credit_note_create_from_invoice).",
  creditNote:
    "A finalized credit note stays in the books (GoBD): to correct it, reset it to draft with " +
    'sevdesk_credit_note_reset (to "draft") while it is not enshrined, or create a new document.',
  order: "A sent order stays as it is; create a new order if it has to change.",
};

/**
 * Delete (`DELETE /{Invoice|CreditNote|Order}/{id}`): drafts (status 100) only, as sevDesk
 * enforces with 409 "… can only be deleted in status 100 but is status 200" (spec/deviations.md
 * D-109, D-074). Recurring invoice templates (WKR) are refused although sevDesk deletes them at
 * status 100 and 50 (D-112): ending a template is another action, and a template is no draft.
 */
export function assertDeletable(doc: LifecycleDocument<SalesKind>): void {
  const ref = documentRef(doc, true);
  if (isInvoiceType(doc, "WKR")) {
    refuse(
      `${ref} is a recurring invoice template (WKR, Abo-Rechnung), not a draft; ` +
        "sevdesk_document_delete_draft does not delete templates. End it with " +
        "sevdesk_invoice_end_recurring (it can be reactivated later); a template is deleted " +
        "only in the sevDesk web app.",
    );
  }
  if (doc.status !== statusOf(doc).draft) {
    refuse(
      `${ref} is not a draft (${statusText(doc)}); sevDesk deletes only drafts (status ` +
        `${String(statusOf(doc).draft)}). ${INSTEAD_OF_DELETE[doc.kind]}`,
    );
  }
}
