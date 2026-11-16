/**
 * `fetchVoucherReceiptHash`: the SHA-256 of a voucher's receipt file from `GET /Voucher/{id}` and
 * `GET /Document/{id}` (spec/deviations.md D-100, PR #104), built on the recorded `GET /Document`
 * row (2026-11-10) and the community voucher row.
 */
import { describe, expect, it } from "vitest";

import { fetchVoucherReceiptHash } from "../../../src/domain/document-files.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";
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

function routes(document: unknown, contentHash?: unknown): FakeRoute[] {
  return [
    { path: "/Voucher/2001", response: { body: { objects: [voucher({ document })] } } },
    {
      path: "/Document/77",
      response: { body: { objects: [{ ...structuredClone(DOCUMENT), id: "77", contentHash }] } },
    },
  ];
}

describe("fetchVoucherReceiptHash", () => {
  it("reads the attached document's checksum, lower case, with two plain reads", async () => {
    const client = new FakeSevdeskClient(
      routes({ id: "77", objectName: "Document" }, HASH.toUpperCase()),
    );

    await expect(fetchVoucherReceiptHash(client, 2001)).resolves.toBe(HASH);
    expect(client.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /Voucher/2001",
      "GET /Document/77",
    ]);
    expect(client.writes()).toEqual([]);
  });

  it("has none without a receipt, for a file sevDesk rendered, or for a value that is no SHA-256", async () => {
    const none = new FakeSevdeskClient(routes(null));
    await expect(fetchVoucherReceiptHash(none, 2001)).resolves.toBeUndefined();
    expect(none.calls).toHaveLength(1);

    const ref = { id: "77", objectName: "Document" };
    for (const value of [null, "", "not-a-hash", HASH.slice(1)]) {
      const client = new FakeSevdeskClient(routes(ref, value));
      await expect(fetchVoucherReceiptHash(client, 2001)).resolves.toBeUndefined();
    }
  });
});
