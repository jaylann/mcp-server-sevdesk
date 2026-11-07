import { describe, expect, it } from "vitest";

import type { LifecycleDocument } from "../../../../src/domain/lifecycle/documents.js";
import {
  assertBookable,
  assertCancellable,
  assertEmailable,
  assertEnshrinable,
  assertFinalizable,
  assertResettable,
  hasPayments,
} from "../../../../src/domain/lifecycle/transitions.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteDoc, invoiceDoc, orderDoc } from "./docs.js";

/** The validation message `check` throws, or `undefined` when it passes. */
function refusal(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    return (error as SevdeskError).message;
  }
}

const draft = { status: "100", invoiceNumber: null };
const paid = { status: "1000", paidAmount: 177.33 };
const partial = { status: "750", paidAmount: 50 };

describe("hasPayments", () => {
  it("is true only for a non-zero paid amount", () => {
    expect(hasPayments(invoiceDoc())).toBe(false);
    expect(hasPayments(invoiceDoc({ paidAmount: "10.00" }))).toBe(true);
    expect(hasPayments(creditNoteDoc())).toBe(false);
  });
});

describe("assertFinalizable", () => {
  it("accepts drafts of every kind", () => {
    expect(
      refusal(() => {
        assertFinalizable(invoiceDoc(draft));
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertFinalizable(creditNoteDoc({ status: "100" }));
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertFinalizable(orderDoc({ status: "100" }));
      }),
    ).toBeUndefined();
  });

  it("refuses documents that are no drafts, naming them by id and status", () => {
    expect(
      refusal(() => {
        assertFinalizable(invoiceDoc());
      }),
    ).toBe(
      "Invoice 1001 is not a draft (status 200, Open / due); only drafts can be finalized, and " +
        "this one already was.",
    );
    expect(
      refusal(() => {
        assertFinalizable(orderDoc());
      }),
    ).toContain("Order 3002 is not a draft");
  });

  it("refuses recurring invoice templates", () => {
    expect(
      refusal(() => {
        assertFinalizable(invoiceDoc({ ...draft, invoiceType: "WKR" }));
      }),
    ).toContain("recurring invoice template (WKR");
  });
});

describe("assertEmailable", () => {
  it("accepts drafts when finalizing is allowed, and finalized documents either way", () => {
    expect(
      refusal(() => {
        assertEmailable(invoiceDoc(draft), true);
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertEmailable(invoiceDoc(paid), false);
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertEmailable(orderDoc(), false);
      }),
    ).toBeUndefined();
  });

  it("refuses a draft when finalizing (the commit tier) is not allowed", () => {
    expect(
      refusal(() => {
        assertEmailable(invoiceDoc(draft), false);
      }),
    ).toBe(
      "Invoice 1001 is a draft: sending it by email would also finalize it (draft → open), " +
        "which needs the commit tier. Finalize it first with sevdesk_invoice_finalize (needs " +
        "the commit tier), or enable commit (SEVDESK_ALLOW).",
    );
    expect(
      refusal(() => {
        assertEmailable(orderDoc({ status: "100" }), false);
      }),
    ).toContain("(draft → sent)");
  });

  it("refuses recurring invoice templates", () => {
    expect(
      refusal(() => {
        assertEmailable(invoiceDoc({ invoiceType: "WKR" }), true);
      }),
    ).toContain("cannot be sent by email");
  });
});

