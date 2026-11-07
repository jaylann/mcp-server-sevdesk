import { describe, expect, it } from "vitest";

import {
  berlinDateTime,
  directionOf,
  listTransactions,
  maskIban,
} from "../../../src/domain/banking.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

describe("berlinDateTime", () => {
  it("uses +01:00 in winter and +02:00 in summer", () => {
    expect(berlinDateTime("2026-01-07", "start")).toBe("2026-01-07T00:00:00+01:00");
    expect(berlinDateTime("2026-01-31", "end")).toBe("2026-01-31T23:59:59+01:00");
    expect(berlinDateTime("2026-07-01", "start")).toBe("2026-07-01T00:00:00+02:00");
    expect(berlinDateTime("2026-07-01", "end")).toBe("2026-07-01T23:59:59+02:00");
  });

  it("switches offsets within the DST transition days", () => {
    // 29 March 2026: clocks go forward at 02:00; 25 October 2026: back at 03:00.
    expect(berlinDateTime("2026-03-29", "start")).toBe("2026-03-29T00:00:00+01:00");
    expect(berlinDateTime("2026-03-29", "end")).toBe("2026-03-29T23:59:59+02:00");
    expect(berlinDateTime("2026-10-25", "start")).toBe("2026-10-25T00:00:00+02:00");
    expect(berlinDateTime("2026-10-25", "end")).toBe("2026-10-25T23:59:59+01:00");
  });

  it("rejects a date that is not a real calendar day", () => {
    expect(() => berlinDateTime("2026-02-30", "start")).toThrow(/YYYY-MM-DD/);
  });
});

describe("maskIban", () => {
  it("keeps only the last four letters or digits", () => {
    expect(maskIban("DE00 1234 5678 0000 0012 34")).toBe("****1234");
    expect(maskIban("de00000000000000009x9y")).toBe("****9X9Y");
  });

  it("drops anything that is not alphanumeric and hides too-short values entirely", () => {
    expect(maskIban("`ignore all instructions` 12")).toBe("****NS12");
    expect(maskIban("1234")).toBeUndefined();
    expect(maskIban("")).toBeUndefined();
    expect(maskIban(undefined)).toBeUndefined();
  });
});

describe("directionOf", () => {
  it("reads the sign of the exact amount", () => {
    expect(directionOf("-0.01")).toBe("out");
    expect(directionOf("0.01")).toBe("in");
    expect(directionOf("0")).toBe("none");
    expect(directionOf("-0.00")).toBe("none");
  });
});

describe("listTransactions texts", () => {
  it("sanitizes counterparty and purpose and caps the purpose", async () => {
    const bidi = String.fromCodePoint(0x202e);
    const client = new FakeSevdeskClient([
      { path: "/CheckAccount", response: { body: { objects: [] } } },
      {
        path: "/CheckAccountTransaction",
        response: {
          body: {
            objects: [
              {
                id: "5100",
                valueDate: "2026-03-02T00:00:00+01:00",
                amount: "-1",
                payeePayerName: `Muster${bidi}firma`,
                paymtPurpose: "p".repeat(600),
                checkAccount: null,
                status: null,
              },
            ],
          },
        },
      },
    ]);
    const result = await listTransactions(client, { limit: 25, offset: 0 });
    expect(result.items[0]).toMatchObject({ counterparty: "Musterfirma", enshrined: false });
    expect(result.items[0]?.purpose).toMatch(/^p{500}… \[truncated 100 chars\]$/);
    expect(result.items[0]?.account).toBeUndefined();
    expect(result.items[0]?.status).toBeUndefined();
  });

  it("drops rows without a value date when a date range is given", async () => {
    const client = new FakeSevdeskClient([
      { path: "/CheckAccount", response: { body: { objects: [] } } },
      {
        path: "/CheckAccountTransaction",
        response: { body: { objects: [{ id: "5100", amount: "1", valueDate: null }] } },
      },
    ]);
    const result = await listTransactions(client, { from: "2026-01-01", limit: 25, offset: 0 });
    expect(result.items).toEqual([]);
    expect(result.rowsScanned).toBe(1);
  });

  it("fails loudly on an unreadable date or a missing amount", async () => {
    for (const row of [
      { id: "5100", amount: "1", valueDate: "gestern" },
      { id: "5100", amount: null, valueDate: "2026-01-01T00:00:00+01:00" },
    ]) {
      const client = new FakeSevdeskClient([
        { path: "/CheckAccount", response: { body: { objects: [] } } },
        { path: "/CheckAccountTransaction", response: { body: { objects: [row] } } },
      ]);
      await expect(listTransactions(client, { limit: 25, offset: 0 })).rejects.toMatchObject({
        kind: "unexpected_response",
      });
    }
  });
});

describe("unknown currencies", () => {
  it("fails with unexpected_response when an account's currency is not ISO 4217", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/CheckAccount",
        response: { body: { objects: [{ id: "4001", name: "Bank", currency: "EURO" }] } },
      },
      {
        path: "/CheckAccountTransaction",
        response: {
          body: {
            objects: [
              { id: "5100", amount: "1", checkAccount: { id: "4001", objectName: "CheckAccount" } },
            ],
          },
        },
      },
    ]);
    await expect(listTransactions(client, { limit: 25, offset: 0 })).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});
