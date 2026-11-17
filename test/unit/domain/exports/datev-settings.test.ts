import { describe, expect, it } from "vitest";

import type { DatevExportConfig } from "../../../../src/domain/exports/datev.js";
import {
  planDatevSettings,
  storedDifferently,
  updateDatevExportConfig,
} from "../../../../src/domain/exports/datev-settings.js";
import { minimumWriteTier } from "../../../../src/sevdesk/paths.js";
import { tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";

const SET: DatevExportConfig = {
  accountantNumber: "1234567",
  accountantClientNumber: "12345",
  accountingYearBegin: "2026-01-01",
  missing: [],
  clientId: 9001,
};

const UNSET: DatevExportConfig = {
  missing: ["accountant number", "client number", "start of the fiscal year"],
  clientId: 9001,
};

describe("planDatevSettings", () => {
  it("keeps what the caller leaves out and marks what changes", () => {
    const plan = planDatevSettings(SET, { accountantClientNumber: 54321 });

    expect(plan.changes).toEqual([
      { key: "accountantNumber", current: "1234567", next: "1234567", changed: false },
      { key: "accountantClientNumber", current: "12345", next: "54321", changed: true },
      { key: "accountingYearBegin", current: "2026-01-01", next: "2026-01-01", changed: false },
    ]);
    // The spec requires all three; unchanged ones go out with sevDesk's current value.
    expect(plan.body).toEqual({
      accountantNumber: 1234567,
      accountantClientNumber: 54321,
      accountingYearBegin: Date.parse("2026-01-01T00:00:00+01:00") / 1000,
    });
    expect(plan.clientId).toBe(9001);
  });

  it("sends the fiscal-year start as Unix seconds of Berlin midnight (the recorded form)", () => {
    const plan = planDatevSettings(SET, { accountingYearBegin: "2026-07-01" });
    expect(plan.body.accountingYearBegin).toBe(Date.parse("2026-07-01T00:00:00+02:00") / 1000);
    expect(plan.sent.accountingYearBegin).toBe("2026-07-01");
  });

  it("sets all three on an account without DATEV settings", () => {
    const plan = planDatevSettings(UNSET, {
      accountantNumber: 1001,
      accountantClientNumber: 1,
      accountingYearBegin: "2026-01-01",
    });
    expect(plan.changes.every((change) => change.changed && change.current === undefined)).toBe(
      true,
    );
  });

  it.each([
    [{}, SET, "give at least one"],
    [{ accountantNumber: 1000 }, SET, "1001 to 9999999"],
    [{ accountantNumber: 10_000_000 }, SET, "1001 to 9999999"],
    [{ accountantClientNumber: 0 }, SET, "1 to 99999"],
    [{ accountantClientNumber: 100_000 }, SET, "1 to 99999"],
    [{ accountantClientNumber: 1.5 }, SET, "whole number"],
    [{ accountantNumber: 1234567 }, SET, "nothing to change"],
    [
      { accountantNumber: 1001 },
      UNSET,
      "accountantClientNumber (Mandantennummer), accountingYearBegin",
    ],
  ] as const)("refuses %j locally", (input, config, text) => {
    expect(() => planDatevSettings(config, input)).toThrow(
      expect.objectContaining({
        kind: "validation",
        message: expect.stringContaining(text) as unknown,
      }),
    );
  });

  it("compares the numbers by value: a stored 01001 is the same as 1001", () => {
    const leadingZero: DatevExportConfig = { ...SET, accountantNumber: "01001" };

    const plan = planDatevSettings(leadingZero, { accountantClientNumber: 54321 });

    expect(plan.changes[0]).toMatchObject({ key: "accountantNumber", changed: false });
    // It goes out as a JSON number, so sevDesk reads it back without the zero.
    expect(plan.body.accountantNumber).toBe(1001);
    expect(
      storedDifferently(plan.sent, {
        accountantNumber: "1001",
        accountantClientNumber: "54321",
        accountingYearBegin: "2026-01-01",
      }),
    ).toEqual([]);
    expect(() => planDatevSettings(leadingZero, { accountantNumber: 1001 })).toThrow(
      expect.objectContaining({ message: expect.stringContaining("nothing to change") as unknown }),
    );
  });

  it("names the numbers it resends unchanged although they are outside DATEV's range", () => {
    const outside: DatevExportConfig = {
      ...SET,
      accountantNumber: "999",
      accountantClientNumber: "123456",
    };

    expect(
      planDatevSettings(outside, { accountingYearBegin: "2026-07-01" }).keptOutOfRange,
    ).toEqual(["accountantNumber", "accountantClientNumber"]);
    // A number given now replaces the stored one and is always in range.
    expect(
      planDatevSettings(outside, { accountantNumber: 1001, accountantClientNumber: 1 })
        .keptOutOfRange,
    ).toEqual([]);
    expect(planDatevSettings(SET, { accountantClientNumber: 54321 }).keptOutOfRange).toEqual([]);
  });

  it("refuses when the account id is unknown", () => {
    expect(() =>
      planDatevSettings({ ...SET, clientId: undefined }, { accountantClientNumber: 2 }),
    ).toThrow(expect.objectContaining({ kind: "unexpected_response" }));
  });
});

describe("updateDatevExportConfig", () => {
  it("sends one PUT with the JSON numbers, at the write tier minimum", async () => {
    const path = "/SevClient/9001/updateExportConfig";
    const client = new FakeSevdeskClient([
      { method: "PUT", path, response: { body: { objects: null } } },
    ]);
    const plan = planDatevSettings(SET, { accountantClientNumber: 54321 });

    await updateDatevExportConfig(tierScopedClient(client, "commit"), plan);

    expect(client.writes()).toEqual([
      expect.objectContaining({ method: "PUT", path, body: plan.body, tier: "commit" }),
    ]);
    expect(minimumWriteTier(path, undefined, plan.body)).toBe("write");
  });
});

describe("storedDifferently", () => {
  it("names the settings sevDesk reads back differently", () => {
    const sent = {
      accountantNumber: "1234567",
      accountantClientNumber: "54321",
      accountingYearBegin: "2026-01-01",
    };
    expect(storedDifferently(sent, sent)).toEqual([]);
    expect(
      storedDifferently(sent, { accountantNumber: "1234567", accountingYearBegin: "2025-12-31" }),
    ).toEqual(["accountantClientNumber", "accountingYearBegin"]);
    // Numbers by value, a leading zero is no difference; another number still is.
    expect(storedDifferently(sent, { ...sent, accountantClientNumber: "054321" })).toEqual([]);
    expect(storedDifferently(sent, { ...sent, accountantNumber: "1234568" })).toEqual([
      "accountantNumber",
    ]);
  });
});
