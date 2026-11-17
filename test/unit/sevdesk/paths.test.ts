import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  assertSafePath,
  genericGetRefusal,
  isSevdeskId,
  minimumWriteTier,
  resolveGetSafety,
  sevdeskPath,
  toSevdeskId,
} from "../../../src/sevdesk/paths.js";

function rejects(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SevdeskError);
  expect((caught as SevdeskError).kind).toBe("validation");
}

describe("isSevdeskId / toSevdeskId", () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER])("accepts %d", (id) => {
    expect(isSevdeskId(id)).toBe(true);
    expect(toSevdeskId(id)).toBe(id);
  });

  it("accepts canonical digit strings", () => {
    expect(toSevdeskId("123")).toBe(123);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("rejects %d", (id) => {
    expect(isSevdeskId(id)).toBe(false);
    rejects(() => toSevdeskId(id));
  });

  it.each(["0", "-1", "1.5", "12abc", "007", "", " 1", "1e3", "9007199254740993"])(
    "rejects %j",
    (id) => {
      rejects(() => toSevdeskId(id));
    },
  );

  it.each(["1", null, undefined, {}])("isSevdeskId(%j) is false", (value) => {
    expect(isSevdeskId(value)).toBe(false);
  });
});

describe("sevdeskPath", () => {
  it("joins names and ids", () => {
    expect(sevdeskPath("Invoice", 123, "getPdf")).toBe("/Invoice/123/getPdf");
    expect(sevdeskPath("Invoice", "123", "getPdf")).toBe("/Invoice/123/getPdf");
    expect(sevdeskPath("Tools", "bookkeepingSystemVersion")).toBe(
      "/Tools/bookkeepingSystemVersion",
    );
    expect(sevdeskPath("Voucher", "Factory", "save_Voucher2")).toBe(
      "/Voucher/Factory/save_Voucher2",
    );
  });

  it.each<readonly (string | number)[]>([
    [],
    ["Invoice", -1],
    ["Invoice", 0],
    ["Invoice", 1.5],
    ["Invoice", Number.NaN],
    ["Invoice", 2 ** 60],
    ["Invoice", "12abc"],
    ["Invoice", "NaN"],
    ["Invoice", "undefined"],
    ["Invoice", ".."],
    ["Invoice", "a/b"],
    ["Invoice", ""],
    ["Invoice", "get Pdf"],
    ["Invoice", "getPdf?x=1"],
    ["Rechnung_ü"],
    ["_private"],
  ])("rejects %j", (...segments) => {
    rejects(() => sevdeskPath(...segments));
  });
});

describe("assertSafePath", () => {
  it.each([
    "/Contact",
    "/Invoice/123/getPdf",
    "/Tools/bookkeepingSystemVersion",
    "/Voucher/Factory/uploadTempFile",
    "/CheckAccountTransaction/9007199254740991/enshrine",
  ])("accepts %s", (path) => {
    expect(() => {
      assertSafePath(path);
    }).not.toThrow();
  });

  it.each([
    "",
    "Contact",
    "/",
    "/Contact/",
    "//Contact",
    "/Invoice//1",
    "/Invoice/../SevUser",
    "/Invoice/./1",
    "/Invoice?limit=1",
    "/Invoice#x",
    "/Invoice/ 1",
    "/Invoice/1\n",
    "/Inv%6Fice",
    "/Rechnung/ü",
    "/Invoice/-1",
    "/Invoice/1.5",
    "/Invoice/1e3",
    "/Invoice/0",
    "/Invoice/007",
    "/Invoice/12abc",
    "/Invoice/NaN",
    "/Invoice/undefined",
    "/Invoice/null",
    "/Invoice/9007199254740993",
    "https://evil.example/Contact",
  ])("rejects %j", (path) => {
    rejects(() => {
      assertSafePath(path);
    });
  });
});