describe("assertBookable", () => {
  it("accepts open and partially paid invoices and credit notes", () => {
    expect(
      refusal(() => {
        assertBookable(invoiceDoc());
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertBookable(invoiceDoc(partial));
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertBookable(creditNoteDoc());
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a draft", invoiceDoc(draft), "is a draft; sevDesk books payments only on finalized"],
    ["a paid invoice", invoiceDoc(paid), "is already paid (status 1000, Paid)"],
    ["a cancellation invoice", invoiceDoc({ ...paid, invoiceType: "SR" }), "(Stornorechnung, SR)"],
    ["a reminder", invoiceDoc({ invoiceType: "MA" }), "Book the payment on the invoice it"],
    ["a recurring template", invoiceDoc({ invoiceType: "WKR", status: "50" }), "(WKR"],
    ["an unknown status", invoiceDoc({ status: "300" }), "has status 300, unknown"],
  ] as [string, LifecycleDocument<"invoice">, string][])("refuses %s", (_label, doc, message) => {
    expect(
      refusal(() => {
        assertBookable(doc);
      }),
    ).toContain(message);
  });

  it("points paid credit notes to the credit note reset tool", () => {
    expect(
      refusal(() => {
        assertBookable(creditNoteDoc({ status: "1000" }));
      }),
    ).toContain("sevdesk_credit_note_reset");
    expect(
      refusal(() => {
        assertBookable(creditNoteDoc({ status: "100" }));
      }),
    ).toContain("sevdesk_credit_note_finalize");
  });
});

describe("assertCancellable", () => {
  it.each(["RE", "AR", "TR", "ER"])("accepts an open, unpaid invoice of type %s", (type) => {
    expect(
      refusal(() => {
        assertCancellable(invoiceDoc({ invoiceType: type }));
      }),
    ).toBeUndefined();
  });

  it("accepts an enshrined open invoice (cancelling is how it is corrected)", () => {
    expect(
      refusal(() => {
        assertCancellable(invoiceDoc({ enshrined: "2026-10-02T10:00:00+02:00" }));
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a draft", invoiceDoc(draft), "is a draft: a draft has no legal effect"],
    ["a partially paid invoice", invoiceDoc(partial), "sevdesk_credit_note_create_from_invoice"],
    [
      "an open invoice with payments (shown before release 4.181)",
      invoiceDoc({ paidAmount: "20" }),
      "is partially paid",
    ],
    ["a paid invoice", invoiceDoc(paid), "If it was cancelled before"],
    ["a cancellation invoice", invoiceDoc({ ...paid, invoiceType: "SR" }), "cannot be cancelled"],
    ["a reminder", invoiceDoc({ invoiceType: "MA" }), "reminders cannot be cancelled"],
    ["a recurring template", invoiceDoc({ invoiceType: "WKR" }), "(WKR"],
    ["an unknown type", invoiceDoc({ invoiceType: "XX" }), "does not handle"],
    ["a deactivated invoice", invoiceDoc({ status: "50" }), "only open, unpaid invoices"],
  ] as [string, LifecycleDocument<"invoice">, string][])("refuses %s", (_label, doc, message) => {
    expect(
      refusal(() => {
        assertCancellable(doc);
      }),
    ).toContain(message);
  });
});

describe("assertEnshrinable", () => {
  it("accepts open and paid documents that are not enshrined", () => {
    expect(
      refusal(() => {
        assertEnshrinable(invoiceDoc());
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertEnshrinable(invoiceDoc(paid));
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertEnshrinable(creditNoteDoc());
      }),
    ).toBeUndefined();
  });

  it("refuses enshrined documents, drafts, low statuses and templates", () => {
    expect(
      refusal(() => {
        assertEnshrinable(invoiceDoc({ enshrined: "2026-10-02T10:00:00+02:00" }));
      }),
    ).toBe("Invoice 1001 is already enshrined (festgeschrieben); there is nothing to do.");
    expect(
      refusal(() => {
        assertEnshrinable(creditNoteDoc({ status: "100" }));
      }),
    ).toContain("sevdesk_credit_note_finalize");
    expect(
      refusal(() => {
        assertEnshrinable(invoiceDoc({ status: "50" }));
      }),
    ).toContain("only open or later documents");
    expect(
      refusal(() => {
        assertEnshrinable(invoiceDoc({ invoiceType: "WKR" }));
      }),
    ).toContain("WKR");
  });
});

describe("assertResettable", () => {
  it("resets paid and partially paid documents to open, enshrined ones included", () => {
    expect(
      refusal(() => {
        assertResettable(invoiceDoc(paid), "open");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(invoiceDoc(partial), "open");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(invoiceDoc({ ...paid, enshrined: "2026-10-02T10:00:00+02:00" }), "open");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(creditNoteDoc({ status: "1000" }), "open");
      }),
    ).toBe(undefined);
  });

  it("resets an open invoice that still shows payments (pre-4.181 partial payment) to open", () => {
    expect(
      refusal(() => {
        assertResettable(invoiceDoc({ paidAmount: "20" }), "open");
      }),
    ).toBe(undefined);
  });

  it.each([
    ["a draft", invoiceDoc(draft), "a reset cannot raise the status"],
    ["an open invoice without payments", invoiceDoc(), "already open with no payments"],
    ["a cancelled original", invoiceDoc({ status: "1000", paidAmount: 0 }), "cancelled invoice"],
    ["a cancellation invoice", invoiceDoc({ ...paid, invoiceType: "SR" }), "cannot be reset"],
    ["a template", invoiceDoc({ invoiceType: "WKR", status: "50" }), "(WKR"],
    ["an unknown status", invoiceDoc({ status: "300" }), "only paid or partially paid"],
  ] as [string, LifecycleDocument<"invoice">, string][])(
    "refuses to reset %s to open",
    (_label, doc, message) => {
      expect(
        refusal(() => {
          assertResettable(doc, "open");
        }),
      ).toContain(message);
    },
  );

  it("resets an open document without payments to draft", () => {
    expect(
      refusal(() => {
        assertResettable(invoiceDoc(), "draft");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(creditNoteDoc(), "draft");
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a draft", invoiceDoc(draft), "already a draft"],
    [
      "an enshrined invoice",
      invoiceDoc({ enshrined: "2026-10-02T10:00:00+02:00" }),
      "sevdesk_invoice_cancel",
    ],
    ["a paid invoice", invoiceDoc(paid), "Reset it to open first (sevdesk_invoice_reset"],
    ["an open invoice with payments", invoiceDoc({ paidAmount: "20" }), "has payments booked"],
    ["an unknown status", invoiceDoc({ status: "300" }), "only open documents"],
  ] as [string, LifecycleDocument<"invoice">, string][])(
    "refuses to reset %s to draft",
    (_label, doc, message) => {
      expect(
        refusal(() => {
          assertResettable(doc, "draft");
        }),
      ).toContain(message);
    },
  );

  it("tells credit notes to use a new document instead of resetting an enshrined one", () => {
    expect(
      refusal(() => {
        assertResettable(creditNoteDoc({ enshrined: "2026-10-02T10:00:00+02:00" }), "draft");
      }),
    ).toContain("Correct it with a new document instead.");
  });
});
