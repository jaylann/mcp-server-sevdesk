import { planVoucherFromEInvoice } from "../../domain/einvoice/voucher-suggestion.js";
import { bookPaymentTool } from "../lifecycle/book-payment.js";
import { enshrineTool } from "../lifecycle/enshrine.js";
import { resetTool } from "../lifecycle/reset.js";
import type { AnyToolDefinition } from "../types.js";
import { voucherCreateDraftTool } from "./draft-create.js";
import { voucherDeleteDraftTool } from "./draft-delete.js";
import { voucherUpdateDraftTool } from "./draft-update.js";
import { voucherFinalizeTool } from "./finalize.js";
import { voucherImportEInvoiceTool } from "./import-einvoice.js";

/**
 * Voucher (Beleg) write tools, M4 (m4-vouchers): drafts with receipt upload, the e-invoice import
 * (with the e-invoice module's planner), finalize, delete, and the lifecycle actions shared with
 * invoices and credit notes (book payment, reset, enshrine).
 */
export const VOUCHER_WRITE_TOOLS: readonly AnyToolDefinition[] = [
  voucherCreateDraftTool,
  voucherImportEInvoiceTool(planVoucherFromEInvoice),
  voucherUpdateDraftTool,
  voucherDeleteDraftTool,
  voucherFinalizeTool,
  bookPaymentTool("voucher"),
  resetTool("voucher"),
  enshrineTool("voucher"),
];
