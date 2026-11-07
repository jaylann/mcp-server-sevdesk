import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  zBerlinDate,
  zBool01,
  zDecimalString,
  zId,
  zIntish,
  zNullableInt,
  zNumberish,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
  zOptionalString,
  zRef,
  zText,
} from "../../../src/sevdesk/schema.js";

function fails(schema: z.ZodType, input: unknown): boolean {
  return !schema.safeParse(input).success;
}

describe("zId", () => {
  it.each([
    ["123", 123],
    [123, 123],
    ["007", 7],
  ])("parses %j", (input, expected) => {
    expect(zId.parse(input)).toBe(expected);
  });

  it.each([
    0,
    "0",
    -1,
    "-1",
    1.5,
    "1.5",
    "12abc",
    "",
    null,
    undefined,
    "99999999999999999999",
    2 ** 53,
  ])("rejects %j", (input) => {
    expect(fails(zId, input)).toBe(true);
  });
});

describe("zIntish", () => {
  it.each([
    ["100", 100],
    [1000, 1000],
    ["-5", -5],
    ["0", 0],
  ])("parses %j", (input, expected) => {
    expect(zIntish.parse(input)).toBe(expected);
  });

  it.each(["1.5", 1.5, "", "abc", null, "99999999999999999999"])("rejects %j", (input) => {
    expect(fails(zIntish, input)).toBe(true);
  });
});

describe("zNumberish", () => {
  it.each([
    ["19.99", 19.99],
    [19.99, 19.99],
    ["-3", -3],
    ["0", 0],
    [0, 0],
    ["1e3", 1000],
    [null, undefined],
    ["", undefined],
  ])("parses %j", (input, expected) => {
    expect(zNumberish.parse(input)).toBe(expected);
  });

  it.each([" ", "0x1A", "Infinity", "1,5", "abc", "1e999", true])("rejects %j", (input) => {
    expect(fails(zNumberish, input)).toBe(true);
  });

  it("does not echo the offending value in the issue message", () => {
    const result = zNumberish.safeParse("<script>");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("expected a decimal number");
  });
});

describe("zDecimalString", () => {
  it.each([
    ["2903.62000000001", "2903.62000000001"],
    [2903.62000000001, "2903.62000000001"],
    ["-0.50", "-0.50"],
    [0, "0"],
    ["1e-7", "1e-7"],
    [null, undefined],
    ["", undefined],
  ])("keeps %j as %j", (input, expected) => {
    expect(zDecimalString.parse(input)).toBe(expected);
  });

  it.each(["1,50", " 1", "abc", "0x10", Number.NaN, Number.POSITIVE_INFINITY, false])(
    "rejects %j",
    (input) => {
      expect(fails(zDecimalString, input)).toBe(true);
    },
  );
});

describe("zBool01", () => {
  it.each([
    ["1", true],
    ["0", false],
    [1, true],
    [0, false],
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
    [null, undefined],
  ])("parses %j as %j", (input, expected) => {
    expect(zBool01.parse(input)).toBe(expected);
  });

  it.each(["2", "yes", 2, ""])("rejects %j", (input) => {
    expect(fails(zBool01, input)).toBe(true);
  });
});

describe("zOptionalString", () => {
  it.each([
    ["text", "text"],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
    [" ", " "],
  ])("parses %j as %j", (input, expected) => {
    expect(zOptionalString.parse(input)).toBe(expected);
  });

  it("rejects non-strings", () => {
    expect(fails(zOptionalString, 5)).toBe(true);
  });

  it("makes an object field optional", () => {
    const schema = z.object({ name: zOptionalString });
    expect(schema.parse({})).toEqual({ name: undefined });
  });
});

describe("zRef", () => {
  it("parses a reference with any object name", () => {
    expect(zRef().parse({ id: "5", objectName: "Contact" })).toEqual({
      id: 5,
      objectName: "Contact",
    });
  });

  it("checks a fixed object name", () => {
    const contactRef = zRef("Contact");
    expect(contactRef.parse({ id: 5, objectName: "Contact" })).toEqual({
      id: 5,
      objectName: "Contact",
    });
    expect(fails(contactRef, { id: 5, objectName: "Invoice" })).toBe(true);
    expect(fails(contactRef, { id: "0", objectName: "Contact" })).toBe(true);
    expect(fails(contactRef, { objectName: "Contact" })).toBe(true);
  });
});

// zod 4 makes a key whose schema ends in `.transform()` required unless `.optional()` comes
// first, so every optional helper is also checked inside an object without the key.
describe.each([
  ["zText", zText],
  ["zOptionalDecimal", zOptionalDecimal],
  ["zOptionalInt", zOptionalInt],
  ["zNullableInt", zNullableInt],
  ["zBerlinDate", zBerlinDate],
  ["zOptionalRef", zOptionalRef],
])("%s inside an object", (_name, schema: z.ZodType) => {
  it("parses a record without the key", () => {
    expect(z.object({ field: schema }).parse({})).toEqual({ field: undefined });
  });

  it("parses null as unset", () => {
    expect(z.object({ field: schema }).parse({ field: null })).toEqual({ field: undefined });
  });
});

describe("zText", () => {
  it.each([
    ["text", "text"],
    [" padded ", " padded "],
    [1001, "1001"],
    [0, "0"],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("parses %j as %j", (input, expected) => {
    expect(zText.parse(input)).toBe(expected);
  });

  it.each([true, {}, ["a"]])("rejects %j", (input) => {
    expect(fails(zText, input)).toBe(true);
  });
});

describe("zOptionalInt and zNullableInt", () => {
  it.each([
    ["14", 14],
    [14, 14],
    ["-1", -1],
    [null, undefined],
    [undefined, undefined],
  ])("both parse %j as %j", (input, expected) => {
    expect(zOptionalInt.parse(input)).toBe(expected);
    expect(zNullableInt.parse(input)).toBe(expected);
  });

  it("differ on an empty string: unset for zOptionalInt, invalid for zNullableInt", () => {
    expect(zOptionalInt.parse("")).toBeUndefined();
    expect(fails(zNullableInt, "")).toBe(true);
  });

  it.each(["1.5", "abc", 1.5, true])("both reject %j", (input) => {
    expect(fails(zOptionalInt, input)).toBe(true);
    expect(fails(zNullableInt, input)).toBe(true);
  });
});

describe("zBerlinDate", () => {
  it.each([
    ["2026-03-01T00:00:00+01:00", "2026-03-01"],
    ["2026-02-28T23:30:00Z", "2026-03-01"],
    ["01.03.2026", "2026-03-01"],
    [1772319600, "2026-03-01"],
    ["", undefined],
  ])("parses %j as %j", (input, expected) => {
    expect(zBerlinDate.parse(input)).toBe(expected);
  });

  it.each(["yesterday", "2026-13-01", true, {}])("fails the record for %j", (input) => {
    const result = zBerlinDate.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("expected a date");
  });
});

describe("zOptionalRef", () => {
  it("parses a reference", () => {
    expect(zOptionalRef.parse({ id: "7", objectName: "Contact" })).toEqual({
      id: 7,
      objectName: "Contact",
    });
  });

  it("rejects a reference without a valid id", () => {
    expect(fails(zOptionalRef, { id: "0", objectName: "Contact" })).toBe(true);
    expect(fails(zOptionalRef, { objectName: "Contact" })).toBe(true);
  });
});
