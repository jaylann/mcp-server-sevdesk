/**
 * The vouchers (Belege) the `duplicates` and `recurring_gaps` checks read, and who sent them.
 *
 * Both checks work on voucher headers alone (`GET /Voucher` with `voucherType=VOU`, one request
 * per 1,000 rows, see `listDocumentHeaders`), drafts included, and read no positions. sevDesk's
 * recurring vouchers (type RV) are templates, not bills: the listing leaves them out and counts
 * them in `excluded.recurringTemplates`.
 *
 * A voucher's supplier is its contact; a voucher without a contact but with a supplier name
 * (sevDesk keeps the name typed on the receipt) is matched by that name, normalized (case and
 * spaces). A voucher with neither cannot be told apart from others and is not compared.
 */
import { cleanText } from "../../common.js";
import { type DocumentHeader, type HeaderList, listDocumentHeaders } from "../positions-scan.js";
import type { AuditCheckContext, AuditContact } from "./findings.js";

/** The vouchers of a date range: booked ones and drafts, each sorted by date and id. */
export interface VoucherRows {
  readonly booked: readonly DocumentHeader[];
  readonly drafts: readonly DocumentHeader[];
  readonly listed: HeaderList;
}

/**
 * Lists the vouchers dated `from`–`to` (document date), drafts included; with `receipts`, each
 * with its receipt file's checksum (`embed=document`, see `HeaderListParams.voucherReceipts`).
 */
export async function listVoucherRows(
  context: AuditCheckContext,
  from: string,
  to: string,
  options: { readonly receipts?: boolean | undefined } = {},
): Promise<VoucherRows> {
  const listed = await listDocumentHeaders(
    context.client,
    {
      from,
      to,
      kinds: ["voucher"],
      keepDrafts: true,
      voucherReceipts: options.receipts,
      maxRows: context.limits?.maxRows,
      today: context.today,
    },
    context.options,
  );
  return { booked: listed.headers, drafts: listed.drafts, listed };
}

const NAME_MAX = 200;

/**
 * Who sent a voucher, as a comparable key: `id:<contact id>`, else `name:<normalized supplier
 * name>`; `undefined` when sevDesk knows neither.
 */
export function supplierKey(header: DocumentHeader): string | undefined {
  const contact = header.contact;
  if (contact?.id !== undefined) return `id:${String(contact.id)}`;
  const name = cleanText(contact?.name, NAME_MAX)?.toLowerCase().replace(/\s+/g, " ");
  return name === undefined || name === "" ? undefined : `name:${name}`;
}

/** The contact a finding names for `header` (id and sanitized name as the mapper read them). */
export function contactOf(header: DocumentHeader): AuditContact | undefined {
  const contact = header.contact;
  if (contact === undefined || (contact.id === undefined && contact.name === undefined)) {
    return undefined;
  }
  return { id: contact.id, name: contact.name };
}

/** Whether `date` (YYYY-MM-DD) lies in the audited period. */
export function inPeriod(context: AuditCheckContext, date: string | undefined): boolean {
  return date !== undefined && date >= context.period.from && date <= context.period.to;
}
