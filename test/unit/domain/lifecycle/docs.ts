/**
 * Lifecycle snapshots for domain tests, built from the M2 record fixtures (see
 * `test/unit/tools/lifecycle/helpers.ts`) the same way `readLifecycleDocument` builds them.
 */
import { mapCreditNoteDetail } from "../../../../src/domain/credit-notes.js";
import { mapInvoiceDetail } from "../../../../src/domain/invoices.js";
import {
  type LifecycleDocument,
  toLifecycleDocument,
} from "../../../../src/domain/lifecycle/documents.js";
import { mapOrderDetail } from "../../../../src/domain/orders.js";
import { zOptionalDecimal } from "../../../../src/sevdesk/schema.js";
import { creditNoteRow, invoiceRow, orderRow, type Row } from "../../tools/lifecycle/helpers.js";

const TODAY = "2026-11-07";

function paidOf(row: Row): string | undefined {
  return zOptionalDecimal.parse(row["paidAmount"]);
}

/** Invoice 1001 (open, 177.33 EUR gross, nothing paid) with `overrides` on the raw record. */
export function invoiceDoc(overrides: Row = {}): LifecycleDocument<"invoice"> {
  const row = invoiceRow(overrides);
  return toLifecycleDocument("invoice", mapInvoiceDetail(row, TODAY), paidOf(row));
}

/** Credit note 2001 (open, 23.80 EUR gross, no paidAmount) with `overrides`. */
export function creditNoteDoc(overrides: Row = {}): LifecycleDocument<"creditNote"> {
  const row = creditNoteRow(overrides);
  return toLifecycleDocument("creditNote", mapCreditNoteDetail(row), paidOf(row));
}

/** Order 3002 (AB, accepted 500) with `overrides`. */
export function orderDoc(overrides: Row = {}): LifecycleDocument<"order"> {
  const row = orderRow(overrides);
  return toLifecycleDocument("order", mapOrderDetail(row), paidOf(row));
}
