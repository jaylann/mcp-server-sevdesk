import { contactCreateTool } from "../../src/tools/contacts/create.js";
import { contactDeleteTool } from "../../src/tools/contacts/delete.js";
import { contactUpdateTool } from "../../src/tools/contacts/update.js";
import { creditNoteFromInvoiceTool } from "../../src/tools/credit-notes/from-invoice.js";
import { invoiceFromOrderTool } from "../../src/tools/invoices/from-order.js";
import { invoiceReminderTool } from "../../src/tools/invoices/reminder.js";
import { partCreateTool } from "../../src/tools/parts/create.js";
import { partUpdateTool } from "../../src/tools/parts/update.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import type { WriteToolCase } from "../helpers/write-cases.js";

const EMPTY: FakeRoute["response"] = { body: { objects: [] } };
/** sevDesk's answer to a DELETE (recorded 2026-11-16, D-084). */
const DELETED: FakeRoute["response"] = { body: { objects: [null] } };
const UNITS: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };

function contactRows(id: number, addresses: string, ways: string): FakeRoute[] {
  const filter = { "contact[id]": String(id), "contact[objectName]": "Contact" };
  return [
    { path: "/ContactAddress", query: filter, response: { fixture: addresses } },
    { path: "/CommunicationWay", query: filter, response: { fixture: ways } },
  ];
}

/** A contact's custom field values (D-086: read on their own, with the setting embedded). */
function customFieldRows(id: number, response: FakeRoute["response"]): FakeRoute {
  return {
    path: "/ContactCustomField",
    query: {
      "contact[id]": String(id),
      "contact[objectName]": "Contact",
      embed: "contactCustomFieldSetting",
    },
    response,
  };
}

const CUSTOM_FIELD_SETTINGS: FakeRoute = {
  path: "/ContactCustomFieldSetting",
  response: { fixture: "contacts/custom-field-settings.json" },
};

function invoiceRoutes(id: number, invoice: string, positions: string): FakeRoute[] {
  return [
    { path: `/Invoice/${id}`, query: { embed: "contact" }, response: { fixture: invoice } },
    {
      path: "/InvoicePos",
      query: { "invoice[id]": id, "invoice[objectName]": "Invoice" },
      response: { fixture: positions },
    },
  ];
}