describe("resolveGetSafety", () => {
  it.each(["/Export/createDatevCsvZipExportJob", "/Export/createdatevxmlzipexportjob"])(
    "treats the DATEV export job %s as a side effect",
    (path) => {
      expect(resolveGetSafety(path, { scope: "EXTCD" }, false)).toEqual({
        sideEffect: true,
        effect: "it starts an export job in sevDesk",
        query: { scope: "EXTCD" },
      });
    },
  );

  it.each(["/Export/invoiceZip", "/Export/voucherzip", "/Export/invoiceZip/1"])(
    "treats the document archive %s as a side effect (heavy, never retried; D-101)",
    (path) => {
      expect(resolveGetSafety(path, { download: "true" }, false)).toEqual({
        sideEffect: true,
        effect: "it renders an archive of every matching document in sevDesk",
        query: { download: "true" },
      });
      expect(minimumWriteTier(path, { download: "true" })).toBe("write");
      // An enshrine flag makes any of them commit, as for the DATEV export.
      expect(minimumWriteTier(path, { enshrine: true })).toBe("commit");
    },
  );

  it("keeps the job's progress and download info as reads", () => {
    for (const path of [
      "/Progress/getProgress",
      "/ExportJob/jobDownloadInfo",
      "/Export/invoiceCsv",
    ]) {
      expect(resolveGetSafety(path, undefined, false).sideEffect).toBe(false);
    }
  });

  it("adds the literal preventSendBy=true to an undeclared getPdf and keeps other parameters", () => {
    expect(resolveGetSafety("/Order/5/getPdf", { download: true }, false)).toEqual({
      sideEffect: false,
      query: { download: true, preventSendBy: "true" },
    });
    expect(resolveGetSafety("/Invoice/5/getPdf", undefined, false)).toEqual({
      sideEffect: false,
      query: { preventSendBy: "true" },
    });
  });

  it.each([true, 1, "1", "true"])(
    "sends a caller's preventSendBy %j as the verified literal 'true' (D-023)",
    (value) => {
      expect(resolveGetSafety("/Invoice/5/getPdf", { preventSendBy: value }, false)).toEqual({
        sideEffect: false,
        query: { preventSendBy: "true" },
      });
    },
  );

  it("leaves the query untouched when the side effect is declared", () => {
    const query = { download: true };
    const result = resolveGetSafety("/Invoice/5/getPdf", query, true);
    expect(result.sideEffect).toBe(true);
    expect(result.query).toBe(query);
  });

  it("treats a disabled preventSendBy as a side effect", () => {
    const result = resolveGetSafety("/CreditNote/5/getPdf", { preventSendBy: 0 }, false);
    expect(result).toMatchObject({ sideEffect: true, effect: "it marks the document as sent" });
  });

  it("always treats sendByWithRender as a side effect", () => {
    expect(resolveGetSafety("/CreditNote/5/sendByWithRender", undefined, false)).toMatchObject({
      sideEffect: true,
    });
  });

  it("treats an enshrine flag as a side effect on any endpoint", () => {
    expect(
      resolveGetSafety("/Export/createDatevCsvZipExportJob", { enshrineDocuments: "1" }, false),
    ).toMatchObject({ sideEffect: true, effect: expect.stringMatching(/enshrines/) as unknown });
    expect(resolveGetSafety("/Export/datevCSV", { enshrine: "false" }, false).sideEffect).toBe(
      false,
    );
  });

  it.each([
    ["/Order/Factory/getNextOrderNumber", { orderType: "AN", useNextNumber: "true" }],
    ["/Order/Factory/getNextOrderNumber", { orderType: "AN", useNextNumber: true }],
    ["/CreditNote/Factory/getNextCreditNoteNumber", { useNextNumber: 1 }],
    ["/CreditNote/Factory/getNextCreditNoteNumber", { useNextNumber: "1" }],
    ["/Invoice/Factory/getNextInvoiceNumber", { invoiceType: "RE", useNextNumber: "yes" }],
    ["/Invoice/Factory/GETNEXTINVOICENUMBER", { UseNextNumber: "TRUE" }],
    // Only true/false were recorded: without the flag sevDesk might reserve.
    ["/Order/Factory/getNextOrderNumber", { orderType: "AN" }],
    ["/Order/Factory/getNextOrderNumber", { useNextNumber: undefined }],
    ["/Invoice/Factory/getNextInvoiceNumber", {}],
  ] as const)("treats %s with %j as reserving the number", (path, query) => {
    expect(resolveGetSafety(path, query, false)).toEqual({
      sideEffect: true,
      effect: "it reserves the next document number",
      query,
    });
  });

  it.each([
    [{ orderType: "AN", useNextNumber: "false" }],
    [{ orderType: "AN", useNextNumber: false }],
    [{ orderType: "AN", useNextNumber: 0 }],
    [{ orderType: "AN", useNextNumber: "0" }],
    [{ orderType: "AN", useNextNumber: "false", UseNextNumber: undefined }],
  ])("treats getNextOrderNumber with %j as a peek (plain read)", (query) => {
    expect(resolveGetSafety("/Order/Factory/getNextOrderNumber", query, false)).toEqual({
      sideEffect: false,
      query,
    });
  });

  it("names the reservation when the side effect is declared", () => {
    const query = { useNextNumber: "true" };
    expect(
      resolveGetSafety("/CreditNote/Factory/getNextCreditNoteNumber", query, true),
    ).toMatchObject({ sideEffect: true, effect: "it reserves the next document number" });
  });

  it("ignores useNextNumber on endpoints that hand out no numbers", () => {
    expect(resolveGetSafety("/Invoice", { useNextNumber: "true" }, false).sideEffect).toBe(false);
  });

  it("treats a getNext…Number GET without the flag as reserving, except customer numbers", () => {
    expect(
      resolveGetSafety("/CreditNote/Factory/getNextCreditNoteNumber", undefined, false),
    ).toMatchObject({
      sideEffect: true,
      effect: "it reserves the next document number",
    });
    expect(resolveGetSafety("/Contact/Factory/getNextCustomerNumber", undefined, false)).toEqual({
      sideEffect: false,
      query: undefined,
    });
  });

  it("passes ordinary reads through and honors the declared flag", () => {
    const query = { status: 100 };
    expect(resolveGetSafety("/Invoice", query, false)).toEqual({ sideEffect: false, query });
    expect(resolveGetSafety("/Invoice/1/getXml", undefined, true)).toMatchObject({
      sideEffect: true,
    });
  });
});

