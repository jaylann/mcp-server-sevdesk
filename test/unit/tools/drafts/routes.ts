/**
 * Fake-client routes for the draft tools (shared by their unit tests, the regression tests and
 * the write cases). Fixture provenance is in each file under `test/fixtures/`.
 */
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { type FakeRoute, loadFixture } from "../../../helpers/fake-client.js";

/** Berlin midnight of the dates the tests use, as sevDesk's Unix-second timestamps. */
export const TIMESTAMPS = {
  "2026-11-02": 1793574000,
  "2026-11-07": 1794006000,
  "2026-11-30": 1795993200,
} as const;

const allUsers = loadFixture("meta/sev-users.json").body as { objects: unknown[] };

/** `GET /SevUser` with only Erika Musterfrau (2001). */
const oneUserRoute: FakeRoute = {
  path: "/SevUser",
  response: { body: { objects: allUsers.objects.slice(0, 1) } },
};

/** `GET /SevUser` with two users (2001, 2002). */
export const twoUsersRoute: FakeRoute = {
  path: "/SevUser",
  response: { fixture: "meta/sev-users.json" },
};

const version2Route: FakeRoute = {
  path: "/Tools/bookkeepingSystemVersion",
  response: { fixture: "meta/bookkeeping-system-version.json" },
};

export const version1Route: FakeRoute = {
  path: "/Tools/bookkeepingSystemVersion",
  response: { fixture: "meta/bookkeeping-system-version-1.json" },
};

/** Contact 1001 (Musterfirma GmbH) with its invoice and delivery addresses. */
const contactRoutes: readonly FakeRoute[] = [
  { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
  {
    path: "/ContactAddress",
    query: { "contact[id]": 1001 },
    response: { fixture: "contacts/contact-addresses-1001.json" },
  },
  {
    path: "/CommunicationWay",
    query: { "contact[id]": 1001 },
    response: { fixture: "contacts/communication-ways-1001.json" },
  },
];

const countriesRoute: FakeRoute = {
  path: "/StaticCountry",
  response: { fixture: "meta/static-countries.json" },
};

const unitsRoute: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };

/** `GET /SevClient` of a regular VAT account (smallSettlement "0", SKR04). */
const regularAccountRoute: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client.json" },
};

/** `GET /SevClient` of a Kleinunternehmer account (smallSettlement "1"). */
export const smallBusinessAccountRoute: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client-small-business.json" },
};

/** `GET /SevClient` failing like an endpoint sevDesk does not offer. */
export const unknownRegimeRoute: FakeRoute = {
  path: "/SevClient",
  response: { error: new SevdeskError({ kind: "not_found", message: "sevDesk found nothing." }) },
};

/** Reads every create tool makes before its duplicate check (2.0 account, one user). */
const createReadRoutes: readonly FakeRoute[] = [
  regularAccountRoute,
  version2Route,
  ...contactRoutes,
  oneUserRoute,
  countriesRoute,
  unitsRoute,
];

const empty = { body: { objects: [] } };

/** Duplicate checks that find nothing. */
const noDuplicatesRoutes: readonly FakeRoute[] = [
  { path: "/Invoice", query: { "contact[id]": 1001 }, response: empty },
  { path: "/CreditNote", query: { "contact[id]": 1001 }, response: empty },
  { path: "/Order", query: { "contact[id]": 1001 }, response: empty },
];

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

export const saveInvoiceRoute: FakeRoute = {
  method: "POST",
  path: "/Invoice/Factory/saveInvoice",
  response: { fixture: "drafts/save-invoice-response.json" },
};

/** Read-back of the new draft invoice 2101. */
const invoice2101Routes: readonly FakeRoute[] = [
  {
    path: "/Invoice/2101",
    query: { embed: "contact" },
    response: { fixture: "drafts/invoice-2101.json" },
  },
  {
    path: "/InvoicePos",
    query: { "invoice[id]": 2101 },
    response: { fixture: "drafts/invoice-positions-2101.json" },
  },
];

