/**
 * The documents the lifecycle tools act on (invoices, credit notes, orders, vouchers) as one
 * snapshot shape: the M2 detail DTO plus the few facts the lifecycle checks need in a uniform form
 * (status, type, totals, paid amount, enshrined, payment direction). Sales documents are read with
 * `GET /{Invoice|CreditNote|Order}/{id}?embed=contact`, vouchers with `GET /Voucher/{id}` (the
 * supplier's name is on the voucher itself), the same requests the M2 get tools make, without
 * positions.
 *
 * Per kind (see {@link KINDS}): the status codes differ (sales documents: draft 100, open 200;
 * vouchers: draft 50, open 100; both: partially paid 750, paid 1000), and so does the payment
 * direction. Invoices bring money in and credit notes pay it out, whatever the record says; a
 * voucher's direction comes from its own `creditDebit` (C expense = out, D revenue = in;
 * `bookingAmountSign` in `vouchers.ts`), so it lives on the snapshot (`direction`), not on the kind.
 *
 * `paidAmount` is the raw decimal sevDesk sent. Invoices and vouchers carry it (a JSON number or a
 * string in the recorded responses); the recorded credit note has no such field and the spec
 * declares none, so for credit notes it is usually `undefined` ("not reported"), never guessed as
 * zero here.
 */
import { z } from "zod";

import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import { parseUpstream, zOptionalDecimal } from "../../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../../sevdesk/types.js";
import type { Amounts } from "../common.js";
import { withDocumentCountry } from "../country-codes.js";
import { type CreditNoteDetail, mapCreditNoteDetail } from "../credit-notes.js";
import type { ContactRef } from "../document-positions.js";
import { type InvoiceDetail, mapInvoiceDetail } from "../invoices.js";
import { mapOrderDetail, type OrderDetail } from "../orders.js";
import type { PreviewLanguage } from "../preview-text.js";
import { documentTypeByCode } from "../reference-data.js";
import {
  mapVoucherDetail,
  VOUCHER_STATUS_CODES,
  VOUCHER_TYPE_CODES,
  type VoucherDetailDto,
} from "../vouchers.js";

/** Sales documents: the kinds that are finalized and emailed (`sendBy`, `sendViaEmail`). */
export type SalesKind = "invoice" | "creditNote" | "order";

/** The document kinds the lifecycle tools act on. */
export type LifecycleKind = SalesKind | "voucher";

/** The payment-carrying kinds (book payment, enshrine, reset). */
export type PaymentKind = Exclude<LifecycleKind, "order">;

/** How money moves on the check account when the document is paid. */
export type PaymentDirection = "in" | "out";

/** The status codes a lifecycle check compares against, per kind. */
export interface StatusTable {
  readonly draft: number;
  /** Finalized and unpaid (orders: sent). */
  readonly open: number;
  readonly partiallyPaid: number;
  readonly paid: number;
}

/** Trusted names of a document kind, for previews and messages. */
export interface KindInfo {
  readonly kind: LifecycleKind;
  /** sevDesk's `objectName` and path segment. */
  readonly objectName: "Invoice" | "CreditNote" | "Order" | "Voucher";
  /** English noun, lower case: "invoice", "credit note", "order", "voucher". */
  readonly noun: string;
  /** German noun: Rechnung, Gutschrift, Auftrag, Beleg. */
  readonly nounDe: string;
  /** Prefix of this kind's tool names, for "use … instead" hints: `sevdesk_invoice`. */
  readonly toolPrefix:
    "sevdesk_invoice" | "sevdesk_credit_note" | "sevdesk_order" | "sevdesk_voucher";
  /** Status codes of this kind (spec tags `Invoice`, `CreditNote`, `Order`, `Voucher`). */
  readonly status: StatusTable;
  /** Query of the lifecycle read (`GET /{objectName}/{id}`). */
  readonly readQuery: Readonly<Record<string, QueryValue>>;
  /** Preview text for a document without a number: "no number yet", "no Belegnummer". */
  readonly noNumber: string;
}

/** Document status codes of invoices, credit notes and orders (spec tags `Invoice`, `CreditNote`, `Order`). */
export const STATUS = {
  /** Invoices only: a deactivated recurring invoice (WKR). */
  deactivated: 50,
  draft: 100,
  open: 200,
  partiallyPaid: 750,
  paid: 1000,
} as const;

/** Voucher status codes (spec tag `Voucher` → "Types and status of vouchers"). */
export const VOUCHER_STATUS: StatusTable = {
  draft: VOUCHER_STATUS_CODES.draft,
  open: VOUCHER_STATUS_CODES.open,
  partiallyPaid: VOUCHER_STATUS_CODES.partially_paid,
  paid: VOUCHER_STATUS_CODES.paid,
};

