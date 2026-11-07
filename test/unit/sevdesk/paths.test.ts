import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  assertSafePath,
  isSevdeskId,
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

  it("passes ordinary reads through and honors the declared flag", () => {
    const query = { status: 100 };
    expect(resolveGetSafety("/Invoice", query, false)).toEqual({ sideEffect: false, query });
    expect(resolveGetSafety("/Invoice/1/getXml", undefined, true)).toMatchObject({
      sideEffect: true,
    });
  });
});
