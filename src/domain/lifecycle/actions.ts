/**
 * The binding requests of the lifecycle tools: one function per sevDesk endpoint that finalizes,
 * emails, enshrines, resets, cancels or pays a document, or accepts or rejects an offer. The
 * tools check and preview first (`transitions.ts`, `payments.ts`, `email.ts`) and call these
 * from `execute` with the client
 * scoped to their tier; the paths and the request shapes are built only here, so the tool layer
 * never talks to the client itself (review 2026-11, round 3).
 *
 * Every request here changes data, so the client sends it once and never retries it. None of
 * these functions reads the document back: what a failed read-back means for the caller (the
 * write happened) is the tool's to report. The exception is `deleteDocument`: sevDesk's answer
 * says nothing, so the plain GET that tells whether the document is gone is part of the delete.
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
import type { OfferStatusTarget, ResetTarget } from "./transitions.js";

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

/**
 * The `PUT /Order/{id}` body of an offer status change: the status and nothing else (strict:
 * sevDesk would take any other field of `Model_OrderUpdate` along, D-003, D-108).
 */
const orderStatusPayloadSchema = z.strictObject({
  status: z.union([z.literal(200), z.literal(300), z.literal(500)]),
});

export type OrderStatusPayload = z.output<typeof orderStatusPayloadSchema>;

/** The body that sets an offer to sent (200), rejected (300) or accepted (500). */
export function orderStatusPayload(status: OfferStatusTarget): OrderStatusPayload {
  return orderStatusPayloadSchema.parse({ status });
}

/**
 * Sets an offer's status: `PUT /Order/{id}` with `{status}` only (D-108). The answer is the order;
 * the caller reads it back itself.
 */
export async function setOrderStatus(
  client: SevdeskClient,
  id: number,
  payload: OrderStatusPayload,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath("Order", id),
    body: orderStatusPayloadSchema.parse(payload),
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

/**
 * Deletes a draft: `DELETE /{Invoice|CreditNote|Order}/{id}`, no body, sent once. sevDesk answers
 * `{objects: [null]}` for a draft, which is ignored, and 409 for any other status (recorded,
 * spec/deviations.md D-109, D-074); that 409 becomes a trusted message that nothing was deleted.
 *
 * The answer tells nothing, so a plain GET of the record afterwards does, as for vouchers
 * (`executeVoucherDelete`): `true` when sevDesk no longer finds the document, `false` when it
 * still returns one. Nothing is mapped, so only sevDesk's answer decides. Any other failure of
 * that GET, a {@link SevdeskError} or not, is thrown as a {@link SevdeskError} with the deletion
 * as a completed write: the DELETE was accepted, and nobody must send it again.
 */
export async function deleteDocument(
  client: SevdeskClient,
  kind: SalesKind,
  id: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const { objectName, noun, toolPrefix } = KINDS[kind];
  const path = sevdeskPath(objectName, id);
  const withSignal = signal === undefined ? {} : { signal };
  const what = `${noun} ${String(id)}`;
  try {
    await client.request({ method: "DELETE", path, ...withSignal });
  } catch (error) {
    if (error instanceof SevdeskError && error.status === 409) {
      throw new SevdeskError({
        kind: error.kind,
        status: 409,
        message:
          `sevDesk refused to delete ${what}: only drafts (status 100) can be deleted, and it is ` +
          "no longer one (probably finalized in the meantime). Nothing was deleted; check it " +
          `with ${toolPrefix}_get.`,
        ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
        cause: error,
      });
    }
    throw error;
  }
  try {
    expectSingle(await client.request({ method: "GET", path, ...withSignal }), what);
    return false;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") return true;
    const failed = `sevDesk accepted the deletion of ${what}, but the check afterwards failed`;
    const advice = `Do not delete again; check with ${toolPrefix}_get.`;
    throw new SevdeskError({
      kind: error instanceof SevdeskError ? error.kind : "unexpected_response",
      message:
        error instanceof SevdeskError
          ? `${failed}: ${error.message} ${advice}`
          : `${failed}. ${advice}`,
      cause: error,
      completedWrites: [{ objectName, id: String(id) }],
    });
  }
}
