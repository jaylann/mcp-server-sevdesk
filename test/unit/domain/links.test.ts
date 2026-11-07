import { describe, expect, it } from "vitest";

import {
  contactLink,
  creditNoteLink,
  invoiceLink,
  orderLink,
  voucherLink,
} from "../../../src/domain/links.js";

describe("deep links (evidence: sevDesk web app router and link builder)", () => {
  it("opens finalized invoices in the detail view and drafts in the editor", () => {
    expect(invoiceLink(117393735, "RE", 200)).toBe(
      "https://my.sevdesk.de/fi/detail/type/RE/id/117393735",
    );
    expect(invoiceLink(5, "AR", 1000)).toBe("https://my.sevdesk.de/fi/detail/type/AR/id/5");
    expect(invoiceLink(5, "MA", 100)).toBe("https://my.sevdesk.de/fi/edit/type/MA/id/5");
    expect(invoiceLink(5, "RE", 100)).toBe("https://my.sevdesk.de/fi/edit/type/RE/id/5");
  });

  it("gives no link for invoice types the web app has no route for", () => {
    for (const type of ["VOU", "re", "", "CN"]) {
      expect(invoiceLink(1, type, 200)).toBeUndefined();
    }
  });

  it("links credit notes, orders, contacts and vouchers", () => {
    expect(creditNoteLink(7, 1000)).toBe("https://my.sevdesk.de/cn/detail/type/CN/id/7");
    expect(creditNoteLink(7, 100)).toBe("https://my.sevdesk.de/cn/edit/type/CN/id/7");
    expect(orderLink(8, "AB", 500)).toBe("https://my.sevdesk.de/om/detail/type/AB/id/8");
    expect(orderLink(8, "LI", 100)).toBe("https://my.sevdesk.de/om/edit/type/LI/id/8");
    expect(orderLink(8, "XX", 500)).toBeUndefined();
    expect(contactLink(9)).toBe("https://my.sevdesk.de/crm/detail/id/9");
    expect(voucherLink(10)).toBe("https://my.sevdesk.de/ex/detail/id/10");
  });

  it("never builds a link from an invalid id", () => {
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(invoiceLink(id, "RE", 200)).toBeUndefined();
      expect(creditNoteLink(id, 200)).toBeUndefined();
      expect(orderLink(id, "AN", 200)).toBeUndefined();
      expect(contactLink(id)).toBeUndefined();
      expect(voucherLink(id)).toBeUndefined();
    }
  });
});
