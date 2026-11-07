/**
 * Contract tests over the responses recorded on a sevDesk trial account (2026-11-07, Update 2.0,
 * SKR04; `test/fixtures/recorded/2026-11-07/`, see `docs/recording-session.md`).
 *
 * Every recorded file goes through the domain code that reads that endpoint in production (the
 * list and detail mappers, positions, document files, banking, parts, reference data, users,
 * ReceiptGuidance) via {@link FakeSevdeskClient}, so the real envelope handling and the real
 * upstream schemas run. The DTOs that come out must satisfy the exported output schemas. A
 * recorded shape that a parser rejects is a contract break with the live API, not a fixture
 * problem: it is pinned with `it.fails` next to the deviation entry (`spec/deviations.md`) until
 * the parser is fixed. `RECORDED` lists every file with the reader it is checked against; a new
 * recording without a contract test fails the coverage test.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  bankAccountDtoSchema,
  listBankAccounts,
  listTransactions,
  transactionDtoSchema,
} from "../../src/domain/banking.js";
import {
  contactDtoSchema,
  getContactDetails,
  getNextCustomerNumber,
  searchContacts,
} from "../../src/domain/contacts.js";
import {
  creditNoteDetailSchema,
  creditNoteRowSchema,
  getCreditNote,
  listCreditNotes,
} from "../../src/domain/credit-notes.js";
import { type DocumentFileKind, fetchDocumentFile } from "../../src/domain/document-files.js";
import {
  listDocumentPositions,
  positionDtoSchema,
  toPositionDto,
} from "../../src/domain/document-positions.js";
import {
  getInvoice,
  invoiceDetailSchema,
  invoiceRowSchema,
  listInvoices,
} from "../../src/domain/invoices.js";
import {
  getOrder,
  listOrders,
  orderDetailSchema,
  orderRowSchema,
  relatedDocumentSchema,
} from "../../src/domain/orders.js";
import {
  getPartDetails,
  listParts,
  partDetailDtoSchema,
  partDtoSchema,
} from "../../src/domain/parts.js";
import { fetchReceiptGuidance } from "../../src/domain/receipt-guidance.js";
import {
  ADDRESS_CATEGORIES,
  COMMUNICATION_WAY_KEYS,
  CONTACT_CATEGORIES,
  listCountries,
  listPaymentMethods,
  listUnits,
  TAX_RULES,
} from "../../src/domain/reference-data.js";
import { listUsers, userDtoSchema } from "../../src/domain/users.js";
import { listVouchers } from "../../src/domain/vouchers.js";
import { parseUpstream, zNumberish } from "../../src/sevdesk/schema.js";
import { getBookkeepingSystemVersion } from "../../src/sevdesk/system-version.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";

const SESSION = "2026-11-07";
const DIR = `recorded/${SESSION}`;
const TODAY = SESSION;

/** Every recorded file (path below the session folder) and the production reader it is checked with. */
const RECORDED: Readonly<Record<string, string>> = {
  "banking/balance.json": "listBankAccounts (getBalanceAtDate)",
  "banking/check-accounts.json": "listBankAccounts",
  "banking/transactions-list.json": "listTransactions",
  "contacts/communication-ways.json": "getContactDetails",
  "contacts/contact-addresses-unfiltered.json": "getContactDetails",
  "contacts/contact-addresses.json": "getContactDetails",
  "contacts/contact-by-id.json": "getContactDetails",
  "contacts/contacts-list.json": "searchContacts",
  "contacts/next-customer-number.json": "getNextCustomerNumber",
  "credit-notes/credit-note-by-id.json": "getCreditNote",
  "credit-notes/credit-note-positions.json": "getCreditNote",
  "credit-notes/credit-notes-list.json": "listCreditNotes",
  "documents/credit-note-pdf.json": "fetchDocumentFile",
  "documents/invoice-pdf.json": "fetchDocumentFile",
  "documents/order-pdf.json": "fetchDocumentFile",
  "invoices/invoice-by-id.json": "getInvoice",
  "invoices/invoice-positions-unfiltered.json": "listDocumentPositions + toPositionDto",
  "invoices/invoice-positions.json": "getInvoice",
  "invoices/invoices-list.json": "listInvoices",
  "meta/account-datev.json": "none yet (voucher writes, M4)",
  "meta/bookkeeping-system-version.json": "getBookkeepingSystemVersion",
  "meta/categories.json": "CONTACT_CATEGORIES / ADDRESS_CATEGORIES (static)",
  "meta/communication-way-keys.json": "COMMUNICATION_WAY_KEYS (static)",
  "meta/payment-methods.json": "listPaymentMethods",
  "meta/receipt-guidance-all.json": "fetchReceiptGuidance",
  "meta/sev-users.json": "listUsers",
  "meta/static-countries.json": "listCountries",
  "meta/tax-rules.json": "TAX_RULES (static)",
  "meta/units.json": "listUnits",
  "orders/order-by-id.json": "getOrder",
  "orders/order-positions.json": "getOrder",
  "orders/order-related.json": "getOrder (getRelatedObjects)",
  "orders/orders-list.json": "listOrders",
  "parts/part-by-id.json": "getPartDetails",
  "parts/part-stock.json": "zNumberish (getPartDetails' stock read)",
  "parts/parts-list.json": "listParts",
  "vouchers/vouchers-list.json": "listVouchers",
};