/** The stored draft invoice 2102 (read before an update) and its read-back. */
const invoice2102Routes: readonly FakeRoute[] = [
  { path: "/Invoice/2102", response: { fixture: "drafts/invoice-2102-draft.json" } },
  {
    path: "/InvoicePos",
    query: { "invoice[id]": 2102 },
    response: { fixture: "drafts/invoice-positions-2102.json" },
  },
];

/** A `saveInvoice` that answers with invoice 2102 (an update). */
const saveInvoice2102Route: FakeRoute = {
  method: "POST",
  path: "/Invoice/Factory/saveInvoice",
  response: {
    body: { objects: { invoice: { id: "2102", objectName: "Invoice" }, invoicePos: [] } },
  },
};

/** Arguments that create the recorded draft invoice (3 × 10 + 1 × 25 net at 19 %). */
export const invoiceCreateArgs = {
  contactId: 1001,
  positions: [
    { name: "Beratung", quantity: 3, unitPrice: "10.00", taxRate: 19 },
    {
      name: "Paket",
      quantity: 1,
      unitPrice: 25,
      taxRate: "19",
      text: "Zweite Zeile\nund eine dritte",
    },
  ],
};

export const invoiceCreateRoutes: readonly FakeRoute[] = [
  ...createReadRoutes,
  ...noDuplicatesRoutes,
  saveInvoiceRoute,
  ...invoice2101Routes,
];

export const invoiceUpdateRoutes: readonly FakeRoute[] = [
  ...invoice2102Routes,
  regularAccountRoute,
  version2Route,
  ...contactRoutes,
  oneUserRoute,
  countriesRoute,
  unitsRoute,
  saveInvoice2102Route,
];

// ---------------------------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------------------------

/** Invoice 1001 (open, 19 %, contact 1001) that underachievement credit notes reduce. */
const sourceInvoiceRoutes: readonly FakeRoute[] = [
  {
    path: "/Invoice/1001",
    query: { embed: "contact" },
    response: { fixture: "invoices/invoice-1001.json" },
  },
  {
    path: "/InvoicePos",
    query: { "invoice[id]": 1001 },
    response: { fixture: "invoices/invoice-positions-1001.json" },
  },
];

const saveCreditNoteRoute: FakeRoute = {
  method: "POST",
  path: "/CreditNote/Factory/saveCreditNote",
  response: { fixture: "drafts/save-credit-note-response.json" },
};

const NEXT_CREDIT_NOTE_NUMBER = "/CreditNote/Factory/getNextCreditNoteNumber";

/** `getNextCreditNoteNumber`: the peek and the reservation both answer `number`. */
export function nextCreditNoteNumberRoutes(peek: string, reserve: string = peek): FakeRoute[] {
  return [
    {
      path: NEXT_CREDIT_NOTE_NUMBER,
      query: { useNextNumber: "false" },
      response: { body: { objects: peek } },
    },
    {
      path: NEXT_CREDIT_NOTE_NUMBER,
      query: { useNextNumber: "true" },
      response: { body: { objects: reserve } },
    },
  ];
}

/** `GET /CreditNote` without filters (the number scan) answering credit notes with `numbers`. */
export function creditNoteNumbersRoute(...numbers: (string | null)[]): FakeRoute {
  return {
    path: "/CreditNote",
    response: {
      body: {
        objects: numbers.map((number, index) => ({
          id: String(2100 + index),
          objectName: "CreditNote",
          creditNoteNumber: number,
        })),
      },
    },
  };
}

const creditNote2201Routes: readonly FakeRoute[] = [
  {
    path: "/CreditNote/2201",
    query: { embed: "contact" },
    response: { fixture: "drafts/credit-note-2201.json" },
  },
  {
    path: "/CreditNotePos",
    query: { "creditNote[id]": 2201 },
    response: { fixture: "drafts/credit-note-positions-2201.json" },
  },
];

/** An underachievement credit note of 1 × 10 net at 19 % on invoice 1001. */
export const creditNoteCreateArgs = {
  contactId: 1001,
  bookingCategory: "underachievement",
  sourceInvoiceId: 1001,
  positions: [{ name: "Teilgutschrift Versand", quantity: 1, unitPrice: 10 }],
};

