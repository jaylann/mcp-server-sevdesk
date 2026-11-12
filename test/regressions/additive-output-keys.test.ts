import { describe, expect, it } from "vitest";

import { statusDto } from "../../src/domain/common.js";
import { withDocumentCountry } from "../../src/domain/country-codes.js";
import { mapCreditNoteDetail } from "../../src/domain/credit-notes.js";
import { creditNoteCreateInputShape } from "../../src/domain/drafts/credit-note.js";
import {
  addressInputShape,
  loadCountries,
  resolveAddress,
} from "../../src/domain/drafts/recipient.js";
import {
  BOOKING_CATEGORY_NAMES,
  INVOICE_TYPE_FILTERS,
  keyForCode,
  ORDER_TYPE_FILTERS,
  STATUS_FILTERS,
} from "../../src/domain/filter-keys.js";
import { mapInvoiceDetail } from "../../src/domain/invoices.js";
import { mapOrderDetail } from "../../src/domain/orders.js";
import { STATUS_OBJECT_TYPES } from "../../src/domain/reference-data.js";
import { transactionsListTool } from "../../src/tools/banking/transactions.js";
import { creditNotesListTool } from "../../src/tools/credit-notes/list.js";
import { invoicesListTool } from "../../src/tools/invoices/list.js";
import { ordersListTool } from "../../src/tools/orders/list.js";
import { vouchersListTool } from "../../src/tools/vouchers/list.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";

const TODAY = "2026-11-12";

describe("additive output keys use the input/filter vocabulary", () => {
  it("maps every accepted status back to its exact input key", () => {
    for (const kind of STATUS_OBJECT_TYPES) {
      for (const [key, code] of Object.entries(STATUS_FILTERS[kind])) {
        expect(statusDto(kind, code)).toMatchObject({ code, key });
      }
    }
    for (const [kind, tool] of [
      ["invoice", invoicesListTool],
      ["creditNote", creditNotesListTool],
      ["order", ordersListTool],
      ["voucher", vouchersListTool],
    ] as const) {
      for (const code of Object.values(STATUS_FILTERS[kind])) {
        expect(tool.input.safeParse({ status: statusDto(kind, code).key }).success).toBe(true);
      }
    }
    for (const code of Object.values(STATUS_FILTERS.transaction)) {
      expect(
        transactionsListTool.input.safeParse({ status: [statusDto("transaction", code).key] })
          .success,
      ).toBe(true);
    }
  });

  it("omits unfilterable keys and keeps unknown and zero status codes", () => {
    expect(statusDto("invoice", 0)).toEqual({ code: 0, label: "unknown" });
    expect(statusDto("invoice", 9999)).toEqual({ code: 9999, label: "unknown" });
    expect(statusDto("invoice", 50)).not.toHaveProperty("key");
    expect(statusDto("contact", 1000)).not.toHaveProperty("key");
    expect(keyForCode({ zero: 0 }, 0)).toBe("zero");
    expect(keyForCode({ zero: 0 }, "0")).toBeUndefined();
  });

  it("returns accepted invoice and order type keys, retaining codes and labels", () => {
    for (const [key, code] of Object.entries(INVOICE_TYPE_FILTERS)) {
      const type = mapInvoiceDetail({ id: 1, status: 100, invoiceType: code }, TODAY).type;
      expect(type).toMatchObject({ code, key });
      expect(typeof type.label).toBe("string");
      expect(typeof type.labelDe).toBe("string");
      expect(invoicesListTool.input.safeParse({ type: type.key }).success).toBe(true);
    }
    for (const [key, code] of Object.entries(ORDER_TYPE_FILTERS)) {
      const type = mapOrderDetail({ id: 1, status: 100, orderType: code }).type;
      expect(type).toMatchObject({ code, key });
      expect(typeof type.label).toBe("string");
      expect(typeof type.labelDe).toBe("string");
      expect(ordersListTool.input.safeParse({ type: type.key }).success).toBe(true);
    }
    expect(mapInvoiceDetail({ id: 1, status: 100, invoiceType: "NEW" }, TODAY).type).toEqual({
      code: "NEW",
      label: "unknown",
    });
    expect(mapOrderDetail({ id: 1, status: 100, orderType: "NEW" }).type).toEqual({
      code: "NEW",
      label: "unknown",
    });
  });

  it("adds only booking category keys accepted by the draft input", () => {
    for (const [key, code] of Object.entries(BOOKING_CATEGORY_NAMES)) {
      const category = mapCreditNoteDetail({
        id: 1,
        status: 100,
        bookingCategory: code,
      }).bookingCategory;
      expect(category).toMatchObject({ code, key });
      expect(creditNoteCreateInputShape.bookingCategory.parse(category?.key)).toBe(key);
    }
    expect(
      mapCreditNoteDetail({ id: 1, status: 100, bookingCategory: "ACCOUNTING_TYPE" })
        .bookingCategory,
    ).toEqual({ code: "ACCOUNTING_TYPE", label: "Booked on a special account (Update 1.0 only)" });
    expect(
      mapCreditNoteDetail({ id: 1, status: 100, bookingCategory: "NEW" }).bookingCategory,
    ).toEqual({ code: "NEW", label: "unknown" });
  });

  it.each([" at ", " AT ", "\tAt\n"])(
    "round-trips the output country through draft address resolution for %j",
    async (code) => {
      const client = new FakeSevdeskClient([
        {
          path: "/StaticCountry",
          response: { body: { objects: [{ id: 42, code, name: "Austria" }] } },
        },
      ]);
      const invoice = await withDocumentCountry(
        mapInvoiceDetail(
          { id: 1, status: 100, addressCountry: { id: 42, objectName: "StaticCountry" } },
          TODAY,
        ),
        client,
      );
      expect(invoice.address?.country).toBe("AT");
      const addressCountry = addressInputShape.addressCountry.parse(invoice.address?.country);
      const address = resolveAddress(
        {
          contact: { id: 1, kind: "organisation", displayName: "Example" },
          addresses: [{ id: 2, city: "Vienna", countryId: 42 }],
          addressesComplete: true,
          communicationWays: [],
          communicationWaysComplete: true,
        },
        { addressCountry },
        await loadCountries(client),
      );
      expect(address).toMatchObject({ countryId: 42, countryName: "Austria" });
      expect(client.writes()).toEqual([]);
    },
  );
});