// Ids of the recorded records (scrubbing keeps sevDesk's object ids).
const CONTACT_ID = 140758307;
const INVOICE_ID = 138793718;
const FINAL_INVOICE_ID = 138793711;
const CREDIT_NOTE_ID = 3084629;
const ORDER_ID = 31523703;
const PART_ID = 58929889;
const ACCOUNT_IDS = [6333721, 6333723] as const;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function fixture(file: string): string {
  return `${DIR}/${file}`;
}

function route(path: string, file: string): FakeRoute {
  return { path, response: { fixture: fixture(file) } };
}

/**
 * The recorded rows without `total`. A recorded page with `total` is answered unchanged for every
 * offset, which `listAll` would read forever; without `total` the fake client pages the rows
 * itself. Used only where production code falls back to `listAll`.
 */
function rowsOnly(path: string, file: string): FakeRoute {
  const body = loadFixture(fixture(file)).body as { objects: unknown };
  return { path, response: { body: { objects: body.objects } } };
}

/** The rows of a recorded list (its `objects`). */
function recordedRows(file: string): Record<string, unknown>[] {
  const body = loadFixture(fixture(file)).body as { objects: unknown };
  return body.objects as Record<string, unknown>[];
}

/** Fails with zod's issues (field paths), not just `false`. */
function expectValid(schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success ? [] : result.error.issues).toEqual([]);
}

const unitsRoute = route("/Unity", "meta/units.json");

const SESSION_DIR = fileURLToPath(new URL(`../fixtures/${DIR}/`, import.meta.url));

