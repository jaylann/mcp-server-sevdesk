/**
 * Fake-client routes for the tools that change, end and reactivate recurring invoice template
 * 2301 (their unit tests, the regression tests and the write cases): the template as sevDesk
 * stores it (`test/fixtures/recurring/`, with overrides), the reads of an invoice draft update
 * (`../drafts/routes.ts`), and a `saveInvoice` that answers with the template's id.
 */
import { todayInBerlin } from "../../../../src/domain/drafts/fields.js";
import { addMonths } from "../../../../src/domain/recurring/schedule.js";
import { type FakeRoute, loadFixture } from "../../../helpers/fake-client.js";
import { invoiceUpdateRoutes } from "../drafts/routes.js";

export type Row = Record<string, unknown>;

/**
 * Template 2301 as stored (monthly from 2026-12-01, status 100, 65.45 EUR) with `overrides`, its
 * contact 1001 embedded as `embed=contact` answers it.
 */
export function templateRow(overrides: Row = {}): Row {
  const [row] = (loadFixture("recurring/template-2301.json").body as { objects: Row[] }).objects;
  const [contact] = (loadFixture("contacts/contact-1001.json").body as { objects: Row[] }).objects;
  return { ...row, contact, ...overrides };
}

/** Its two position rows (5301 Beratung 3 × 10, 5302 Paket 1 × 25, net at 19 %). */
export function templatePositionRows(): Row[] {
  return structuredClone(
    (loadFixture("recurring/template-positions-2301.json").body as { objects: Row[] }).objects,
  );
}

/** Every read of template 2301 answers `row` (with and without `embed`), positions `positions`. */
export function templateRoutes(
  row: Row,
  positions: readonly Row[] = templatePositionRows(),
): FakeRoute[] {
  return [
    { path: "/Invoice/2301", response: { body: { objects: [row] } } },
    {
      path: "/InvoicePos",
      query: { "invoice[id]": 2301 },
      response: { body: { objects: positions } },
    },
  ];
}

/** `saveInvoice` answering with template 2301 (a change, an end or a reactivation). */
const saveTemplate2301Route: FakeRoute = {
  method: "POST",
  path: "/Invoice/Factory/saveInvoice",
  response: {
    body: { objects: { invoice: { id: "2301", objectName: "Invoice" }, invoicePos: [] } },
  },
};

/**
 * Every route of a change of template `row`: the template, the save, and the reads of an invoice
 * draft update (account, contact 1001, user, countries, units), which the template's routes win
 * against as they come first.
 */
export function templateChangeRoutes(
  row: Row = templateRow(),
  positions?: readonly Row[],
): FakeRoute[] {
  return [...templateRoutes(row, positions), saveTemplate2301Route, ...invoiceUpdateRoutes];
}

/** `YYYY-MM-DDT00:00:00+01:00`, the form sevDesk reads schedule dates back in (D-111). */
export function storedDate(date: string): string {
  return `${date}T00:00:00+01:00`;
}

/** The 1st of the month after today (Berlin): a next run that is never in the past. */
export function firstOfNextMonth(): string {
  return `${addMonths(todayInBerlin(), 1).slice(0, 8)}01`;
}

/**
 * Routes of an ended template (status 50) whose kept next run is the 1st of the month after the
 * day the routes are read, not loaded: the reactivation refuses a past next run, and a test with
 * a fixed clock (the German previews) gets the same dates every time.
 */
export function endedTemplateRoutes(): FakeRoute[] {
  const ended = (): Row => {
    const next = storedDate(firstOfNextMonth());
    return templateRow({ status: "50", accountStartDate: next, accountNextInvoice: next });
  };
  return [
    {
      path: "/Invoice/2301",
      response: {
        get body(): unknown {
          return { objects: [ended()] };
        },
      },
    },
    ...templateChangeRoutes(),
  ];
}
