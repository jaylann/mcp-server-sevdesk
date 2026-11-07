/**
 * The documents the lifecycle tools act on (invoices, credit notes, orders) as one snapshot shape:
 * the M2 detail DTO plus the few facts the lifecycle checks need in a uniform form (status, type,
 * totals, paid amount, enshrined). Read with `GET /{Invoice|CreditNote|Order}/{id}?embed=contact`,
 * the same request the M2 get tools make, without positions.
 *
 * `paidAmount` is the raw decimal sevDesk sent. Invoices carry it (a JSON number in the recorded
 * responses); the recorded credit note has no such field and the spec declares none, so for credit
 * notes it is usually `undefined` ("not reported"), never guessed as zero here.
 */
import { z } from "zod";

import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import { parseUpstream, zOptionalDecimal } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { Amounts } from "../common.js";
import { type CreditNoteDetail, mapCreditNoteDetail } from "../credit-notes.js";
import type { ContactRef } from "../document-positions.js";
import { type InvoiceDetail, mapInvoiceDetail } from "../invoices.js";
import { mapOrderDetail, type OrderDetail } from "../orders.js";

/** The document kinds the lifecycle tools act on. */
export type LifecycleKind = "invoice" | "creditNote" | "order";

/** The payment-carrying kinds (book payment, cancel, enshrine, reset). */
export type PaymentKind = Exclude<LifecycleKind, "order">;

/** Trusted names of a document kind, for previews and messages. */
export interface KindInfo {
  readonly kind: LifecycleKind;
  /** sevDesk's `objectName` and path segment. */
  readonly objectName: "Invoice" | "CreditNote" | "Order";
  /** English noun, lower case: "invoice", "credit note", "order". */
  readonly noun: string;
  /** German noun: Rechnung, Gutschrift, Auftrag. */
  readonly nounDe: string;
  /** Prefix of this kind's tool names, for "use … instead" hints: `sevdesk_invoice`. */
  readonly toolPrefix: "sevdesk_invoice" | "sevdesk_credit_note" | "sevdesk_order";
}

export const KINDS: Readonly<Record<LifecycleKind, KindInfo>> = {
  invoice: {
    kind: "invoice",
    objectName: "Invoice",
    noun: "invoice",
    nounDe: "Rechnung",
    toolPrefix: "sevdesk_invoice",
  },
  creditNote: {
    kind: "creditNote",
    objectName: "CreditNote",
    noun: "credit note",
    nounDe: "Gutschrift",
    toolPrefix: "sevdesk_credit_note",
  },
  order: {
    kind: "order",
    objectName: "Order",
    noun: "order",
    nounDe: "Auftrag",
    toolPrefix: "sevdesk_order",
  },
};

/** The M2 detail DTO of each kind. */
export interface DetailByKind {
  readonly invoice: InvoiceDetail;
  readonly creditNote: CreditNoteDetail;
  readonly order: OrderDetail;
}

/** Document status codes (spec tags `Invoice`, `CreditNote`, `Order`). */
export const STATUS = {
  /** Invoices only: a deactivated recurring invoice (WKR). */
  deactivated: 50,
  draft: 100,
  open: 200,
  partiallyPaid: 750,
  paid: 1000,
} as const;

