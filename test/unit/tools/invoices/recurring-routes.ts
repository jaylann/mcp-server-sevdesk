/**
 * Fake-client routes for `sevdesk_invoice_create_recurring` (its unit tests, the regression tests
 * and the write case): the reads of an invoice draft create (`../drafts/routes.ts`), a save that
 * answers with template 2301, and its read-back (`test/fixtures/recurring/`).
 */
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { invoiceCreateArgs, invoiceCreateRoutes } from "../drafts/routes.js";

/** The save of a new template: `saveInvoice` answering with invoice 2301. */
const saveTemplateRoute: FakeRoute = {
  method: "POST",
  path: "/Invoice/Factory/saveInvoice",
  response: {
    body: { objects: { invoice: { id: "2301", objectName: "Invoice" }, invoicePos: [] } },
  },
};

/** `GET /Invoice/2301?embed=contact` and its positions: the template as sevDesk stores it. */
const templateReadBackRoutes: readonly FakeRoute[] = [
  {
    path: "/Invoice/2301",
    query: { embed: "contact" },
    response: { fixture: "recurring/template-2301.json" },
  },
  {
    path: "/InvoicePos",
    query: { "invoice[id]": 2301 },
    response: { fixture: "recurring/template-positions-2301.json" },
  },
];

/**
 * Every route of a create: the draft create's reads (no duplicates, no templates of contact 1001)
 * behind the template's save and read-back, which win as they come first.
 */
export const recurringCreateRoutes: readonly FakeRoute[] = [
  saveTemplateRoute,
  ...templateReadBackRoutes,
  ...invoiceCreateRoutes,
];

/** A monthly template from 2026-12-01 with the positions of the draft tests (65.45 EUR gross). */
export const recurringCreateArgs = {
  ...invoiceCreateArgs,
  interval: "monthly",
  startDate: "2026-12-01",
};
