import { CREDIT_NOTE_LIFECYCLE_TOOLS } from "../../src/tools/credit-notes/lifecycle-tools.js";
import { documentDeleteDraftTool } from "../../src/tools/documents/delete-draft-tool.js";
import { documentSetLayoutTool } from "../../src/tools/documents/layout-tool.js";
import { INVOICE_LIFECYCLE_TOOLS } from "../../src/tools/invoices/lifecycle-tools.js";
import { ORDER_LIFECYCLE_TOOLS } from "../../src/tools/orders/lifecycle-tools.js";
import type { AnyToolDefinition, AnyWriteToolDefinition } from "../../src/tools/types.js";
import { isWriteTool } from "../../src/tools/types.js";
import { letterpapersRoute, templatesRoute } from "../helpers/layout-routes.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import { discountRow, discountsRoute } from "../unit/tools/drafts/routes.js";
import {
  accountRoute,
  accountRow,
  changeParameterRoute,
  creditNoteRow,
  documentRoute,
  fixtureRow,
  invoiceRow,
  orderRow,
  positionRoutes,
  transactionRoute,
  transactionRow,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

/** A shipped lifecycle tool by name (fails loudly when it is missing). */
function tool(name: string): AnyWriteToolDefinition {
  const all: readonly AnyToolDefinition[] = [
    ...INVOICE_LIFECYCLE_TOOLS,
    ...CREDIT_NOTE_LIFECYCLE_TOOLS,
    ...ORDER_LIFECYCLE_TOOLS,
  ];
  const found = all.find((candidate) => candidate.name === name);
  if (found === undefined || !isWriteTool(found)) throw new Error(`no write tool ${name}`);
  return found;
}

const draftInvoice = invoiceRow({
  status: "100",
  invoiceNumber: null,
  sendDate: null,
  sendType: null,
});
const openInvoice = invoiceRow();
const paidInvoice = invoiceRow({ status: "1000", paidAmount: 177.33 });
/** A credit note draft carries its number (sevdesk_credit_note_create_draft reserves it). */
const draftCreditNote = creditNoteRow({ status: "100", creditNoteNumber: "GU-1101" });
const openCreditNote = creditNoteRow();
const draftOrder = orderRow({ status: "100", orderNumber: null });
const email = { to: "kunde@example.com", subject: "Ihre Unterlagen", text: "Guten Tag, anbei." };

/** Write-tool cases owned by the M3 lifecycle work (see test/helpers/write-cases.ts). */
const CASES: readonly WriteToolCase[] = [
  {
    label: "finalize a draft invoice",
    tool: tool("sevdesk_invoice_finalize"),
    args: { id: 1001 },
    routes: [
      documentRoute("invoice", draftInvoice),
      writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/sendBy" }],
  },
  {
    label: "finalize a draft credit note",
    tool: tool("sevdesk_credit_note_finalize"),
    args: { id: 2001, sentVia: "post" },
    routes: [
      documentRoute("creditNote", draftCreditNote),
      writeRoute("PUT", "/CreditNote/2001/sendBy", "credit-note-send-by.json"),
    ],
    writes: [{ method: "PUT", path: "/CreditNote/2001/sendBy" }],
  },
  {
    label: "finalize a draft order",
    tool: tool("sevdesk_order_finalize"),
    args: { id: 3002 },
    routes: [
      documentRoute("order", draftOrder),
      writeRoute("PUT", "/Order/3002/sendBy", "order-send-by.json"),
    ],
    writes: [{ method: "PUT", path: "/Order/3002/sendBy" }],
  },
  {
    label: "email an open invoice",
    tool: tool("sevdesk_invoice_send_email"),
    args: { id: 1001, ...email },
    routes: [
      documentRoute("invoice", openInvoice),
      writeRoute("POST", "/Invoice/1001/sendViaEmail", "invoice-send-via-email.json"),
    ],
    writes: [{ method: "POST", path: "/Invoice/1001/sendViaEmail" }],
  },
  {
    label: "email an open credit note",
    tool: tool("sevdesk_credit_note_send_email"),
    args: { id: 2001, ...email },
    routes: [
      documentRoute("creditNote", openCreditNote),
      writeRoute("POST", "/CreditNote/2001/sendViaEmail", "credit-note-send-via-email.json"),
    ],
    writes: [{ method: "POST", path: "/CreditNote/2001/sendViaEmail" }],
  },
  {
    label: "email an order",
    tool: tool("sevdesk_order_send_email"),
    args: { id: 3002, ...email },
    routes: [
      documentRoute("order", orderRow()),
      writeRoute("POST", "/Order/3002/sendViaEmail", "order-send-via-email.json"),
    ],
    writes: [{ method: "POST", path: "/Order/3002/sendViaEmail" }],
  },
  {
    label: "book an invoice payment linked to a bank transaction",
    tool: tool("sevdesk_invoice_book_payment"),
    args: {
      id: 1001,
      amount: "177.33",
      date: "2026-11-02",
      checkAccountId: 4002,
      transactionId: 5101,
    },
    routes: [
      documentRoute("invoice", openInvoice),
      accountRoute(accountRow(4002)),
      transactionRoute(transactionRow()),
      // The transaction's booking log (read for a free transaction): no entries.
      { path: "/CheckAccountTransactionLog", response: { body: { objects: [] } } },
      writeRoute("PUT", "/Invoice/1001/bookAmount", "invoice-book-amount.json"),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/bookAmount" }],
  },
  {
    label: "book a credit note payout on the offline account",
    tool: tool("sevdesk_credit_note_book_payment"),
    args: { id: 2001, amount: "23.80", date: "2026-11-02", checkAccountId: 4001 },
    routes: [
      documentRoute("creditNote", openCreditNote),
      accountRoute(accountRow(4001)),
      writeRoute("PUT", "/CreditNote/2001/bookAmount", "credit-note-book-amount.json"),
    ],
    writes: [{ method: "PUT", path: "/CreditNote/2001/bookAmount" }],
  },
  {
    label: "cancel an open, unpaid invoice",
    tool: tool("sevdesk_invoice_cancel"),
    args: { id: 1001 },
    routes: [
      documentRoute("invoice", openInvoice),
      documentRoute("invoice", fixtureRow("invoice-cancel.json")),
      writeRoute("POST", "/Invoice/1001/cancelInvoice", "invoice-cancel.json"),
    ],
    writes: [{ method: "POST", path: "/Invoice/1001/cancelInvoice" }],
  },
  {
    label: "enshrine an open invoice",
    tool: tool("sevdesk_invoice_enshrine"),
    args: { id: 1001 },
    routes: [
      documentRoute("invoice", openInvoice),
      writeRoute("PUT", "/Invoice/1001/enshrine", "enshrine.json"),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/enshrine" }],
  },
  {
    label: "enshrine an open credit note",
    tool: tool("sevdesk_credit_note_enshrine"),
    args: { id: 2001 },
    routes: [
      documentRoute("creditNote", openCreditNote),
      writeRoute("PUT", "/CreditNote/2001/enshrine", "enshrine.json"),
    ],
    writes: [{ method: "PUT", path: "/CreditNote/2001/enshrine" }],
  },
  {
    label: "reset a paid invoice to open",
    tool: tool("sevdesk_invoice_reset"),
    args: { id: 1001, to: "open" },
    routes: [
      documentRoute("invoice", paidInvoice),
      writeRoute("PUT", "/Invoice/1001/resetToOpen", "invoice-reset.json"),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/resetToOpen" }],
  },
  {
    label: "reset an open credit note to draft",
    tool: tool("sevdesk_credit_note_reset"),
    args: { id: 2001, to: "draft" },
    routes: [
      documentRoute("creditNote", openCreditNote),
      writeRoute("PUT", "/CreditNote/2001/resetToDraft", "credit-note-reset.json"),
    ],
    writes: [{ method: "PUT", path: "/CreditNote/2001/resetToDraft" }],
  },
  // Its own invoice (1002), so no other case asks about the same record.
  {
    label: "finalize a draft invoice with a discount on the whole invoice",
    tool: tool("sevdesk_invoice_finalize"),
    args: { id: 1002 },
    routes: [
      documentRoute("invoice", {
        ...draftInvoice,
        id: "1002",
        sumDiscountNet: "-4.47",
        sumDiscountGross: "-5.32",
      }),
      discountsRoute("Invoice", 1002, [
        discountRow("Invoice", 1002, { value: "3", text: "Treuerabatt" }),
      ]),
      writeRoute("PUT", "/Invoice/1002/sendBy", "invoice-send-by.json"),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1002/sendBy" }],
  },
  // Its own invoice (1003): language, template and letterhead, one request each (D-113).
  {
    label: "set language, template and letterhead of a draft invoice",
    tool: documentSetLayoutTool,
    args: {
      kind: "invoice",
      id: 1003,
      language: "en_US",
      template: "Modern",
      letterpaper: "Zweites Briefpapier",
    },
    routes: [
      documentRoute("invoice", { ...draftInvoice, id: "1003" }),
      templatesRoute("Invoice"),
      letterpapersRoute(),
      changeParameterRoute("/Invoice/1003/changeParameter", "invoice", {
        language: "en",
        template: "tpl-modern",
        letterpaper: "lp-2",
      }),
    ],
    writes: [
      { method: "PUT", path: "/Invoice/1003/changeParameter" },
      { method: "PUT", path: "/Invoice/1003/changeParameter" },
      { method: "PUT", path: "/Invoice/1003/changeParameter" },
    ],
  },
  // An order needs a PDF preview first (getPdf with preventSendBy, a read, D-113).
  {
    label: "set the language of a draft order",
    tool: documentSetLayoutTool,
    args: { kind: "order", id: 3002, language: "en_US" },
    routes: [
      documentRoute("order", draftOrder),
      {
        path: "/Order/3002/getPdf",
        query: { preventSendBy: true },
        response: { fixture: "documents/order-pdf.json" },
      },
      changeParameterRoute("/Order/3002/changeParameter", "order", { language: "en_US" }),
    ],
    writes: [{ method: "PUT", path: "/Order/3002/changeParameter" }],
  },
  {
    label: "delete a numbered credit note draft",
    tool: documentDeleteDraftTool,
    args: { kind: "credit_note", id: 2001 },
    routes: [
      documentRoute("creditNote", draftCreditNote),
      writeRoute("DELETE", "/CreditNote/2001", "document-delete.json"),
    ],
    writes: [{ method: "DELETE", path: "/CreditNote/2001" }],
  },
  // Its own invoice (1004): numbered and sent, as after a reset to draft (the gap warning).
  {
    label: "delete an invoice draft that has a number and was sent",
    tool: documentDeleteDraftTool,
    args: { kind: "invoice", id: 1004 },
    routes: [
      documentRoute("invoice", { ...openInvoice, id: "1004", status: "100" }),
      writeRoute("DELETE", "/Invoice/1004", "document-delete.json"),
    ],
    writes: [{ method: "DELETE", path: "/Invoice/1004" }],
  },
];

/**
 * Every case also serves empty position lists, no document discounts and the default layout, read
 * by the approval binding (`documentBinding`); a case's own routes come first.
 */
export const LIFECYCLE_CASES: readonly WriteToolCase[] = CASES.map((testCase) => ({
  ...testCase,
  routes: [...testCase.routes, ...positionRoutes()],
}));