/**
 * Reads and writes of a credit note create: the next number is GU-1002 (peeked and reserved), and
 * the number scan finds GU-1000 and GU-1001 in use. The scan route comes after the duplicate
 * checks (which filter by contact), so they keep matching their own routes.
 */
export const creditNoteCreateRoutes: readonly FakeRoute[] = [
  ...createReadRoutes,
  ...sourceInvoiceRoutes,
  ...noDuplicatesRoutes,
  ...nextCreditNoteNumberRoutes("GU-1002"),
  saveCreditNoteRoute,
  ...creditNote2201Routes,
  creditNoteNumbersRoute("GU-1000", "GU-1001", null),
];

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export const saveOrderRoute: FakeRoute = {
  method: "POST",
  path: "/Order/Factory/saveOrder",
  response: { fixture: "drafts/save-order-response.json" },
};

const NEXT_ORDER_NUMBER = "/Order/Factory/getNextOrderNumber";

/** `getNextOrderNumber` (any order type): the peek answers `peek`, the reservation `reserve`. */
export function nextOrderNumberRoutes(peek: string, reserve: string = peek): FakeRoute[] {
  return [
    {
      path: NEXT_ORDER_NUMBER,
      query: { useNextNumber: "false" },
      response: { body: { objects: peek } },
    },
    {
      path: NEXT_ORDER_NUMBER,
      query: { useNextNumber: "true" },
      response: { body: { objects: reserve } },
    },
  ];
}

const noRelated: FakeRoute["response"] = { body: { objects: [] } };

const order3101Routes: readonly FakeRoute[] = [
  {
    path: "/Order/3101",
    query: { embed: "contact" },
    response: { fixture: "drafts/order-3101.json" },
  },
  {
    path: "/OrderPos",
    query: { "order[id]": 3101 },
    response: { fixture: "drafts/order-positions-3101.json" },
  },
  { path: "/Order/3101/getRelatedObjects", response: noRelated },
];

const order3102Routes: readonly FakeRoute[] = [
  {
    path: "/Order/3102",
    query: { embed: "contact" },
    response: { fixture: "drafts/order-3102-draft.json" },
  },
  { path: "/Order/3102", response: { fixture: "drafts/order-3102-draft.json" } },
  {
    path: "/OrderPos",
    query: { "order[id]": 3102 },
    response: { fixture: "drafts/order-positions-3102.json" },
  },
  { path: "/Order/3102/getRelatedObjects", response: noRelated },
];

const saveOrder3102Route: FakeRoute = {
  method: "POST",
  path: "/Order/Factory/saveOrder",
  response: { body: { objects: { order: { id: "3102", objectName: "Order" } } } },
};

/** An offer with the recorded positions (3 × 10 + 1 × 25 net at 19 %). */
export const orderCreateArgs = {
  contactId: 1001,
  orderType: "offer",
  positions: invoiceCreateArgs.positions,
};

/** Reads and writes of an order create; the next offer number is AN-1000 (peeked and reserved). */
export const orderCreateRoutes: readonly FakeRoute[] = [
  ...createReadRoutes,
  ...noDuplicatesRoutes,
  ...nextOrderNumberRoutes("AN-1000"),
  saveOrderRoute,
  ...order3101Routes,
];

export const orderUpdateRoutes: readonly FakeRoute[] = [
  ...order3102Routes,
  regularAccountRoute,
  version2Route,
  ...contactRoutes,
  oneUserRoute,
  countriesRoute,
  unitsRoute,
  saveOrder3102Route,
];

/** A route that fails like sevDesk's GET-by-id for an unknown id. */
export function notFound(path: string): FakeRoute {
  return {
    path,
    response: { error: new SevdeskError({ kind: "not_found", message: "sevDesk found nothing." }) },
  };
}

/** Puts `override` routes before `routes`, so they win (the fake client takes the first match). */
export function withRoutes(routes: readonly FakeRoute[], ...override: FakeRoute[]): FakeRoute[] {
  return [...override, ...routes];
}