describe("minimumWriteTier", () => {
  it.each([
    ["/Invoice/1/sendBy", "commit"],
    ["/Order/1/sendBy", "commit"],
    ["/Invoice/1/bookAmount", "commit"],
    ["/CreditNote/1/bookAmount", "commit"],
    ["/Invoice/1/enshrine", "commit"],
    ["/CreditNote/1/enshrine", "commit"],
    ["/Invoice/1/cancelInvoice", "commit"],
    ["/Invoice/1/resetToDraft", "commit"],
    ["/Invoice/1/resetToOpen", "commit"],
    ["/Invoice/1/changeParameter", "commit"],
    ["/Invoice/1/SENDBY", "commit"],
    ["/Invoice/1/getPdf", "commit"],
    ["/Invoice/1/sendViaEmail", "external"],
    ["/Order/1/sendViaEmail", "external"],
    ["/CreditNote/1/sendByWithRender", "external"],
    ["/Invoice/Factory/createInvoiceFromOrder", "write"],
    ["/Invoice/Factory/createInvoiceReminder", "write"],
    ["/CreditNote/Factory/createFromInvoice", "write"],
    ["/Order/Factory/createContractNoteFromOrder", "commit"],
    ["/Order/Factory/createPackingListFromOrder", "write"],
    ["/Contact", "write"],
    ["/Contact/7", "write"],
    ["/ContactAddress", "write"],
    ["/Part/3", "write"],
    ["/Order/12", "write"],
    ["/CheckAccountTransaction/9", "commit"],
    ["/checkaccounttransaction/9", "commit"],
    ["/CheckAccountTransaction/9/enshrine", "commit"],
    ["/CheckAccountTransaction", "commit"],
    ["/Voucher/4", "write"],
    ["/Voucher/Factory/uploadTempFile", "write"],
    ["/Voucher/4/bookAmount", "commit"],
    ["/Voucher/4/resetToDraft", "commit"],
    ["/Export/createDatevCsvZipExportJob", "write"],
  ] as const)("%s needs %s", (path, tier) => {
    expect(minimumWriteTier(path, undefined)).toBe(tier);
  });

  it("needs commit for a saveVoucher that is not a draft (the voucher's finalize)", () => {
    const save = "/Voucher/Factory/saveVoucher";
    expect(minimumWriteTier(save, undefined, { voucher: { status: 50 } })).toBe("write");
    expect(minimumWriteTier(save, undefined, { voucher: { status: "50" } })).toBe("write");
    expect(minimumWriteTier(save, undefined, { voucher: { status: 100 } })).toBe("commit");
    expect(minimumWriteTier(save, undefined, { voucher: { status: "1000" } })).toBe("commit");
    expect(minimumWriteTier(save, undefined, { voucher: {} })).toBe("commit");
    expect(minimumWriteTier(save, undefined, undefined)).toBe("commit");
    expect(minimumWriteTier("/Voucher/Factory/uploadTempFile", undefined, undefined)).toBe("write");
  });

  it("reads every spelling of a saveVoucher's voucher and status keys", () => {
    const save = "/Voucher/Factory/saveVoucher";
    const both = { voucher: { status: 50 }, Voucher: { status: 100 } };
    expect(minimumWriteTier(save, undefined, both)).toBe("commit");
    expect(minimumWriteTier(save, undefined, { Voucher: { Status: 100 } })).toBe("commit");
    expect(minimumWriteTier(save, undefined, { voucher: { status: 50, STATUS: "100" } })).toBe(
      "commit",
    );
    expect(minimumWriteTier(save, undefined, { voucher: { status: 50 }, VOUCHER: null })).toBe(
      "commit",
    );
    expect(minimumWriteTier(save, undefined, { Voucher: { Status: "50" } })).toBe("write");
    expect(minimumWriteTier(save, undefined, { voucher: { status: 50, Status: 50 } })).toBe(
      "write",
    );
  });

  it("lets write tools reserve document numbers", () => {
    expect(minimumWriteTier("/Order/Factory/getNextOrderNumber", { useNextNumber: "true" })).toBe(
      "write",
    );
    expect(
      minimumWriteTier("/CreditNote/Factory/getNextCreditNoteNumber", { useNextNumber: "true" }),
    ).toBe("write");
  });

  it("treats DATEV exports with an enshrine flag as commit", () => {
    expect(minimumWriteTier("/Export/datevCSV", { enshrine: true })).toBe("commit");
    expect(minimumWriteTier("/Export/datevCSV", { enshrineDocuments: "1" })).toBe("commit");
    expect(minimumWriteTier("/Export/datevCSV", { enshrine: false })).toBe("write");
  });
});

describe("minimumWriteTier for creating a bank transaction (#88, D-096, D-098)", () => {
  const transaction = {
    objectName: "CheckAccountTransaction",
    mapAll: true,
    amount: -20,
    checkAccount: { id: 5, objectName: "CheckAccount" },
    status: 100,
  };

  it.each(["/CheckAccountTransaction", "/checkaccounttransaction", "/CHECKACCOUNTTRANSACTION"])(
    "needs commit for %s, whatever the body",
    (path) => {
      expect(minimumWriteTier(path, undefined, transaction)).toBe("commit");
      expect(minimumWriteTier(path, undefined, {})).toBe("commit");
      expect(minimumWriteTier(path, undefined, undefined)).toBe("commit");
    },
  );

  it.each([
    ["/CheckAccountTransaction/9/notes", "write"],
    ["/CheckAccountTransaction/9/enshrine", "commit"],
    ["/CheckAccountTransactionLog", "write"],
    ["/CheckAccount/Factory/fileImportAccount", "write"],
    ["/CheckAccount/5", "write"],
  ] as const)("leaves %s at %s", (path, tier) => {
    expect(minimumWriteTier(path, undefined, transaction)).toBe(tier);
  });
});

