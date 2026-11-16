/**
 * `voucherReceiptOf`: the receipt a voucher row names and, with `embed=document`, the SHA-256 of
 * its file (`contentHash`, spec/deviations.md D-100, PR #104), built on the recorded
 * `GET /Document` row (2026-11-10) and the community voucher row.
 */
import { describe, expect, it } from "vitest";

import { voucherReceiptOf } from "../../../src/domain/document-files.js";
import { loadFixture } from "../../helpers/fake-client.js";
import { voucher } from "../tools/reports/records.js";

type Raw = Record<string, unknown>;

const DOCUMENT = (() => {
  const body = loadFixture("recorded/2026-11-10/advanced/documents.json").body as {
    objects: Raw[];
  };
  const row = body.objects[0];
  if (row === undefined) throw new Error("document fixture is empty");
  return row;
})();

const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function embedded(contentHash: unknown): Raw {
  return { ...structuredClone(DOCUMENT), id: "77", contentHash };
}

describe("voucherReceiptOf", () => {
  it("reads the embedded document's checksum, lower case", () => {
    expect(voucherReceiptOf(voucher({ document: embedded(HASH.toUpperCase()) }))).toEqual({
      documentId: 77,
      hash: HASH,
      embedded: true,
    });
  });

  it("knows the document but no checksum from a plain reference (no embed)", () => {
    expect(voucherReceiptOf(voucher({ document: { id: "77", objectName: "Document" } }))).toEqual({
      documentId: 77,
      hash: undefined,
      embedded: false,
    });
  });

  it("has no checksum for a rendered file or a value that is no SHA-256", () => {
    for (const value of [null, "", "not-a-hash", HASH.slice(1), 42]) {
      expect(voucherReceiptOf(voucher({ document: embedded(value) }))).toEqual({
        documentId: 77,
        hash: undefined,
        embedded: true,
      });
    }
  });

  it("has no receipt without a document, and never fails the row", () => {
    expect(voucherReceiptOf(voucher({ document: null }))).toBeUndefined();
    expect(voucherReceiptOf(voucher({}))).toBeUndefined();
    expect(voucherReceiptOf(voucher({ document: { id: "x" } }))).toBeUndefined();
    expect(voucherReceiptOf("not a row")).toBeUndefined();
    expect(voucherReceiptOf(null)).toBeUndefined();
  });
});
