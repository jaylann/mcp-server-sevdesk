/**
 * The binding requests of the lifecycle tools: one function per sevDesk endpoint that finalizes,
 * emails, enshrines, resets, cancels or pays a document. The tools check and preview first
 * (`transitions.ts`, `payments.ts`, `email.ts`) and call these from `execute` with the client
 * scoped to their tier; the paths and the request shapes are built only here, so the tool layer
 * never talks to the client itself (review 2026-11, round 3).
 *
 * Every request here changes data, so the client sends it once and never retries it. None of
 * these functions reads the document back: what a failed read-back means for the caller (the
 * write happened) is the tool's to report.
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { parseUpstream, zId } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { SEND_TYPE_CODES, type SentVia } from "../document-positions.js";
import { KINDS, type PaymentKind, type SalesKind } from "./documents.js";
import type { SendEmailPayload } from "./email.js";
import type { BookAmountPayload } from "./payments.js";
import type { ResetTarget } from "./transitions.js";

/** Outgoing `sendBy` body (strict: sevDesk ignores unknown fields silently, D-003). */
const sendByPayloadSchema = z.strictObject({
  sendType: z.enum(["VPDF", "VP", "VPR", "VM"]),
  sendDraft: z.literal(false),
});

export type SendByPayload = z.output<typeof sendByPayloadSchema>;

/** The `sendBy` body that marks a document as sent `via`; `sendDraft` is always `false`. */
export function sendByPayload(via: SentVia): SendByPayload {
  return sendByPayloadSchema.parse({ sendType: SEND_TYPE_CODES[via], sendDraft: false });
}

/**
 * Finalizes a draft by marking it as sent: `PUT /{Invoice|CreditNote|Order}/{id}/sendBy`. sevDesk
 * assigns the final number and books the document; it sends nothing to anyone.
 */
export async function finalizeDocument(
  client: SevdeskClient,
  kind: SalesKind,
  id: number,
  payload: SendByPayload,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath(KINDS[kind].objectName, id, "sendBy"),
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Emails a document through sevDesk: `POST /{Invoice|CreditNote|Order}/{id}/sendViaEmail` with
 * the body from `buildEmail`. The email leaves at once; a draft is finalized by it.
 */
export async function emailDocument(
  client: SevdeskClient,
  kind: SalesKind,
  id: number,
  payload: SendEmailPayload,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "POST",
    path: sevdeskPath(KINDS[kind].objectName, id, "sendViaEmail"),
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Enshrines a document for good: `PUT /{Invoice|CreditNote|Voucher}/{id}/enshrine`, no body. */
export async function enshrineDocument(
  client: SevdeskClient,
  kind: PaymentKind,
  id: number,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath(KINDS[kind].objectName, id, "enshrine"),
    ...(signal === undefined ? {} : { signal }),
  });
}

const RESET_ENDPOINT: Readonly<Record<ResetTarget, string>> = {
  open: "resetToOpen",
  draft: "resetToDraft",
};

/**
 * Takes a document back one step: `PUT /{Invoice|CreditNote|Voucher}/{id}/resetToOpen` (unlinks
 * every payment of the document) or `…/resetToDraft`, no body.
 */
export async function resetDocument(
  client: SevdeskClient,
  kind: PaymentKind,
  id: number,
  to: ResetTarget,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath(KINDS[kind].objectName, id, RESET_ENDPOINT[to]),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Books one payment: `PUT /{Invoice|CreditNote|Voucher}/{id}/bookAmount` with the body from
 * `planPayment` (amount signed as the money moves, see `payments.ts`).
 */
export async function bookPayment(
  client: SevdeskClient,
  kind: PaymentKind,
  id: number,
  payload: BookAmountPayload,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath(KINDS[kind].objectName, id, "bookAmount"),
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
}

const createdSchema = z.object({ id: zId });

/**
 * Cancels an invoice: `POST /Invoice/{id}/cancelInvoice`, no body. sevDesk answers with the new
 * cancellation invoice (type SR). Returns its id, or `undefined` when the answer does not name
 * one: the cancellation happened all the same, so the caller must report it as a completed write
 * and not send the request again.
 */
export async function cancelInvoice(
  client: SevdeskClient,
  id: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const payload = await client.request({
    method: "POST",
    path: sevdeskPath("Invoice", id, "cancelInvoice"),
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    return parseUpstream(
      createdSchema,
      expectSingle(payload, "cancellation invoice"),
      "a cancellation invoice",
    ).id;
  } catch (error) {
    if (error instanceof SevdeskError) return undefined;
    throw error;
  }
}