describe("minimumWriteTier for accepting an offer (#89, D-107, D-108)", () => {
  it("needs commit for a contract note, which sets the source offer to accepted", () => {
    const query = { "order[id]": 7, "order[objectName]": "Order" };
    const body = { id: 7, objectName: "Order" };
    expect(minimumWriteTier("/Order/Factory/createContractNoteFromOrder", query, body)).toBe(
      "commit",
    );
    expect(minimumWriteTier("/order/factory/CREATECONTRACTNOTEFROMORDER", query, body)).toBe(
      "commit",
    );
    expect(minimumWriteTier("/Order/Factory/createContractNoteFromOrder/7", query, body)).toBe(
      "commit",
    );
    expect(minimumWriteTier("/Order/Factory/createPackingListFromOrder", query, body)).toBe(
      "write",
    );
  });

  it("refuses the contract note factory as a generic read", () => {
    expect(genericGetRefusal("/Order/Factory/createContractNoteFromOrder", undefined)).toMatch(
      /accepting an offer/,
    );
  });

  it.each(["/Order/5", "/order/5", "/Invoice/5", "/CreditNote/5", "/creditnote/5", "/Voucher/5"])(
    "needs commit when a request to %s sets the status",
    (path) => {
      for (const body of [
        { status: 500 },
        { status: "300" },
        { status: 0 },
        { status: null },
        { Status: 200 },
        { STATUS: 100, header: "x" },
      ]) {
        expect(minimumWriteTier(path, undefined, body), JSON.stringify(body)).toBe("commit");
      }
    },
  );

  it.each([[[]], ["status"], [42], [null], [true]])(
    "needs commit when a document record's body cannot be read (%j)",
    (body) => {
      expect(minimumWriteTier("/Order/5", undefined, body)).toBe("commit");
    },
  );

  it("leaves other changes of a document record, and other records, at write", () => {
    expect(minimumWriteTier("/Order/5", undefined, { header: "Angebot" })).toBe("write");
    expect(minimumWriteTier("/Order/5", undefined, {})).toBe("write");
    expect(minimumWriteTier("/Order/5", undefined, { status: undefined })).toBe("write");
    // No body at all: a DELETE keeps the tier of its path.
    expect(minimumWriteTier("/Order/5", undefined, undefined)).toBe("write");
    expect(minimumWriteTier("/Voucher/5", undefined, undefined)).toBe("write");
    // Only keys that are sent count: JSON leaves inherited ones out.
    const inherited: unknown = Object.create({ status: 500 });
    expect(minimumWriteTier("/Order/5", undefined, inherited)).toBe("write");
    // Not a document record: contacts, positions, sub-resources, and a factory save of a draft
    // (status 100; another status needs commit, see the factory save tests below).
    expect(minimumWriteTier("/Contact/5", undefined, { status: 1000 })).toBe("write");
    expect(minimumWriteTier("/OrderPos/5", undefined, { status: 100 })).toBe("write");
    expect(minimumWriteTier("/Order/5/notes", undefined, { status: 100 })).toBe("write");
    expect(
      minimumWriteTier("/Order/Factory/saveOrder", undefined, { order: { status: 100 } }),
    ).toBe("write");
  });

  it("needs commit when a request to an invoice record sets its type or schedule (D-111)", () => {
    for (const body of [
      { invoiceType: "WKR" },
      { invoiceType: "RE" },
      { accountIntervall: "P0Y1M0W" },
      { accountStartDate: 1_763_247_600 },
      { AccountEndDate: "15.11.2027" },
      { accountNextInvoice: null },
    ]) {
      expect(minimumWriteTier("/Invoice/5", undefined, body), JSON.stringify(body)).toBe("commit");
    }
    expect(minimumWriteTier("/Invoice/5", undefined, { header: "Abo" })).toBe("write");
    expect(minimumWriteTier("/Order/5", undefined, { accountIntervall: "P1M" })).toBe("write");
    expect(minimumWriteTier("/Order/5", undefined, { invoiceType: "WKR" })).toBe("write");
  });
});

describe("minimumWriteTier for saving a recurring invoice template (#91, D-111, D-112)", () => {
  const save = "/Invoice/Factory/saveInvoice";
  /** The shape the invoice draft tools send (`drafts/payloads.ts` pins `RE` and status 100). */
  const draft = (invoice: Record<string, unknown>) => ({
    invoice: { objectName: "Invoice", mapAll: true, status: 100, ...invoice },
    invoicePosSave: null,
    invoicePosDelete: null,
  });

  it("leaves a save that names a type other than WKR at write", () => {
    for (const type of ["RE", "re", " RE ", "SR", "AR"]) {
      expect(minimumWriteTier(save, undefined, draft({ invoiceType: type })), type).toBe("write");
    }
    expect(minimumWriteTier(save, undefined, draft({ id: 9, invoiceType: "RE" }))).toBe("write");
  });

  it.each(["WKR", "wkr", " Wkr "])("needs commit for invoiceType %j", (type) => {
    expect(minimumWriteTier(save, undefined, draft({ invoiceType: type }))).toBe("commit");
    expect(
      minimumWriteTier("/invoice/factory/SAVEINVOICE", undefined, draft({ invoiceType: type })),
    ).toBe("commit");
  });

  it("needs commit when the type is missing: the stored one may be WKR", () => {
    // Ending a template is saveInvoice with its id and status 50 (D-112).
    expect(minimumWriteTier(save, undefined, draft({ id: 9, status: "50" }))).toBe("commit");
    expect(minimumWriteTier(save, undefined, draft({ invoiceType: undefined }))).toBe("commit");
    const inherited: unknown = Object.create({ invoiceType: "RE" });
    expect(minimumWriteTier(save, undefined, { invoice: inherited })).toBe("commit");
  });

  it.each([[null], [5], [["WKR"]], [{ code: "RE" }]])(
    "needs commit for an invoiceType that is not text (%j)",
    (type) => {
      expect(minimumWriteTier(save, undefined, draft({ invoiceType: type }))).toBe("commit");
    },
  );

  it.each([[undefined], [null], [[]], ["invoice"], [{}], [{ invoice: null }], [{ invoice: [] }]])(
    "needs commit for an unreadable body (%j)",
    (body) => {
      expect(minimumWriteTier(save, undefined, body)).toBe("commit");
    },
  );

  it("needs commit when any spelling of a key may name a template", () => {
    expect(
      minimumWriteTier(save, undefined, {
        invoice: { invoiceType: "RE" },
        Invoice: { invoiceType: "WKR" },
      }),
    ).toBe("commit");
    expect(
      minimumWriteTier(save, undefined, { invoice: { invoiceType: "RE", InvoiceType: "WKR" } }),
    ).toBe("commit");
    expect(minimumWriteTier(save, undefined, { Invoice: { InvoiceType: "RE" } })).toBe("write");
  });

  it("leaves the other invoice factories and other saves alone", () => {
    expect(minimumWriteTier("/Invoice/Factory/createInvoiceFromOrder", undefined, {})).toBe(
      "write",
    );
    expect(
      minimumWriteTier("/Order/Factory/saveOrder", undefined, { order: { orderType: "AN" } }),
    ).toBe("write");
    expect(
      minimumWriteTier("/CreditNote/Factory/saveCreditNote", undefined, {
        creditNote: { creditNoteType: "CN" },
      }),
    ).toBe("write");
  });
});

