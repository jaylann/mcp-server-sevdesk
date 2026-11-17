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
 * `recurring_gaps` lets a voucher known only by name join the contact whose vouchers carry that
 * name ({@link supplierKeysJoiningNames}).
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

/** A supplier name as compared: sanitized, lower case, single spaces; `undefined` when empty. */
function normalizedName(name: string | undefined): string | undefined {
  const text = cleanText(name, NAME_MAX)?.toLowerCase().replace(/\s+/g, " ");
  return text === undefined || text === "" ? undefined : text;
}

/**
 * Who sent a voucher, as a comparable key: `id:<contact id>`, else `name:<normalized supplier
 * name>`; `undefined` when sevDesk knows neither.
 */
export function supplierKey(header: DocumentHeader): string | undefined {
  const contact = header.contact;
  if (contact?.id !== undefined) return `id:${String(contact.id)}`;
  const name = normalizedName(contact?.name);
  return name === undefined ? undefined : `name:${name}`;
}

/**
 * {@link supplierKey} for the vouchers of one listing, except that a voucher known only by its
 * supplier name joins the contact whose vouchers carry the same name (normalized), when exactly
 * one contact does. sevDesk keeps the supplier name next to the contact, so a bill booked once
 * without the contact (by hand, or by sevDesk's receipt recognition) still counts for that
 * supplier instead of leaving a hole in its series. A name shared by two contacts joins neither.
 */
export function supplierKeysJoiningNames(
  headers: readonly DocumentHeader[],
): (header: DocumentHeader) => string | undefined {
  const contactsByName = new Map<string, Set<number>>();
  for (const header of headers) {
    const id = header.contact?.id;
    const name = normalizedName(header.contact?.name);
    if (id === undefined || name === undefined) continue;
    const ids = contactsByName.get(name) ?? new Set<number>();
    ids.add(id);
    contactsByName.set(name, ids);
  }
  return (header) => {
    if (header.contact?.id !== undefined) return supplierKey(header);
    const name = normalizedName(header.contact?.name);
    const ids = name === undefined ? undefined : contactsByName.get(name);
    const [only] = ids !== undefined && ids.size === 1 ? [...ids] : [];
    return only === undefined ? supplierKey(header) : `id:${String(only)}`;
  };
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
