import { describe, expect, it } from "vitest";

import {
  expectArray,
  expectSingle,
  parseTotal,
  readEnvelope,
} from "../../../src/sevdesk/envelope.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

function kindOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SevdeskError) return error.kind;
    throw error;
  }
  return undefined;
}

describe("readEnvelope", () => {
  it("returns objects and total", () => {
    expect(readEnvelope({ total: "3", objects: [1] })).toEqual({ objects: [1], total: "3" });
    expect(readEnvelope({ objects: null })).toEqual({ objects: null, total: undefined });
  });

  it.each([null, undefined, "x", 3, [], { data: [] }])("rejects %j", (body) => {
    expect(readEnvelope(body)).toBeUndefined();
  });
});

describe("parseTotal", () => {
  it.each([
    ["57", 57],
    ["0", 0],
    [12, 12],
    [undefined, undefined],
    [null, undefined],
    ["", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["12abc", undefined],
    [-3, undefined],
    [2.5, undefined],
    ["99999999999999999999", undefined],
  ])("parses %j as %j", (input, expected) => {
    expect(parseTotal(input)).toBe(expected);
  });
});

describe("expectArray", () => {
  it("passes arrays through", () => {
    const list = [{ id: "1" }];
    expect(expectArray(list)).toBe(list);
  });

  it.each([null, undefined, {}, "x"])("rejects %j as unexpected_response", (payload) => {
    expect(kindOf(() => expectArray(payload, "invoices"))).toBe("unexpected_response");
  });
});

describe("expectSingle", () => {
  it("unwraps an array of one", () => {
    expect(expectSingle([{ id: "1" }], "invoice 1")).toEqual({ id: "1" });
  });

  it("passes a plain object through", () => {
    const record = { version: "2.0" };
    expect(expectSingle(record, "version")).toBe(record);
  });

  it("treats an empty array or null as not_found with a trusted message", () => {
    expect(kindOf(() => expectSingle([], "invoice 1"))).toBe("not_found");
    expect(kindOf(() => expectSingle(null, "invoice 1"))).toBe("not_found");
    expect(() => expectSingle([], "invoice 1")).toThrow("sevDesk found no invoice 1.");
  });

  it("rejects several objects and scalars", () => {
    expect(kindOf(() => expectSingle([{}, {}], "invoice 1"))).toBe("unexpected_response");
    expect(kindOf(() => expectSingle("x", "invoice 1"))).toBe("unexpected_response");
    expect(kindOf(() => expectSingle(5, "invoice 1"))).toBe("unexpected_response");
  });
});