describe("minimumWriteTier for a status written through a factory save", () => {
  /** Each save with a regular draft of its document, the way the draft tools send it. */
  const SAVES = [
    ["/Invoice/Factory/saveInvoice", "invoice", { invoiceType: "RE" }],
    ["/Order/Factory/saveOrder", "order", { orderType: "AN" }],
    ["/CreditNote/Factory/saveCreditNote", "creditNote", { creditNoteType: "CN" }],
  ] as const;
  const save = (key: string, document: Record<string, unknown>) => ({
    [key]: { objectName: "x", mapAll: true, ...document },
    [`${key}PosSave`]: null,
    [`${key}PosDelete`]: null,
  });

  it.each(SAVES)("leaves %s of a draft (status 100, or none) at write", (path, key, kind) => {
    expect(minimumWriteTier(path, undefined, save(key, { ...kind, status: 100 }))).toBe("write");
    expect(minimumWriteTier(path, undefined, save(key, { ...kind, status: "100" }))).toBe("write");
    // An update without a status keeps the stored one.
    expect(minimumWriteTier(path, undefined, save(key, { ...kind, id: 7 }))).toBe("write");
    expect(minimumWriteTier(path, undefined, save(key, { ...kind, status: undefined }))).toBe(
      "write",
    );
  });

  it.each(SAVES)("needs commit when %s writes another status", (path, key, kind) => {
    for (const status of [
      500,
      "500",
      1000,
      "200",
      300,
      50,
      "50",
      0,
      null,
      " 100",
      "100.0",
      [100],
    ]) {
      const body = save(key, { ...kind, id: 7, status });
      expect(minimumWriteTier(path, undefined, body), JSON.stringify(status)).toBe("commit");
    }
  });

  it.each(SAVES)("reads every spelling of the keys of %s", (path, key, kind) => {
    const upper = key.charAt(0).toUpperCase() + key.slice(1);
    expect(minimumWriteTier(path, undefined, save(upper, { ...kind, Status: 500 }))).toBe("commit");
    expect(
      minimumWriteTier(path, undefined, {
        ...save(key, { ...kind, status: 100 }),
        [upper]: { ...kind, STATUS: "1000" },
      }),
    ).toBe("commit");
    expect(
      minimumWriteTier(path, undefined, save(key, { ...kind, status: 100, Status: 200 })),
    ).toBe("commit");
  });

  it.each(SAVES)("needs commit when %s cannot be read", (path, key) => {
    for (const body of [[], "body", 7, null, { [key]: null }, { [key]: [] }, { [key]: "x" }]) {
      expect(minimumWriteTier(path, undefined, body), JSON.stringify(body)).toBe("commit");
    }
  });

  it("leaves a save without a body, and statuses outside the document, alone", () => {
    expect(minimumWriteTier("/Order/Factory/saveOrder", undefined, undefined)).toBe("write");
    expect(
      minimumWriteTier("/Order/Factory/saveOrder", undefined, {
        ...save("order", { orderType: "AN", status: 100 }),
        status: 500,
        orderPosSave: [{ objectName: "OrderPos", status: 500 }],
      }),
    ).toBe("write");
  });
});