const SALES_READ_QUERY = { embed: "contact" } as const;

export const KINDS: Readonly<Record<LifecycleKind, KindInfo>> = {
  invoice: {
    kind: "invoice",
    objectName: "Invoice",
    noun: "invoice",
    nounDe: "Rechnung",
    toolPrefix: "sevdesk_invoice",
    status: STATUS,
    readQuery: SALES_READ_QUERY,
    noNumber: "no number yet",
  },
  creditNote: {
    kind: "creditNote",
    objectName: "CreditNote",
    noun: "credit note",
    nounDe: "Gutschrift",
    toolPrefix: "sevdesk_credit_note",
    status: STATUS,
    readQuery: SALES_READ_QUERY,
    noNumber: "no number yet",
  },
  order: {
    kind: "order",
    objectName: "Order",
    noun: "order",
    nounDe: "Auftrag",
    toolPrefix: "sevdesk_order",
    status: STATUS,
    readQuery: SALES_READ_QUERY,
    noNumber: "no number yet",
  },
  voucher: {
    kind: "voucher",
    objectName: "Voucher",
    noun: "voucher",
    nounDe: "Beleg",
    toolPrefix: "sevdesk_voucher",
    status: VOUCHER_STATUS,
    readQuery: {},
    noNumber: "no Belegnummer",
  },
};

/** The status codes of `doc`'s kind. */
export function statusOf(doc: Pick<LifecycleDocument, "kind">): StatusTable {
  return KINDS[doc.kind].status;
}

/** The M2 detail DTO of each kind. */
export interface DetailByKind {
  readonly invoice: InvoiceDetail;
  readonly creditNote: CreditNoteDetail;
  readonly order: OrderDetail;
  readonly voucher: VoucherDetailDto;
}

/** A document as the lifecycle tools see it. */
export interface LifecycleDocument<K extends LifecycleKind = LifecycleKind> {
  readonly kind: K;
  readonly id: number;
  /**
   * Document number (cleaned upstream text); drafts usually have none yet. Vouchers: the
   * Belegnummer (sevDesk's `description`).
   */
  readonly number: string | undefined;
  /**
   * `invoiceType` (RE, SR, WKR, …), `orderType` (AN, AB, LI) or `voucherType` (VOU, RV);
   * `undefined` for credit notes.
   */
  readonly typeCode: string | undefined;
  /** German name of the type from reference data, e.g. "Rechnung", "Angebot", "Beleg". */
  readonly typeLabel: string | undefined;
  readonly status: number;
  /** Meaning of the status from reference data ("unknown" for undocumented codes). */
  readonly statusLabel: string;
  /** The customer, or a voucher's supplier (Lieferant) when it is a contact. */
  readonly contact: ContactRef | undefined;
  /** Vouchers only: the supplier or customer name (cleaned) when no contact is linked. */
  readonly partyName: string | undefined;
  readonly date: string | undefined;
  /** Invoices: invoice date plus payment term; vouchers: the payment deadline (Fälligkeit). */
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
  /**
   * How a payment moves money on the check account: invoices (and orders) in, credit notes out,
   * vouchers by their `creditDebit`; `undefined` for a voucher whose `creditDebit` is unreadable.
   */
  readonly direction: PaymentDirection | undefined;
  readonly dto: DetailByKind[K];
  /**
   * The record exactly as sevDesk sent it (untrusted, never shown), for the approval binding of
   * actions that make the stored document binding: the DTO cuts long texts and keeps only the
   * date of `update`, so it cannot tell every change apart. Set by {@link readLifecycleDocument}.
   */
  readonly raw?: unknown;
}

const MAPPERS: {
  readonly [K in LifecycleKind]: (
    raw: unknown,
    today: string,
    client: SevdeskClient,
    signal: AbortSignal | undefined,
    cacheOwner: object,
  ) => Promise<DetailByKind[K]>;
} = {
  invoice: (raw, today, client, signal, cacheOwner) =>
    withDocumentCountry(mapInvoiceDetail(raw, today), client, signal, cacheOwner),
  creditNote: (raw, _today, client, signal, cacheOwner) =>
    withDocumentCountry(mapCreditNoteDetail(raw), client, signal, cacheOwner),
  order: (raw, _today, client, signal, cacheOwner) =>
    withDocumentCountry(mapOrderDetail(raw), client, signal, cacheOwner),
  voucher: (raw) => Promise.resolve(mapVoucherDetail(raw)),
};

