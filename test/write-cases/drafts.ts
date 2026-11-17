import { creditNoteCreateDraftTool } from "../../src/tools/credit-notes/draft-create.js";
import { creditNoteUpdateDraftTool } from "../../src/tools/credit-notes/draft-update.js";
import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../src/tools/orders/draft-update.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  creditNoteUpdateRoutes,
  discountRow,
  discountsRoute,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "../unit/tools/drafts/routes.js";

/**
 * Write-tool cases owned by the M3 drafts work (see test/helpers/write-cases.ts). Dates default
 * to today, so every case passes explicit dates and stays independent of the clock. Order and
 * credit note creates reserve their number first (a side-effect GET with the write tier).
 */
export const DRAFTS_CASES: readonly WriteToolCase[] = [
  {
    label: "create a draft invoice",
    tool: invoiceCreateDraftTool,
    args: { ...invoiceCreateArgs, date: "2026-11-07" },
    routes: invoiceCreateRoutes,
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "update a draft invoice",
    tool: invoiceUpdateDraftTool,
    args: {
      id: 2102,
      header: "Rechnung Projekt X",
      positions: [{ name: "Wartung", quantity: 2, unitPrice: 80, taxRate: 19 }],
    },
    routes: invoiceUpdateRoutes,
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "create a draft credit note",
    tool: creditNoteCreateDraftTool,
    args: { ...creditNoteCreateArgs, date: "2026-11-07" },
    routes: creditNoteCreateRoutes,
    writes: [
      { method: "GET", path: "/CreditNote/Factory/getNextCreditNoteNumber" },
      { method: "POST", path: "/CreditNote/Factory/saveCreditNote" },
    ],
  },
  {
    label: "update a draft credit note",
    tool: creditNoteUpdateDraftTool,
    args: {
      id: 2202,
      header: "Gutschrift Reklamation 17",
      positions: [{ name: "Preisnachlass", quantity: 2, unitPrice: 25, taxRate: 19 }],
    },
    routes: creditNoteUpdateRoutes,
    writes: [{ method: "POST", path: "/CreditNote/Factory/saveCreditNote" }],
  },
  {
    label: "create a draft offer",
    tool: orderCreateDraftTool,
    args: { ...orderCreateArgs, date: "2026-11-07" },
    routes: orderCreateRoutes,
    writes: [
      { method: "GET", path: "/Order/Factory/getNextOrderNumber" },
      { method: "POST", path: "/Order/Factory/saveOrder" },
    ],
  },
  {
    label: "update a draft offer",
    tool: orderUpdateDraftTool,
    args: { id: 3102, paymentTerms: "30 Tage netto" },
    routes: orderUpdateRoutes,
    writes: [{ method: "POST", path: "/Order/Factory/saveOrder" }],
  },
  // A discount on the whole document (D-116) goes in the same save request.
  {
    label: "create a draft invoice with a discount",
    tool: invoiceCreateDraftTool,
    args: { ...invoiceCreateArgs, date: "2026-11-07", discount: { percent: 3 } },
    routes: invoiceCreateRoutes,
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "replace the discount of a draft offer",
    tool: orderUpdateDraftTool,
    args: { id: 3102, discount: { amount: 20, text: "Messerabatt" } },
    routes: withRoutes(
      orderUpdateRoutes,
      discountsRoute("Order", 3102, [discountRow("Order", 3102)]),
    ),
    writes: [{ method: "POST", path: "/Order/Factory/saveOrder" }],
  },
  {
    label: "remove the discount of a draft credit note",
    tool: creditNoteUpdateDraftTool,
    args: { id: 2202, discount: null },
    routes: withRoutes(
      creditNoteUpdateRoutes,
      discountsRoute("CreditNote", 2202, [discountRow("CreditNote", 2202)]),
    ),
    writes: [{ method: "POST", path: "/CreditNote/Factory/saveCreditNote" }],
  },
];