describe("minimumWriteTier reads the query and the form", () => {
  const draftInvoice = {
    invoice: { objectName: "Invoice", mapAll: true, invoiceType: "RE", status: 100 },
  };
  const form = () => {
    const data = new FormData();
    data.append("status", "500");
    return data;
  };

  it.each([
    ["/Order/7", { status: 500 }],
    ["/Order/7", { Status: "300" }],
    ["/Order/7", { "status[0]": 500 }],
    ["/order/7", { STATUS: 1 }],
    ["/Voucher/7", { status: 100 }],
    ["/Invoice/7", { invoiceType: "WKR" }],
    ["/Invoice/7", { accountIntervall: "P0Y1M0W" }],
  ] as const)("needs commit for %s with the query %j", (path, query) => {
    expect(minimumWriteTier(path, query, undefined)).toBe("commit");
    expect(minimumWriteTier(path, query, { header: "x" })).toBe("commit");
  });

  it("leaves other query keys of a document record at write", () => {
    expect(minimumWriteTier("/Order/7", { header: "x", status: undefined }, undefined)).toBe(
      "write",
    );
    expect(minimumWriteTier("/Order/7", { invoiceType: "WKR" }, undefined)).toBe("write");
    expect(minimumWriteTier("/Contact/7", { status: 1000 }, undefined)).toBe("write");
  });

  it.each([
    ["/Invoice/Factory/saveInvoice", { "invoice[status]": 1000 }, draftInvoice],
    ["/Invoice/Factory/saveInvoice", { "Invoice[invoiceType]": "WKR" }, draftInvoice],
    ["/Order/Factory/saveOrder", { "order[status]": 500 }, { order: { status: 100 } }],
    ["/Order/Factory/saveOrder", { order: "x" }, { order: { status: 100 } }],
    ["/CreditNote/Factory/saveCreditNote", { "creditNote[status]": 200 }, {}],
    ["/Voucher/Factory/saveVoucher", { "voucher[status]": 100 }, { voucher: { status: 50 } }],
  ] as const)("needs commit when the query of %s names its document (%j)", (path, query, body) => {
    expect(minimumWriteTier(path, query, body)).toBe("commit");
    expect(minimumWriteTier(path, undefined, body)).toBe("write");
  });

  it("leaves other query keys of a factory save at write", () => {
    expect(
      minimumWriteTier("/Invoice/Factory/saveInvoice", { takeDefaultAddress: true }, draftInvoice),
    ).toBe("write");
    expect(
      minimumWriteTier("/Order/Factory/saveOrder", { "orderPosSave[0][status]": 500 }, {}),
    ).toBe("write");
  });

  it.each([
    ["/Order/7", undefined],
    ["/Invoice/7", undefined],
    ["/CreditNote/7", undefined],
    ["/Voucher/7", undefined],
    ["/Invoice/Factory/saveInvoice", draftInvoice],
    ["/Order/Factory/saveOrder", { order: { status: 100 } }],
    ["/CreditNote/Factory/saveCreditNote", { creditNote: { status: 100 } }],
    ["/Voucher/Factory/saveVoucher", { voucher: { status: 50 } }],
  ])("needs commit for a form sent to %s, which it cannot read", (path, draft) => {
    expect(minimumWriteTier(path, undefined, draft)).toBe("write");
    expect(minimumWriteTier(path, undefined, draft, form())).toBe("commit");
    expect(minimumWriteTier(path, undefined, draft, new FormData())).toBe("commit");
  });

  it("leaves the receipt upload with its form at write", () => {
    expect(minimumWriteTier("/Voucher/Factory/uploadTempFile", undefined, undefined, form())).toBe(
      "write",
    );
  });

  it("leaves the receipt recognition with its form at write (D-103)", () => {
    // sevdesk_voucher_recognize_receipt is a write tool: its multipart form (creditDebit and the
    // file in the part `voucher`) only ever makes a draft. A rule that treats every unreadable form
    // as binding must not block it.
    const recognition = new FormData();
    recognition.append("creditDebit", "C");
    recognition.append("voucher", new Blob(["%PDF-1.7"], { type: "application/pdf" }), "r.pdf");
    const path = "/Voucher/Factory/createVoucherFromFile";
    expect(minimumWriteTier(path, undefined, undefined, recognition)).toBe("write");
    expect(minimumWriteTier(path, undefined, undefined, form())).toBe("write");
  });
});

describe("minimumWriteTier reads the body as it is sent", () => {
  it("reads what toJSON sends, not the object's own keys", () => {
    const hidden = { header: "Angebot", toJSON: () => ({ status: 500 }) };
    expect(minimumWriteTier("/Order/7", undefined, hidden)).toBe("commit");
    const shown = { status: 500, toJSON: () => ({ header: "Angebot" }) };
    expect(minimumWriteTier("/Order/7", undefined, shown)).toBe("write");
    const order = { status: 100, toJSON: () => ({ status: 500 }) };
    expect(minimumWriteTier("/Order/Factory/saveOrder", undefined, { order })).toBe("commit");
    const invoice = { invoiceType: "RE", toJSON: () => ({ invoiceType: "WKR" }) };
    expect(minimumWriteTier("/Invoice/Factory/saveInvoice", undefined, { invoice })).toBe("commit");
    const voucher = { status: 50, toJSON: () => ({ status: 100 }) };
    expect(minimumWriteTier("/Voucher/Factory/saveVoucher", undefined, { voucher })).toBe("commit");
  });

  it("reads getters, hidden keys and class instances the way JSON.stringify does", () => {
    const getter = Object.defineProperty({}, "status", { enumerable: true, get: () => 500 });
    expect(minimumWriteTier("/Order/7", undefined, getter)).toBe("commit");
    // Neither a key that is not enumerable nor a getter of the prototype is sent.
    const hiddenKey = Object.defineProperty({}, "status", { enumerable: false, value: 500 });
    expect(minimumWriteTier("/Order/7", undefined, hiddenKey)).toBe("write");
    class Body {
      readonly header = "Angebot";
      get status(): number {
        return 500;
      }
    }
    expect(minimumWriteTier("/Order/7", undefined, new Body())).toBe("write");
  });

  it("needs commit for a body without a JSON form, or one that is sent as no object", () => {
    const cyclic: Record<string, unknown> = { header: "x" };
    cyclic["self"] = cyclic;
    for (const body of [cyclic, { header: 1n }, () => undefined, Symbol("body"), new Date(0)]) {
      expect(minimumWriteTier("/Order/7", undefined, body)).toBe("commit");
      expect(minimumWriteTier("/Order/Factory/saveOrder", undefined, body)).toBe("commit");
    }
  });
});

