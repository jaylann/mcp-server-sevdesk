import { describe, expect, it } from "vitest";

import {
  argumentsHash,
  canonicalJson,
  previewHash,
  sha256Hex,
} from "../../../src/safety/hashing.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" }, e: undefined })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("keeps array order and escapes strings like JSON", () => {
    expect(canonicalJson(["b", "a", 'q"\n'])).toBe('["b","a","q\\"\\n"]');
  });

  it("accepts objects without a prototype", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { k: 1 });
    expect(canonicalJson(bare)).toBe('{"k":1}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["undefined", undefined],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["undefined in an array", [undefined]],
  ])("refuses %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("hashes", () => {
  it("sha256Hex is the hex SHA-256 of the UTF-8 text", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("argumentsHash binds the tool name and the arguments, but not dryRun", () => {
    const base = argumentsHash("sevdesk_invoice_finalize", { id: 7, sendType: "VPR" });

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(argumentsHash("sevdesk_invoice_finalize", { sendType: "VPR", id: 7 })).toBe(base);
    expect(
      argumentsHash("sevdesk_invoice_finalize", { id: 7, sendType: "VPR", dryRun: true }),
    ).toBe(base);
    expect(argumentsHash("sevdesk_invoice_finalize", { id: 8, sendType: "VPR" })).not.toBe(base);
    expect(argumentsHash("sevdesk_invoice_cancel", { id: 7, sendType: "VPR" })).not.toBe(base);
  });

  it("previewHash changes with any part of the preview", () => {
    const preview = {
      action: "Finalize invoice RE-1.",
      facts: [{ label: "Total", value: "119.00 EUR" }],
      warnings: [],
      irreversible: false,
    };
    const base = previewHash(preview);

    expect(previewHash({ ...preview })).toBe(base);
    expect(previewHash({ ...preview, facts: [{ label: "Total", value: "120.00 EUR" }] })).not.toBe(
      base,
    );
    expect(previewHash({ ...preview, irreversible: true })).not.toBe(base);
    expect(previewHash({ ...preview, warnings: ["Binding."] })).not.toBe(base);
  });
});
