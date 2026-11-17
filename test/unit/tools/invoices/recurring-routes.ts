/**
 * Fake-client routes for `sevdesk_invoice_create_recurring` (its unit tests, the regression tests
 * and the write case): the reads of an invoice draft create (`../drafts/routes.ts`), a save that
 * answers with template 2301, and its read-back (`test/fixtures/recurring/`).
 */
import { TEMPLATE_SETTINGS_EMBED } from "../../../../src/domain/recurring/schedule.js";
import { type FakeRoute, loadFixture } from "../../../helpers/fake-client.js";
import { invoiceCreateArgs, invoiceCreateRoutes } from "../drafts/routes.js";

/** The save of a new template: `saveInvoice` answering with invoice 2301. */
const saveTemplateRoute: FakeRoute = {
  method: "POST",
  path: "/Invoice/Factory/saveInvoice",
  response: {
    body: { objects: { invoice: { id: "2301", objectName: "Invoice" }, invoicePos: [] } },
  },
};

/** The stored template 2301 (the fixture's plain record) with `overrides`. */
export function templateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const [row] = (loadFixture("recurring/template-2301.json").body as { objects: unknown[] })
    .objects as Record<string, unknown>[];
  return { ...row, ...overrides };
}

/**
 * What `embed=propertyAutoGenerateRecurringInvoice,autoSendConfiguration` adds to a template saved
 * with automatic generation on (recorded 2026-11-17, D-132): "1", and no sending configuration.
 */
export const SETTINGS_ON = {
  propertyAutoGenerateRecurringInvoice: "1",
  autoSendConfiguration: null,
} as const;

/** The same for a template saved without it: never set reads `null` (off). */
export const SETTINGS_NEVER_SET = {
  propertyAutoGenerateRecurringInvoice: null,
  autoSendConfiguration: null,
} as const;

/** `GET /Invoice/2301` with the settings embed (the create's raw read-back), answering `row`. */
export function settingsReadRoute(row: Record<string, unknown>): FakeRoute {
  return {
    path: "/Invoice/2301",
    query: { embed: TEMPLATE_SETTINGS_EMBED },
    response: { body: { objects: [row] } },
  };
}

/** The template as sevDesk stores it: the invoice read, the raw read with settings, positions. */
const templateReadBackRoutes: readonly FakeRoute[] = [
  {
    path: "/Invoice/2301",
    query: { embed: "contact" },
    response: { fixture: "recurring/template-2301.json" },
  },
  settingsReadRoute(templateRow(SETTINGS_ON)),
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
