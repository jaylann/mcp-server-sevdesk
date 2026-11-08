import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  assertSafePath,
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