describe("endpoint names before the last segment", () => {
  it.each([
    ["/Invoice/1/getPdf/2", "it marks the document as sent"],
    ["/CreditNote/1/sendByWithRender/x", "it marks the document as sent"],
    ["/Export/createDatevCsvZipExportJob/1", "it starts an export job in sevDesk"],
    ["/Order/Factory/getNextOrderNumber/x", "it reserves the next document number"],
  ])("resolveGetSafety treats %s as a side effect, even with preventSendBy", (path, effect) => {
    expect(resolveGetSafety(path, { preventSendBy: true }, false)).toEqual({
      sideEffect: true,
      effect,
      query: { preventSendBy: true },
    });
  });

  it("resolveGetSafety leaves the customer number and ordinary inner names alone", () => {
    expect(resolveGetSafety("/Contact/Factory/getNextCustomerNumber/x", undefined, false)).toEqual({
      sideEffect: false,
      query: undefined,
    });
    expect(resolveGetSafety("/Invoice/1/getPositions", undefined, false).sideEffect).toBe(false);
  });

  it.each([
    ["/Invoice/1/sendBy/2", "commit"],
    ["/Invoice/1/getPdf/2", "commit"],
    ["/Order/1/sendViaEmail/2", "external"],
    ["/CreditNote/1/sendByWithRender/enshrine", "external"],
    ["/Invoice/1/bookAmount/sendViaEmail", "external"],
    ["/Order/Factory/createContractNoteFromOrder/x", "commit"],
  ] as const)("minimumWriteTier raises %s to %s", (path, tier) => {
    expect(minimumWriteTier(path, undefined)).toBe(tier);
  });

  it("minimumWriteTier never reads Object.prototype for odd segment names", () => {
    expect(minimumWriteTier("/Foo/constructor", undefined)).toBe("write");
    expect(minimumWriteTier("/Foo/__proto__/x", undefined)).toBe("write");
    expect(minimumWriteTier("/Foo/hasOwnProperty", undefined)).toBe("write");
  });
});