/** Payment direction of the sales kinds, fixed by the kind. */
const SALES_DIRECTION: Readonly<Record<SalesKind, PaymentDirection>> = {
  invoice: "in",
  creditNote: "out",
  order: "in",
};

const paidAmountSchema = z.object({ paidAmount: zOptionalDecimal });

/**
 * Reads one document (`GET /{objectName}/{id}` with the kind's query) and maps it. An unknown id
 * is sevDesk's `not_found` error; a record that does not fit is `unexpected_response`. `today`
 * (Berlin `YYYY-MM-DD`) only feeds the invoice DTO's `overdue` flag. Tools pass `ctx.config`
 * as `cacheOwner` to reuse the country table across preparation and read-backs.
 */
export async function readLifecycleDocument<K extends LifecycleKind>(
  client: SevdeskClient,
  kind: K,
  documentId: number,
  signal?: AbortSignal,
  today: string = berlinDateOf(Date.now()),
  cacheOwner: object = client,
): Promise<LifecycleDocument<K>> {
  const info = KINDS[kind];
  const id = toSevdeskId(documentId);
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath(info.objectName, id),
    ...(Object.keys(info.readQuery).length === 0 ? {} : { query: info.readQuery }),
    ...(signal === undefined ? {} : { signal }),
  });
  const raw = expectSingle(payload, `${info.noun} ${String(id)}`);
  const dto = await MAPPERS[kind](raw, today, client, signal, cacheOwner);
  const { paidAmount } = parseUpstream(paidAmountSchema, raw, `a ${info.noun}`);
  return { ...toLifecycleDocument(kind, dto, paidAmount), raw };
}

/** Builds the snapshot from a detail DTO and the raw paid amount. */
export function toLifecycleDocument<K extends LifecycleKind>(
  kind: K,
  dto: DetailByKind[K],
  paidAmount: string | undefined,
): LifecycleDocument<K> {
  if (kind === "voucher") {
    return voucherSnapshot(dto as VoucherDetailDto, paidAmount) as LifecycleDocument<K>;
  }
  const detail = dto as InvoiceDetail | CreditNoteDetail | OrderDetail;
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
    partyName: undefined,
    date: detail.date,
    dueDate: "dueDate" in detail ? detail.dueDate : undefined,
    currency: detail.currency,
    totals: detail.totals,
    totalsEur: detail.totalsEur,
    paidAmount,
    enshrined: "enshrined" in detail && detail.enshrined === true,
    eInvoice: "eInvoice" in detail ? detail.eInvoice : undefined,
    direction: SALES_DIRECTION[kind],
    dto,
  };
}

/** The snapshot of a voucher (Beleg). A voucher without a status cannot be checked. */
function voucherSnapshot(
  dto: VoucherDetailDto,
  paidAmount: string | undefined,
): LifecycleDocument<"voucher"> {
  if (dto.status === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: `sevDesk returned voucher ${String(dto.id)} without a status.`,
    });
  }
  const typeCode = dto.type === undefined ? undefined : VOUCHER_TYPE_CODES[dto.type];
  const type = typeCode === undefined ? undefined : documentTypeByCode("voucher", typeCode);
  const supplier = dto.supplier;
  return {
    kind: "voucher",
    id: dto.id,
    number: dto.number,
    typeCode,
    typeLabel: type?.labelDe,
    status: dto.status.code,
    statusLabel: dto.status.label,
    contact:
      supplier?.id === undefined
        ? undefined
        : supplier.name === undefined
          ? { id: supplier.id }
          : { id: supplier.id, name: supplier.name },
    partyName: supplier?.id === undefined ? supplier?.name : undefined,
    date: dto.date,
    dueDate: dto.paymentDeadline,
    currency: dto.currency,
    totals: dto.totals,
    totalsEur: dto.totalsEur,
    paidAmount,
    enshrined: dto.enshrined,
    eInvoice: undefined,
    direction: dto.paymentDirection,
    dto,
  };
}

/**
 * "invoice 1001" (or "Invoice 1001" with `capitalized`): a trusted reference to a document by its
 * id, for error messages, which never contain upstream text such as the document number. With
 * `lang: "de"` (preview sentences only; errors stay English) it is "Rechnung 1001".
 */
export function documentRef(
  doc: Pick<LifecycleDocument, "kind" | "id">,
  capitalized = false,
  lang: PreviewLanguage = "en",
): string {
  if (lang === "de") return `${KINDS[doc.kind].nounDe} ${String(doc.id)}`;
  const noun = KINDS[doc.kind].noun;
  const lead = capitalized ? noun.charAt(0).toUpperCase() + noun.slice(1) : noun;
  return `${lead} ${String(doc.id)}`;
}
