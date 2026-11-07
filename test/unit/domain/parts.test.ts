import { describe, expect, it } from "vitest";

import { getPartDetails, listParts } from "../../../src/domain/parts.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

describe("parts domain", () => {
  it("sanitizes and caps untrusted part texts", async () => {
    const hidden = String.fromCodePoint(0x2060);
    const client = new FakeSevdeskClient([
      {
        path: "/Part/6100",
        response: {
          body: {
            objects: [
              {
                id: "6100",
                name: `Teil${hidden} A`,
                partNumber: `  A-1${hidden} `,
                text: "t".repeat(2_500),
                internalComment: `Hinweis\r\nZeile 2`,
                stockEnabled: null,
                status: null,
                create: 1_767_222_000,
              },
            ],
          },
        },
      },
    ]);
    const part = await getPartDetails(client, 6100);
    expect(part).toMatchObject({
      name: "Teil A",
      partNumber: "A-1",
      internalComment: "Hinweis\nZeile 2",
      stockEnabled: false,
      createdAt: "2026-01-01",
    });
    expect(part.description).toMatch(/^t{2000}… \[truncated 500 chars\]$/);
    expect(part.active).toBeUndefined();
  });

  it("reports paging state from sevDesk's total", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Part", response: { body: { total: "40", objects: [{ id: "6100" }] } } },
    ]);
    const result = await listParts(client, { limit: 1, offset: 5 });
    expect(result.window).toEqual({ offset: 5, received: 1, total: 40 });
    expect(result.state).toEqual({ hasMore: true, nextOffset: 6 });
  });

  it("rejects an invalid id locally", async () => {
    await expect(getPartDetails(new FakeSevdeskClient([]), -3)).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("fails loudly on an unreadable timestamp", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Part", response: { body: { objects: [{ id: "6100", update: "neulich" }] } } },
    ]);
    await expect(listParts(client, { limit: 1, offset: 0 })).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});