/** Write-tool cases owned by the M3 masterdata work (see test/helpers/write-cases.ts). */
export const MASTERDATA_CASES: readonly WriteToolCase[] = [
  {
    label: "create an organisation contact with address and e-mail",
    tool: contactCreateTool,
    args: {
      organisationName: "Beispiel Handel GmbH",
      street: "Beispielweg 5",
      zip: "10115",
      city: "Berlin",
      email: "buchhaltung@example.com",
    },
    routes: [
      { path: "/Contact", query: { name: "Beispiel Handel GmbH" }, response: EMPTY },
      { path: "/CommunicationWay", query: { type: "EMAIL" }, response: EMPTY },
      {
        path: "/Contact/Factory/getNextCustomerNumber",
        response: { fixture: "contacts/next-customer-number.json" },
      },
      { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } },
      {
        method: "POST",
        path: "/Contact",
        response: { fixture: "masterdata/contact-create-1101.json" },
      },
      {
        method: "POST",
        path: "/ContactAddress",
        response: { fixture: "masterdata/contact-address-create-3101.json" },
      },
      {
        method: "POST",
        path: "/CommunicationWay",
        response: { fixture: "masterdata/communication-way-create-4101.json" },
      },
      { path: "/Contact/1101", response: { fixture: "masterdata/contact-1101.json" } },
      ...contactRows(
        1101,
        "masterdata/contact-addresses-1101.json",
        "masterdata/communication-ways-1101.json",
      ),
    ],
    writes: [
      { method: "POST", path: "/Contact" },
      { method: "POST", path: "/ContactAddress" },
      { method: "POST", path: "/CommunicationWay" },
    ],
  },
  {
    label: "update a contact's VAT ID and billing address",
    tool: contactUpdateTool,
    args: { id: 1001, vatNumber: "DE000000001", city: "Berlin" },
    routes: [
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      ...contactRows(
        1001,
        "contacts/contact-addresses-1001.json",
        "contacts/communication-ways-1001.json",
      ),
      { method: "PUT", path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      {
        method: "PUT",
        path: "/ContactAddress/3001",
        response: { fixture: "contacts/contact-addresses-1001.json" },
      },
    ],
    writes: [
      { method: "PUT", path: "/Contact/1001" },
      { method: "PUT", path: "/ContactAddress/3001" },
    ],
  },
  {
    label: "create a contact person of an organisation",
    tool: contactCreateTool,
    args: { firstName: "Erika", lastName: "Musterfrau", parentOrganisationId: 1001 },
    routes: [
      { path: "/Contact", query: { name: "Musterfrau" }, response: EMPTY },
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      {
        path: "/Contact/Factory/getNextCustomerNumber",
        response: { fixture: "contacts/next-customer-number.json" },
      },
      {
        method: "POST",
        path: "/Contact",
        response: { fixture: "masterdata/contact-create-1101.json" },
      },
      { path: "/Contact/1101", response: { fixture: "masterdata/contact-1101.json" } },
      ...contactRows(
        1101,
        "masterdata/contact-addresses-1101.json",
        "masterdata/communication-ways-1101.json",
      ),
    ],
    writes: [{ method: "POST", path: "/Contact" }],
  },
  {
    label: "remove a contact's delivery address",
    tool: contactUpdateTool,
    args: { id: 1001, remove: [{ kind: "address", id: 3002 }] },
    routes: [
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      ...contactRows(
        1001,
        "contacts/contact-addresses-1001.json",
        "contacts/communication-ways-1001.json",
      ),
      { method: "DELETE", path: "/ContactAddress/3002", response: DELETED },
    ],
    writes: [{ method: "DELETE", path: "/ContactAddress/3002" }],
  },
  {
    label: "set one custom field of a contact, change another and remove a third value",
    tool: contactUpdateTool,
    args: {
      id: 1001,
      customFields: [
        { name: "Kundennr extern", value: "EXT-4712" },
        { settingId: 19500, value: "Umbau Lager" },
      ],
      remove: [{ kind: "customField", id: 7002 }],
    },
    routes: [
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      ...contactRows(
        1001,
        "contacts/contact-addresses-1001.json",
        "contacts/communication-ways-1001.json",
      ),
      customFieldRows(1001, { fixture: "contacts/custom-fields-1001.json" }),
      CUSTOM_FIELD_SETTINGS,
      {
        method: "PUT",
        path: "/ContactCustomField/7001",
        response: { body: { objects: { id: "7001", objectName: "ContactCustomField" } } },
      },
      {
        method: "POST",
        path: "/ContactCustomField",
        response: { body: { objects: { id: "7003", objectName: "ContactCustomField" } } },
      },
      { method: "DELETE", path: "/ContactCustomField/7002", response: DELETED },
    ],
    writes: [
      { method: "PUT", path: "/ContactCustomField/7001" },
      { method: "POST", path: "/ContactCustomField" },
      { method: "DELETE", path: "/ContactCustomField/7002" },
    ],
  },
  {
    label: "delete an organisation with its addresses, communication ways and contact persons",
    tool: contactDeleteTool,
    args: { id: 1001 },
    routes: [
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      ...contactRows(
        1001,
        "contacts/contact-addresses-1001.json",
        "contacts/communication-ways-1001.json",
      ),
      customFieldRows(1001, { fixture: "contacts/custom-fields-1001.json" }),
      // Its contact persons (D-083: `GET /Contact` honours the parent filter): person 1002, which
      // sevDesk deletes with it (D-084) and which is read back afterwards.
      {
        path: "/Contact",
        query: { "parent[id]": 1001, "parent[objectName]": "Contact" },
        response: { fixture: "contacts/contact-1002.json" },
      },
      { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
      { method: "DELETE", path: "/Contact/1001", response: DELETED },
    ],
    writes: [{ method: "DELETE", path: "/Contact/1001" }],
  },
  {
    label: "create a part with a gross price",
    tool: partCreateTool,
    args: {
      name: "Beratungspaket",
      partNumber: "DL-020",
      price: "119",
      priceMode: "gross",
      unitId: 9,
    },
    routes: [
      { path: "/Part", query: { partNumber: "DL-020" }, response: EMPTY },
      UNITS,
      { method: "POST", path: "/Part", response: { fixture: "masterdata/part-create-6101.json" } },
      { path: "/Part/6101", response: { fixture: "masterdata/part-6101.json" } },
    ],
    writes: [{ method: "POST", path: "/Part" }],
  },
  {
    label: "change a part's net price",
    tool: partUpdateTool,
    args: { id: 6001, price: "50" },
    routes: [
      { path: "/Part/6001", response: { fixture: "parts/part-6001.json" } },
      { method: "PUT", path: "/Part/6001", response: { fixture: "parts/part-6001.json" } },
    ],
    writes: [{ method: "PUT", path: "/Part/6001" }],
  },
  {
    label: "invoice an accepted order confirmation in full",
    tool: invoiceFromOrderTool,
    args: { orderId: 3002 },
    routes: [
      {
        path: "/Order/3002",
        query: { embed: "contact" },
        response: { fixture: "orders/order-3002.json" },
      },
      {
        path: "/OrderPos",
        query: { "order[id]": 3002, "order[objectName]": "Order" },
        response: { fixture: "orders/order-positions-3002.json" },
      },
      UNITS,
      {
        path: "/Order/3002/getRelatedObjects",
        response: { fixture: "orders/order-related-3002.json" },
      },
      {
        method: "POST",
        path: "/Invoice/Factory/createInvoiceFromOrder",
        response: { fixture: "masterdata/invoice-from-order-1101.json" },
      },
      ...invoiceRoutes(
        1101,
        "masterdata/invoice-1101.json",
        "masterdata/invoice-positions-1101.json",
      ),
    ],
    writes: [{ method: "POST", path: "/Invoice/Factory/createInvoiceFromOrder" }],
  },
  {
    label: "create a credit note from a paid invoice",
    tool: creditNoteFromInvoiceTool,
    args: { invoiceId: 1004 },
    routes: [
      {
        path: "/Invoice/1004",
        query: { embed: "contact" },
        response: { fixture: "masterdata/invoice-1004.json" },
      },
      { path: "/InvoicePos", query: { "invoice[id]": 1004 }, response: EMPTY },
      UNITS,
      { path: "/Invoice", query: { "origin[id]": 1004, "contact[id]": 1001 }, response: EMPTY },
      { path: "/CreditNote", query: { "contact[id]": 1001 }, response: EMPTY },
      // All credit notes, without a filter: after the counter is moved on, the check whether an
      // older credit note carries the new draft's number already (a lagging counter).
      { path: "/CreditNote", response: EMPTY },
      {
        method: "POST",
        path: "/CreditNote/Factory/createFromInvoice",
        response: { fixture: "masterdata/credit-note-from-invoice-2101.json" },
      },
      {
        path: "/CreditNote/2101",
        query: { embed: "contact" },
        response: { fixture: "masterdata/credit-note-2101.json" },
      },
      {
        path: "/CreditNotePos",
        query: { "creditNote[id]": 2101 },
        response: { fixture: "masterdata/credit-note-positions-2101.json" },
      },
      // The counter still offers the new draft's number GU-1000, so it is moved on once.
      ...["false", "true"].map((useNextNumber) => ({
        path: "/CreditNote/Factory/getNextCreditNoteNumber",
        query: { useNextNumber },
        response: { body: { objects: "GU-1000" } },
      })),
    ],
    writes: [
      { method: "POST", path: "/CreditNote/Factory/createFromInvoice" },
      { method: "GET", path: "/CreditNote/Factory/getNextCreditNoteNumber" },
    ],
  },
  {
    label: "create a reminder for an overdue invoice",
    tool: invoiceReminderTool,
    args: { invoiceId: 1001 },
    routes: [
      ...invoiceRoutes(1001, "invoices/invoice-1001.json", "invoices/invoice-positions-1001.json"),
      UNITS,
      { path: "/Invoice", query: { "origin[id]": 1001, invoiceType: "MA" }, response: EMPTY },
      {
        method: "POST",
        path: "/Invoice/Factory/createInvoiceReminder",
        response: { fixture: "masterdata/invoice-reminder-1102.json" },
      },
      ...invoiceRoutes(
        1102,
        "masterdata/invoice-1102.json",
        "masterdata/invoice-positions-1102.json",
      ),
    ],
    writes: [{ method: "POST", path: "/Invoice/Factory/createInvoiceReminder" }],
  },
];