/** A document as the lifecycle tools see it. */
export interface LifecycleDocument<K extends LifecycleKind = LifecycleKind> {
  readonly kind: K;
  readonly id: number;
  /** Document number (cleaned upstream text); drafts usually have none yet. */
  readonly number: string | undefined;
  /** `invoiceType` (RE, SR, WKR, …) or `orderType` (AN, AB, LI); `undefined` for credit notes. */
  readonly typeCode: string | undefined;
  /** German name of the type from reference data, e.g. "Rechnung", "Angebot". */
  readonly typeLabel: string | undefined;
  readonly status: number;
  /** Meaning of the status from reference data ("unknown" for undocumented codes). */
  readonly statusLabel: string;
  readonly contact: ContactRef | undefined;
  readonly date: string | undefined;
  /** Invoices only: invoice date plus payment term. */
  readonly dueDate: string | undefined;
  readonly currency: string;
  /** Sums in the document currency. */
  readonly totals: Amounts;
  /** Foreign-currency documents only: the EUR sums sevDesk books. */
  readonly totalsEur: Amounts | undefined;
  /** Raw paid amount from sevDesk; `undefined` when sevDesk sent none (see the module doc). */
  readonly paidAmount: string | undefined;
  /** Festgeschrieben (orders: always false, they cannot be enshrined). */
  readonly enshrined: boolean;
  /** Invoices: whether sevDesk says it is an e-invoice; usually `undefined` (unknown). */
  readonly eInvoice: boolean | undefined;
  readonly dto: DetailByKind[K];
}

const MAPPERS: { readonly [K in LifecycleKind]: (raw: unknown, today: string) => DetailByKind[K] } =
  {
    invoice: mapInvoiceDetail,
    creditNote: (raw) => mapCreditNoteDetail(raw),
    order: (raw) => mapOrderDetail(raw),
  };

const paidAmountSchema = z.object({ paidAmount: zOptionalDecimal });

/**
 * Reads one document (`GET /{objectName}/{id}?embed=contact`) and maps it. An unknown id is
 * sevDesk's `not_found` error; a record that does not fit is `unexpected_response`. `today` (Berlin
 * `YYYY-MM-DD`) only feeds the invoice DTO's `overdue` flag.
 */
export async function readLifecycleDocument<K extends LifecycleKind>(
  client: SevdeskClient,
  kind: K,
  documentId: number,
  signal?: AbortSignal,
  today: string = berlinDateOf(Date.now()),
): Promise<LifecycleDocument<K>> {
  const info = KINDS[kind];
  const id = toSevdeskId(documentId);
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath(info.objectName, id),
    query: { embed: "contact" },
    ...(signal === undefined ? {} : { signal }),
  });
  const raw = expectSingle(payload, `${info.noun} ${String(id)}`);
  const dto = MAPPERS[kind](raw, today);
  const { paidAmount } = parseUpstream(paidAmountSchema, raw, `a ${info.noun}`);
  return toLifecycleDocument(kind, dto, paidAmount);
}

/** Builds the snapshot from a detail DTO and the raw paid amount. */
export function toLifecycleDocument<K extends LifecycleKind>(
  kind: K,
  dto: DetailByKind[K],
  paidAmount: string | undefined,
): LifecycleDocument<K> {
  const detail: InvoiceDetail | CreditNoteDetail | OrderDetail = dto;
  const type = "type" in detail ? detail.type : undefined;
  return {
    kind,
    id: detail.id,
    number: detail.number,
    typeCode: type?.code,
    typeLabel: type === undefined ? undefined : (type.labelDe ?? type.label),
    status: detail.status.code,
    statusLabel: detail.status.label,
    contact: detail.contact,
    date: detail.date,
    dueDate: "dueDate" in detail ? detail.dueDate : undefined,
    currency: detail.currency,
    totals: detail.totals,
    totalsEur: detail.totalsEur,
    paidAmount,
    enshrined: "enshrined" in detail && detail.enshrined === true,
    eInvoice: "eInvoice" in detail ? detail.eInvoice : undefined,
    dto,
  };
}

/**
 * "invoice 1001" (or "Invoice 1001" with `capitalized`): a trusted reference to a document by its
 * id, for error messages, which never contain upstream text such as the document number.
 */
export function documentRef(
  doc: Pick<LifecycleDocument, "kind" | "id">,
  capitalized = false,
): string {
  const noun = KINDS[doc.kind].noun;
  const lead = capitalized ? noun.charAt(0).toUpperCase() + noun.slice(1) : noun;
  return `${lead} ${String(doc.id)}`;
}