describe("genericGetRefusal", () => {
  /** GETs a generic read may send: the spec's reads and the undocumented ones of D-024. */
  const allowed: [string, Record<string, string | number | boolean>?][] = [
    ["/TextTemplate"],
    ["/PartUnity"],
    ["/Document"],
    ["/Document/12"],
    ["/Part/1/getStock"],
    ["/Contact/1/getTabsItemCount"],
    ["/Tools/bookkeepingSystemVersion"],
    ["/CheckAccount/3/getBalanceAtDate", { date: "2026-11-01" }],
    ["/Contact/Factory/findContactsByCustomFieldValue", { value: "x", customFieldName: "y" }],
    ["/Contact/Mapper/checkCustomerNumberAvailability", { customerNumber: "1000" }],
    ["/ContactCustomFieldSetting/4/getReferenceCount"],
    ["/Textparser/fetchDictionaryEntriesByType", { type: "PaymentMethod" }],
    ["/Invoice/9/getPositions"],
    ["/Invoice/9/getIsPartiallyPaid"],
    ["/Order/9/getDiscounts"],
    ["/Order/9/getRelatedObjects", { includeItself: false }],
    ["/ReceiptGuidance/forAllAccounts"],
    ["/ReceiptGuidance/forTaxRule", { taxRule: "USTPFL_UMS_EINN" }],
    ["/Invoice", { "contact[id]": 5, "contact[objectName]": "Contact", status: 200 }],
    ["/ContactAddress", { "contact[id]": 5, "contact[objectName]": "Contact" }],
    ["/Contact", { depth: 1, embed: "parent", orderBy: "name", "orderBy[0][field]": "name" }],
    ["/SevUser"],
    ["/SevClient"],
    ["/AccountDatev"],
    ["/CheckAccountTransactionLog"],
    ["/Settings"],
    ["/Contact/1/addresses"],
    ["/Invoice/1/links"],
    ["/Tag", { name: "send", tokenizer: "x" }],
    ["/Contact", { "category[id]": 3, "ids[]": 4 }],
  ];

  it.each(allowed)("allows %s %j", (path, query) => {
    expect(genericGetRefusal(path, query)).toBeUndefined();
  });

  const pdfTools = /sevdesk_invoice_pdf/;
  it.each([
    ["/Invoice/1/getPdf", pdfTools],
    ["/invoice/1/GETPDF", pdfTools],
    ["/CreditNote/1/getPdf", pdfTools],
    ["/Order/1/getPdf", pdfTools],
    ["/Invoice/1/getXml", pdfTools],
    ["/Invoice/1/render", pdfTools],
    ["/CreditNote/1/sendByWithRender", pdfTools],
    ["/Letter/1/sendByWithRender", pdfTools],
    ["/Invoice/1/getPdf/2", pdfTools],
    ["/Invoice/1/sendBy", /action that changes data/],
    ["/Invoice/1/bookAmount", /action that changes data/],
    ["/Voucher/1/enshrine", /action that changes data/],
    ["/Invoice/1/cancelInvoice", /action that changes data/],
    ["/Invoice/1/resetToDraft", /action that changes data/],
    ["/Invoice/1/resetToOpen", /action that changes data/],
    ["/Order/1/changeParameter", /action that changes data/],
    ["/Invoice/1/sendViaEmail", /action that changes data/],
    ["/Invoice/1/sendBy/x", /action that changes data/],
    ["/Order/Factory/getNextOrderNumber", /sevdesk_contacts_next_customer_number/],
    ["/Contact/Factory/getNextCustomerNumber", /sevdesk_contacts_next_customer_number/],
    ["/Invoice/Factory/getNextInvoiceNumber", /Next-number endpoints/],
    ["/Foo/getNextNumber", /Next-number endpoints/],
    ["/Foo/nextInvoiceNumber", /Next-number endpoints/],
    ["/SevSequence/Factory/getByType", /SevSequence/],
    ["/sevsequence", /SevSequence/],
    ["/Export/invoiceCsv", /sevdesk_csv_export/],
    ["/Export/datevCSV", /sevdesk_datev_export/],
    ["/Export/createDatevCsvZipExportJob", /sevdesk_datev_export/],
    ["/Foo/createDatevXmlZipExportJob", /sevdesk_datev_export/],
    ["/Export/invoiceZip", /sevdesk_archive_export/],
    ["/Export/voucherZip", /sevdesk_archive_export/],
    ["/Foo/invoiceZip", /sevdesk_archive_export/],
    ["/Invoice/voucherzip/1", /sevdesk_archive_export/],
    ["/ExportJob/jobDownloadInfo", /sevdesk_datev_export/],
    ["/Progress/generateDownloadHash", /generateDownloadHash/],
    ["/Progress/getProgress", /sevdesk_datev_export/],
    ["/Report/invoicelist", /PDF files/],
    ["/DocServer/getLetterpapersWithThumb", /base64/],
    ["/Invoice/Factory/saveInvoice", /starts with a verb/],
    ["/Contact/Factory/createContact", /starts with a verb/],
    ["/Invoice/1/setStatus", /starts with a verb/],
    ["/Invoice/1/SETSTATUS", /starts with a verb/],
    ["/Part/1/book_2", /starts with a verb/],
    ["/Invoice/1/send", /starts with a verb/],
    ["/Voucher/Factory/uploadTempFile", /starts with a verb/],
    ["/CheckAccountTransaction/1/delete", /starts with a verb/],
    ["/Foo/1/markAsSent", /starts with a verb/],
    ["/Foo/reserveNumber", /starts with a verb/],
  ])("refuses %s, naming %s", (path, message) => {
    const refusal = genericGetRefusal(path, undefined);
    expect(refusal).toMatch(message);
    // Tool errors show at most 500 characters of a message.
    expect(refusal?.length).toBeLessThan(500);
  });

  it.each([
    [{ token: "abc" }, /Credentials never go into the query/],
    [{ Token: "abc" }, /Credentials/],
    [{ TOKEN: "abc" }, /Credentials/],
    [{ "token[0]": "abc" }, /Credentials/],
    [{ api_key: "abc" }, /Credentials/],
    [{ "Api.Key": "abc" }, /Credentials/],
    [{ apiKey: "abc" }, /Credentials/],
    [{ access_token: "abc" }, /Credentials/],
    [{ Authorization: "abc" }, /Credentials/],
    [{ limit: 10 }, /limit and offset arguments/],
    [{ Offset: 10 }, /limit and offset arguments/],
    [{ countAll: false }, /limit and offset arguments/],
    [{ "countall[x]": 1 }, /limit and offset arguments/],
    [{ download: true }, /raw file answer/],
    [{ preventSendBy: true }, /preventSendBy/],
    [{ enshrine: false }, /irreversibly/],
    [{ enshrineDocuments: 0 }, /irreversibly/],
    [{ "enshrine.all": 0 }, /irreversibly/],
    [{ useNextNumber: false }, /useNextNumber/],
    [{ method: "DELETE" }, /HTTP method/],
    [{ "X.HTTP.Method.Override": "PUT" }, /HTTP method/],
    [{ "api key": "abc" }, /Credentials/],
    // PHP reads an unclosed `[` as `_`: these arrive as api_key, access_token, http_method.
    [{ "api[key": "abc" }, /brackets must pair up/],
    [{ "access[token": "abc" }, /brackets must pair up/],
    [{ "http[method": "PUT" }, /brackets must pair up/],
    [{ "contact[id": 1 }, /brackets must pair up/],
    [{ "contact]id": 1 }, /brackets must pair up/],
    [{ "contact[id]x": 1 }, /brackets must pair up/],
    [{ "a[[b]]": 1 }, /brackets must pair up/],
  ])("refuses the query %j", (query, message) => {
    const refusal = genericGetRefusal("/Invoice", query);
    expect(refusal).toMatch(message);
    expect(refusal?.length).toBeLessThan(500);
  });

  it("refuses a truthy enshrine flag as the side effect it is", () => {
    expect(genericGetRefusal("/Export2/datev", { enshrine: 1 })).toMatch(
      /enshrines \(irreversibly locks\)/,
    );
  });

  it("answers trusted text that never repeats the caller's path or key", () => {
    const refusal = genericGetRefusal("/Invoice/1/getPdf", { "IGNORE.previous": 1 }) ?? "";
    expect(refusal).not.toContain("IGNORE");
    expect(genericGetRefusal("/Invoice", { "Api.Key": "IGNORE" })).not.toContain("IGNORE");
  });
});
