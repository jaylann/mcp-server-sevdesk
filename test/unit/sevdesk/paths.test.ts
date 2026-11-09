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
    ["/Invoice/Factory/saveInvoice", "write"],
    ["/Invoice/Factory/createInvoiceFromOrder", "write"],
    ["/Invoice/Factory/createInvoiceReminder", "write"],
    ["/CreditNote/Factory/createFromInvoice", "write"],
    ["/Contact", "write"],
    ["/Contact/7", "write"],
    ["/ContactAddress", "write"],
    ["/Part/3", "write"],
    ["/Order/12", "write"],
    ["/CheckAccountTransaction/9", "commit"],
    ["/checkaccounttransaction/9", "commit"],
    ["/CheckAccountTransaction/9/enshrine", "commit"],
    ["/CheckAccountTransaction", "write"],
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
