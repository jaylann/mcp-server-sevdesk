/**
 * Which lifecycle action is allowed for which document type and status. Every check throws a
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
  STATUS,
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

/** Finalize (`sendBy`): drafts only. */
export function assertFinalizable(doc: LifecycleDocument): void {
  refuseTemplate(doc, "finalized");
  if (doc.status !== STATUS.draft) {
    refuse(
      `${documentRef(doc, true)} is not a draft (${statusText(doc)}); only drafts can be ` +
        `finalized, and this one already was.`,
    );
  }
}

/**
 * Send by email (`sendViaEmail`): any document except recurring invoice templates. sevDesk
 * finalizes a draft it sends, which is a commit-level step, so a draft is only accepted when the
 * caller may finalize (`finalizeAllowed`: the commit tier is enabled); an external-only setup
 * would otherwise finalize documents through the back door.
 */
export function assertEmailable(doc: LifecycleDocument, finalizeAllowed: boolean): void {
  refuseTemplate(doc, "sent by email");
  if (doc.status === STATUS.draft && !finalizeAllowed) {
    const { toolPrefix } = KINDS[doc.kind];
    refuse(
      `${documentRef(doc, true)} is a draft: sending it by email would also finalize it ` +
        `(draft → ${doc.kind === "order" ? "sent" : "open"}), which needs the commit tier. ` +
        `Finalize it first with ${toolPrefix}_finalize (needs the commit tier), or enable commit ` +
        `(SEVDESK_ALLOW).`,
    );
  }
}

/** Book a payment (`bookAmount`): open or partially paid invoices and credit notes. */
export function assertBookable(doc: LifecycleDocument<PaymentKind>): void {
  const { toolPrefix, noun } = KINDS[doc.kind];
  refuseTemplate(doc, "paid");
  refuseCancellation(doc, "paid");
  if (isInvoiceType(doc, "MA")) {
    refuse(
      `${documentRef(doc, true)} is a payment reminder (Mahnung, MA). Book the payment on the ` +
        `invoice it reminds of; sevdesk_invoice_get shows that invoice as origin.`,
    );
  }
  if (doc.status === STATUS.draft) {
    refuse(
      `${documentRef(doc, true)} is a draft; sevDesk books payments only on finalized ` +
        `documents. Finalize it first with ${toolPrefix}_finalize.`,
    );
  }
  if (doc.status === STATUS.paid) {
    refuse(
      `${documentRef(doc, true)} is already paid (${statusText(doc)}). To undo its payments, ` +
        `reset it to open with ${toolPrefix}_reset.`,
    );
  }
  if (doc.status !== STATUS.open && doc.status !== STATUS.partiallyPaid) {
    refuse(
      `${documentRef(doc, true)} has ${statusText(doc)}; payments can only be booked on open or ` +
        `partially paid ${noun}s.`,
    );
  }
}

/** Cancel (`cancelInvoice`, Storno): open, unpaid invoices of type RE, AR, TR or ER. */
export function assertCancellable(doc: LifecycleDocument<"invoice">): void {
  const ref = documentRef(doc, true);
  refuseCancellation(doc, "cancelled");
  refuseTemplate(doc, "cancelled");
  if (isInvoiceType(doc, "MA")) {
    refuse(`${ref} is a payment reminder (Mahnung, MA); reminders cannot be cancelled here.`);
  }
  if (doc.typeCode === undefined || !CANCELLABLE_INVOICE_TYPES.has(doc.typeCode)) {
    refuse(`${ref} has an invoice type that sevdesk_invoice_cancel does not handle.`);
  }
  if (doc.status === STATUS.draft) {
    refuse(
      `${ref} is a draft: a draft has no legal effect and needs no cancellation. Change it with ` +
        `sevdesk_invoice_update_draft or delete it in sevDesk.`,
    );
  }
  if (doc.status === STATUS.partiallyPaid || (doc.status === STATUS.open && hasPayments(doc))) {
    refuse(
      `${ref} is partially paid; sevDesk cancels only unpaid invoices. Create a credit note ` +
        `(Gutschrift) for it with sevdesk_credit_note_create_from_invoice.`,
    );
  }
  if (doc.status === STATUS.paid) {
    refuse(
      `${ref} has ${statusText(doc)}; cancelling only works for open, unpaid invoices. If it ` +
        `was paid, create a credit note with sevdesk_credit_note_create_from_invoice. If it was ` +
        `cancelled before (sevDesk keeps a cancelled invoice at status 1000 with nothing paid), ` +
        `its cancellation invoice is listed by sevdesk_invoices_list with type cancellation.`,
    );
  }
  if (doc.status !== STATUS.open) {
    refuse(`${ref} has ${statusText(doc)}; only open, unpaid invoices can be cancelled.`);
  }
}

/** Enshrine (`enshrine`, festschreiben): from status open (200) on, once. */
export function assertEnshrinable(doc: LifecycleDocument<PaymentKind>): void {
  const ref = documentRef(doc, true);
  refuseTemplate(doc, "enshrined");
  if (doc.enshrined) {
    refuse(`${ref} is already enshrined (festgeschrieben); there is nothing to do.`);
  }
  if (doc.status === STATUS.draft) {
    refuse(
      `${ref} is a draft; sevDesk enshrines documents only from status open (200) on. Finalize ` +
        `it first with ${KINDS[doc.kind].toolPrefix}_finalize.`,
    );
  }
  if (doc.status < STATUS.open) {
    refuse(`${ref} has ${statusText(doc)}; only open or later documents can be enshrined.`);
  }
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
  refuseCancellation(doc, "reset");
  refuseTemplate(doc, "reset");
  if (to === "open") {
    if (doc.status === STATUS.draft) {
      refuse(
        `${ref} is a draft; a reset cannot raise the status. Open it by finalizing it with ` +
          `${toolPrefix}_finalize.`,
      );
    }
    if (
      doc.kind === "invoice" &&
      doc.status === STATUS.paid &&
      doc.paidAmount !== undefined &&
      !hasPayments(doc)
    ) {
      refuse(
        `${ref} is marked paid with nothing paid, which is how sevDesk shows a cancelled ` +
          `invoice (Storno); a cancelled invoice cannot be reset.`,
      );
    }
    if (doc.status === STATUS.open && !hasPayments(doc)) {
      refuse(`${ref} is already open with no payments booked; there is nothing to reset.`);
    }
    if (
      doc.status !== STATUS.partiallyPaid &&
      doc.status !== STATUS.paid &&
      doc.status !== STATUS.open
    ) {
      refuse(`${ref} has ${statusText(doc)}; only paid or partially paid documents reset to open.`);
    }
    return;
  }
  if (doc.status === STATUS.draft) {
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
  if (doc.status === STATUS.partiallyPaid || doc.status === STATUS.paid || hasPayments(doc)) {
    refuse(
      `${ref} has payments booked (${statusText(doc)}); sevDesk resets only open documents to ` +
        `draft. Reset it to open first (${toolPrefix}_reset with to "open"), which unlinks the ` +
        `payments, then reset it to draft.`,
    );
  }
  if (doc.status !== STATUS.open) {
    refuse(`${ref} has ${statusText(doc)}; only open documents reset to draft.`);
  }
}