function filesBelow(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

const FILES_ON_DISK = filesBelow(SESSION_DIR)
  .map((path) => relative(SESSION_DIR, path).split("\\").join("/"))
  .sort();

// ---------------------------------------------------------------------------------------------
// Provenance and coverage
// ---------------------------------------------------------------------------------------------

describe(`recorded fixtures ${SESSION}: provenance and coverage`, () => {
  it("has a contract test for every recorded file, and a file for every contract", () => {
    expect(FILES_ON_DISK).toEqual(Object.keys(RECORDED).sort());
  });

  it.each(FILES_ON_DISK)("%s says it was recorded on the trial account", (file) => {
    const { _provenance: provenance, status } = loadFixture(fixture(file));
    expect(provenance.source).toBe("recorded");
    expect(provenance.date).toBe(SESSION);
    expect(provenance.systemVersion).toBe("2.0");
    expect(provenance.ref).toMatch(/^GET \//);
    expect(provenance.ref).toContain(`recording session ${SESSION}`);
    expect(status).toBe(200);
  });

  it("carries the countAll total of every recorded page as a JSON number (D-002)", () => {
    const pages = FILES_ON_DISK.filter((file) => {
      const body = loadFixture(fixture(file)).body;
      return typeof body === "object" && body !== null && "total" in body;
    });
    expect(pages.length).toBeGreaterThan(20);
    for (const file of pages) {
      const { total } = loadFixture(fixture(file)).body as { total: unknown };
      expect({ file, type: typeof total }).toEqual({ file, type: "number" });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Reference data and account
// ---------------------------------------------------------------------------------------------

describe("recorded reference data", () => {
  it("reads the bookkeeping system version", async () => {
    const client = new FakeSevdeskClient([
      route("/Tools/bookkeepingSystemVersion", "meta/bookkeeping-system-version.json"),
    ]);
    await expect(getBookkeepingSystemVersion(client)).resolves.toBe("2.0");
  });

  it("lists the users (SevUser) as valid DTOs", async () => {
    const client = new FakeSevdeskClient([route("/SevUser", "meta/sev-users.json")]);
    const users = await listUsers(client);
    expect(users.items).toHaveLength(recordedRows("meta/sev-users.json").length);
    expect(users.total).toBe(1);
    for (const user of users.items) expectValid(userDtoSchema, user);
  });

  it.each([
    ["countries", "/StaticCountry", "meta/static-countries.json", listCountries],
    ["units", "/Unity", "meta/units.json", listUnits],
    ["payment methods", "/PaymentMethod", "meta/payment-methods.json", listPaymentMethods],
  ] as const)("lists the %s with an id and a name per row", async (_what, path, file, list) => {
    const client = new FakeSevdeskClient([route(path, file)]);
    const result = await list(client);
    const rows = recordedRows(file);
    expect(result.items).toHaveLength(rows.length);
    expect(result.total).toBe(rows.length);
    for (const item of result.items) {
      expect(Number.isSafeInteger(item.id) && item.id > 0).toBe(true);
      expect(item.name.trim()).not.toBe("");
    }
  });

  it("knows exactly the tax rules of the recorded GET /TaxRule, with the same codes (D-006, D-028–D-030)", () => {
    const recorded = recordedRows("meta/tax-rules.json").map((row) => [
      Number(row["id"]),
      row["code"],
    ]);
    expect(TAX_RULES.map((rule) => [rule.id, rule.code])).toEqual(recorded);
  });

  it("names the contact and address categories as the recorded GET /Category does", () => {
    const rows = recordedRows("meta/categories.json");
    const byType = (type: string) =>
      new Map(
        rows
          .filter((row) => row["objectType"] === type)
          .map((row) => [Number(row["id"]), String(row["name"])]),
      );
    const contact = byType("Contact");
    for (const category of CONTACT_CATEGORIES) {
      expect(contact.get(category.id)).toBe(category.name);
    }
    const address = byType("ContactAddress");
    for (const category of ADDRESS_CATEGORIES) {
      expect(address.get(category.id)?.trim()).toBe(category.name.trim());
    }
  });

  it("names the communication way keys as the recorded GET /CommunicationWayKey does", () => {
    const recorded = new Map(
      recordedRows("meta/communication-way-keys.json").map((row) => [
        Number(row["id"]),
        String(row["name"]).trim(),
      ]),
    );
    expect([...recorded.keys()].sort((a, b) => a - b)).toEqual(
      COMMUNICATION_WAY_KEYS.map((key) => key.id),
    );
    for (const key of COMMUNICATION_WAY_KEYS) expect(recorded.get(key.id)).toBe(key.name);
  });

  it("parses every recorded ReceiptGuidance row without unknown tax rate words (D-065)", async () => {
    const client = new FakeSevdeskClient([
      route("/ReceiptGuidance/forAllAccounts", "meta/receipt-guidance-all.json"),
    ]);
    const list = await fetchReceiptGuidance(client, { kind: "all" });
    expect(list.guides).toHaveLength(recordedRows("meta/receipt-guidance-all.json").length);
    expect(list.truncated).toBe(false);
    for (const guide of list.guides) {
      expect(Number.isSafeInteger(guide.accountDatevId)).toBe(true);
      for (const type of guide.receiptTypes) expect(["expense", "revenue"]).toContain(type);
      for (const rule of guide.taxRules) expect(rule.unknownTaxRates).toEqual([]);
    }
  });

  it.todo(
    "parses the recorded GET /AccountDatev rows (no runtime reader before the voucher writes, M4)",
  );
});

// ---------------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------------

describe("recorded contacts", () => {
  it("searches contacts: one recorded page with its total", async () => {
    const client = new FakeSevdeskClient([route("/Contact", "contacts/contacts-list.json")]);
    const result = await searchContacts(client, { limit: 5, offset: 0 });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(8);
    expect(result.hasMore).toBe(true);
    for (const contact of result.items) expectValid(contactDtoSchema, contact);
  });

  it("reads one contact with its (empty) addresses and communication ways", async () => {
    const client = new FakeSevdeskClient([
      route(`/Contact/${CONTACT_ID}`, "contacts/contact-by-id.json"),
      route("/ContactAddress", "contacts/contact-addresses.json"),
      route("/CommunicationWay", "contacts/communication-ways.json"),
    ]);
    const details = await getContactDetails(client, CONTACT_ID);
    expectValid(contactDtoSchema, details.contact);
    expect(details.contact.id).toBe(CONTACT_ID);
    expect(details.addresses).toEqual([]);
    expect(details.addressesComplete).toBe(true);
    expect(details.communicationWays).toEqual([]);
    expect(details.communicationWaysComplete).toBe(true);
  });

  it("reads the unfiltered address list the same way (D-032)", async () => {
    const client = new FakeSevdeskClient([
      route(`/Contact/${CONTACT_ID}`, "contacts/contact-by-id.json"),
      route("/ContactAddress", "contacts/contact-addresses-unfiltered.json"),
      route("/CommunicationWay", "contacts/communication-ways.json"),
    ]);
    const details = await getContactDetails(client, CONTACT_ID);
    expect(details.addresses).toEqual([]);
  });

  it("reads the next customer number", async () => {
    const client = new FakeSevdeskClient([
      route("/Contact/Factory/getNextCustomerNumber", "contacts/next-customer-number.json"),
    ]);
    await expect(getNextCustomerNumber(client)).resolves.toBe("1008");
  });
});

// ---------------------------------------------------------------------------------------------
// Sales documents
// ---------------------------------------------------------------------------------------------

describe("recorded invoices", () => {
  it("lists invoices, including a paidAmount of 0 and of null (D-002)", async () => {
    const client = new FakeSevdeskClient([route("/Invoice", "invoices/invoices-list.json")]);
    const result = await listInvoices(client, { limit: 5, offset: 0, today: TODAY });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(39);
    for (const row of result.items) expectValid(invoiceRowSchema, row);
    const paid = recordedRows("invoices/invoices-list.json").map((row) => row["paidAmount"]);
    expect(paid).toContain(0);
    expect(paid).toContain(null);
  });

  it("reads one invoice with its positions", async () => {
    const client = new FakeSevdeskClient([
      route(`/Invoice/${INVOICE_ID}`, "invoices/invoice-by-id.json"),
      route("/InvoicePos", "invoices/invoice-positions.json"),
      unitsRoute,
    ]);
    const details = await getInvoice(client, INVOICE_ID, undefined, TODAY);
    expectValid(invoiceDetailSchema, details.invoice);
    expect(details.invoice.id).toBe(INVOICE_ID);
    expect(details.positions).toHaveLength(1);
    expect(details.positionsComplete).toBe(true);
    for (const position of details.positions) expectValid(positionDtoSchema, position);
  });

  it("parses every row of the unfiltered position list and keeps only the asked invoice's (D-035)", async () => {
    const rows = recordedRows("invoices/invoice-positions-unfiltered.json");
    const parent = Number((rows[0]?.["invoice"] as { id: string }).id);
    const client = new FakeSevdeskClient([
      rowsOnly("/InvoicePos", "invoices/invoice-positions-unfiltered.json"),
    ]);
    const positions = await listDocumentPositions(
      client,
      { path: "/InvoicePos", parentKey: "invoice", objectName: "Invoice", what: "positions" },
      parent,
    );
    expect(positions.complete).toBe(true);
    expect(positions.rows.length).toBeGreaterThan(0);
    for (const row of positions.rows) {
      expect(row.invoice?.id).toBe(parent);
      const dto = toPositionDto(row, { currency: "EUR", showNet: true, unitNames: new Map() });
      expectValid(positionDtoSchema, dto);
    }
  });
});

describe("recorded credit notes", () => {
  it("lists credit notes, including one without a number (D-027)", async () => {
    const client = new FakeSevdeskClient([
      route("/CreditNote", "credit-notes/credit-notes-list.json"),
    ]);
    const result = await listCreditNotes(client, { limit: 5, offset: 0 });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(10);
    for (const row of result.items) expectValid(creditNoteRowSchema, row);
  });

  it("reads one credit note with its positions", async () => {
    const client = new FakeSevdeskClient([
      route(`/CreditNote/${CREDIT_NOTE_ID}`, "credit-notes/credit-note-by-id.json"),
      route("/CreditNotePos", "credit-notes/credit-note-positions.json"),
      unitsRoute,
    ]);
    const details = await getCreditNote(client, CREDIT_NOTE_ID);
    expectValid(creditNoteDetailSchema, details.creditNote);
    expect(details.creditNote.id).toBe(CREDIT_NOTE_ID);
    expect(details.positions).toHaveLength(1);
    for (const position of details.positions) expectValid(positionDtoSchema, position);
  });
});

describe("recorded orders", () => {
  it("lists orders", async () => {
    const client = new FakeSevdeskClient([route("/Order", "orders/orders-list.json")]);
    const result = await listOrders(client, { limit: 5, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    for (const row of result.items) expectValid(orderRowSchema, row);
  });

  it("reads one order with its positions and the Update 2.0 related-documents list (D-036)", async () => {
    const client = new FakeSevdeskClient([
      route(`/Order/${ORDER_ID}`, "orders/order-by-id.json"),
      route("/OrderPos", "orders/order-positions.json"),
      route(`/Order/${ORDER_ID}/getRelatedObjects`, "orders/order-related.json"),
      unitsRoute,
    ]);
    const details = await getOrder(client, ORDER_ID);
    expectValid(orderDetailSchema, details.order);
    expect(details.order.id).toBe(ORDER_ID);
    expect(details.positions).toHaveLength(1);
    for (const position of details.positions) expectValid(positionDtoSchema, position);
    // `related` is undefined when the answer could not be read; the recorded one is a list.
    expect(details.related).toEqual([]);
    for (const item of details.related ?? []) expectValid(relatedDocumentSchema, item);
  });
});

// ---------------------------------------------------------------------------------------------
// Document files
// ---------------------------------------------------------------------------------------------

describe("recorded getPdf previews", () => {
  const cases: readonly (readonly [DocumentFileKind, string, number, string])[] = [
    ["invoice_pdf", "Invoice", FINAL_INVOICE_ID, "documents/invoice-pdf.json"],
    ["credit_note_pdf", "CreditNote", CREDIT_NOTE_ID, "documents/credit-note-pdf.json"],
    ["order_pdf", "Order", ORDER_ID, "documents/order-pdf.json"],
  ];

  it.each(cases)("fetches the %s from the recorded answer", async (kind, endpoint, id, file) => {
    const client = new FakeSevdeskClient([route(`/${endpoint}/${id}/getPdf`, file)]);
    const pdf = await fetchDocumentFile(client, kind, id);
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(client.calls[0]?.query).toEqual({ preventSendBy: true });
  });

  it.each(cases)(
    "%s: sevDesk sends mimetype and base64Encoded, not the spec's mimeType and base64encoded (D-072)",
    (_kind, _endpoint, _id, file) => {
      const { objects } = loadFixture(fixture(file)).body as { objects: Record<string, unknown> };
      expect(Object.keys(objects).sort()).toEqual(
        ["base64Encoded", "content", "filename", "mimetype"].sort(),
      );
    },
  );

  // D-072: the PDF record schema reads sevDesk's recorded key casing (and the spec's).
  it("refuses a non-PDF media type sent with sevDesk's recorded key casing", async () => {
    const { objects } = loadFixture(fixture("documents/invoice-pdf.json")).body as {
      objects: Record<string, unknown>;
    };
    const client = new FakeSevdeskClient([
      {
        path: `/Invoice/${FINAL_INVOICE_ID}/getPdf`,
        response: { body: { objects: { ...objects, mimetype: "text/html" } } },
      },
    ]);
    await expect(fetchDocumentFile(client, "invoice_pdf", FINAL_INVOICE_ID)).rejects.toThrow(
      /media type/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Banking, parts, vouchers
// ---------------------------------------------------------------------------------------------

describe("recorded banking", () => {
  it("lists the check accounts (offline and register) with their recorded balance", async () => {
    const client = new FakeSevdeskClient([
      route("/CheckAccount", "banking/check-accounts.json"),
      ...ACCOUNT_IDS.map((id) =>
        route(`/CheckAccount/${id}/getBalanceAtDate`, "banking/balance.json"),
      ),
    ]);
    const accounts = await listBankAccounts(client, {
      balanceDate: TODAY,
      includeArchived: true,
    });
    expect(accounts.items.map((account) => account.id)).toEqual([...ACCOUNT_IDS]);
    expect(accounts.complete).toBe(true);
    for (const account of accounts.items) {
      expectValid(bankAccountDtoSchema, account);
      expect(account.balanceMissing).toBeUndefined();
    }
  });

  it("lists transactions: one recorded page with its total", async () => {
    const client = new FakeSevdeskClient([
      route("/CheckAccountTransaction", "banking/transactions-list.json"),
      // The account names and currencies of the rows.
      route("/CheckAccount", "banking/check-accounts.json"),
    ]);
    const result = await listTransactions(client, { limit: 5, offset: 0 });
    expect(result.items).toHaveLength(5);
    expect(result.rowsTotal).toBe(8);
    for (const transaction of result.items) expectValid(transactionDtoSchema, transaction);
  });
});

describe("recorded parts", () => {
  it("lists parts", async () => {
    const client = new FakeSevdeskClient([route("/Part", "parts/parts-list.json")]);
    const result = await listParts(client, { limit: 5, offset: 0 });
    expect(result.items).toHaveLength(2);
    for (const part of result.items) expectValid(partDtoSchema, part);
  });

  it("reads one part without stock tracking (no getStock call)", async () => {
    const client = new FakeSevdeskClient([route(`/Part/${PART_ID}`, "parts/part-by-id.json")]);
    const part = await getPartDetails(client, PART_ID);
    expectValid(partDetailDtoSchema, part);
    expect(part.id).toBe(PART_ID);
    expect(client.calls).toHaveLength(1);
  });

  it("parses the recorded getStock answer with the schema getPartDetails uses", async () => {
    const path = `/Part/${PART_ID}/getStock`;
    const client = new FakeSevdeskClient([route(path, "parts/part-stock.json")]);
    const stock = await client.request({ method: "GET", path });
    expect(parseUpstream(zNumberish, stock, "the stock of a part")).toBe(0);
  });
});

describe("recorded vouchers", () => {
  it("lists vouchers (the trial account had none)", async () => {
    const client = new FakeSevdeskClient([route("/Voucher", "vouchers/vouchers-list.json")]);
    const result = await listVouchers(client, { limit: 50, offset: 0 });
    expect(result.items).toEqual([]);
    expect(result.window.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Recorded facts that spec/deviations.md cites
// ---------------------------------------------------------------------------------------------

describe("recorded facts cited by the deviation register", () => {
  const invoices = recordedRows("invoices/invoices-list.json");
  const creditNotes = recordedRows("credit-notes/credit-notes-list.json");
  const byId = (rows: Record<string, unknown>[], id: number) =>
    rows.find((row) => row["id"] === String(id));

  it("D-068: the credit note whose sendBy failed with HTTP 500 is open (200), sent and has no number", () => {
    expect(byId(creditNotes, 3084625)).toMatchObject({
      status: "200",
      creditNoteNumber: null,
      sendType: "VPR",
      enshrined: null,
    });
  });

  it("D-068: a draft from createFromInvoice and a later credit note finalized without a number share one number", () => {
    const fromInvoice = byId(creditNotes, 3084626);
    const finalized = byId(creditNotes, 3084627);
    expect(fromInvoice?.["status"]).toBe("100");
    expect(finalized?.["status"]).toBe("1000");
    // Scrubbing maps equal numbers to equal fakes, so equal fakes mean equal real numbers.
    expect(fromInvoice?.["creditNoteNumber"]).toBe(finalized?.["creditNoteNumber"]);
  });

  it("D-023, D-059: finalizing enshrined invoices and credit notes on the trial account, and payments were still booked", () => {
    const finalized = [...invoices, ...creditNotes].filter(
      (row) => row["status"] !== "100" && row["id"] !== "3084625",
    );
    expect(finalized.length).toBeGreaterThan(4);
    for (const row of finalized) expect(typeof row["enshrined"]).toBe("string");
    // Paid out after enshrining (D-041, D-059).
    expect(byId(creditNotes, 3084627)?.["status"]).toBe("1000");
  });

  it("D-060: an enshrined invoice reset to open reads back with paidAmount null and no payDate", () => {
    expect(byId(invoices, 138793708)).toMatchObject({
      status: "200",
      paidAmount: null,
      payDate: null,
    });
    expect(typeof byId(invoices, 138793708)?.["enshrined"]).toBe("string");
  });

  it("D-009: a finalized order keeps sendType '0' next to its sendDate; orders have no enshrined key", () => {
    const [order] = recordedRows("orders/order-by-id.json");
    expect(order?.["status"]).toBe("200");
    expect(order?.["sendType"]).toBe("0");
    expect(typeof order?.["sendDate"]).toBe("string");
    expect(order).not.toHaveProperty("enshrined");
  });

  it("D-042: a part written with priceNet and priceGross stores the net price in price", () => {
    for (const part of recordedRows("parts/parts-list.json")) {
      expect(part["price"]).toBe(part["priceNet"]);
      expect(part["price"]).not.toBe(part["priceGross"]);
    }
  });

  it("D-039: credit notes carry no paidAmount, also when partially paid (750)", () => {
    expect(byId(creditNotes, 3084628)?.["status"]).toBe("750");
    for (const row of creditNotes) expect(row).not.toHaveProperty("paidAmount");
  });
});
