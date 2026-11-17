import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SevdeskClient, SevdeskRequest } from "../../../../src/sevdesk/types.js";
import { datevSettingsUpdateTool } from "../../../../src/tools/reports/datev-settings.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

// The preview checks the fiscal-year start against today: pin it (Berlin 2026-11-17).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const PUT_PATH = "/SevClient/9001/updateExportConfig";

const CONFIGURED: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "exports/sev-client-datev.json" },
};
const UNCONFIGURED: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "exports/sev-client-no-datev.json" },
};
const PUT: FakeRoute = { method: "PUT", path: PUT_PATH, response: { body: { objects: null } } };

/** `GET /SevClient` with the DATEV settings as sevDesk stores them after the update. */
function sevClient(accountantNumber: string, clientNumber: string, yearBegin: string): FakeRoute {
  return {
    path: "/SevClient",
    response: {
      body: {
        objects: [
          {
            id: "9001",
            objectName: "SevClient",
            accountantNumber,
            accountantClientNumber: clientNumber,
            accountingYearBegin: yearBegin,
          },
        ],
      },
    },
  };
}

/**
 * A client that answers from `before` until the PUT went through, then from `after`, so the read
 * back sees what sevDesk stored.
 */
function switchingClient(before: FakeSevdeskClient, after: FakeSevdeskClient): SevdeskClient {
  let written = false;
  return {
    request: async (request: SevdeskRequest) => {
      if (written) return after.request(request);
      const answer = await before.request(request);
      if (request.method === "PUT") written = true;
      return answer;
    },
    list: (...args) => before.list(...args),
    listAll: (...args) => before.listAll(...args),
    download: (request) => before.download(request),
  };
}

describe("sevdesk_datev_settings_update: metadata", () => {
  it("is a commit tool with a lock and explicit annotations", () => {
    expect(datevSettingsUpdateTool).toMatchObject({
      tier: "commit",
      toolset: "reports",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(datevSettingsUpdateTool.locks?.(datevSettingsUpdateTool.input.parse({}))).toEqual([
      { objectName: "DatevSettings", id: "account" },
    ]);
  });

  it.each([
    [{ accountantNumber: 1000 }],
    [{ accountantNumber: 10_000_000 }],
    [{ accountantClientNumber: 0 }],
    [{ accountantClientNumber: 100_000 }],
    [{ accountantClientNumber: "12345" }],
    [{ accountingYearBegin: "01.01.2026" }],
    [{ accountingYearBegin: "2026-02-30" }],
  ])("rejects %j in the input schema", (args) => {
    expect(datevSettingsUpdateTool.input.safeParse(args).success).toBe(false);
  });
});

describe("sevdesk_datev_settings_update: prepare", () => {
  it("shows current and new values in English and German, unchanged ones as unchanged", async () => {
    const client = new FakeSevdeskClient([CONFIGURED]);

    const plan = await prepareWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321, accountingYearBegin: "2026-07-01" },
      client,
    );

    expect(plan.preview.action).toBe("Change sevDesk's DATEV export settings (account-wide).");
    expect(plan.preview.facts).toEqual([
      { label: "Beraternummer (accountant number)", value: "1234567 (unchanged)" },
      { label: "Mandantennummer (client number)", value: "12345 → 54321" },
      { label: "Wirtschaftsjahresbeginn (fiscal-year start)", value: "2026-01-01 → 2026-07-01" },
    ]);
    expect(plan.previewDe.facts).toEqual([
      { label: "Beraternummer", value: "1234567 (unverändert)" },
      { label: "Mandantennummer", value: "12345 → 54321" },
      { label: "Wirtschaftsjahresbeginn", value: "01.01.2026 → 01.07.2026" },
    ]);
    expect(plan.preview.warnings).toHaveLength(plan.previewDe.warnings.length);
    expect(plan.preview.warnings[0]).toContain("wrong client");
    expect(plan.preview.irreversible).toBe(false);
    expect(client.writes()).toEqual([]);
  });

  it("shows unset values and warns about a fiscal year that does not start on the first", async () => {
    const plan = await prepareWrite(
      datevSettingsUpdateTool,
      { accountantNumber: 1001, accountantClientNumber: 1, accountingYearBegin: "2026-03-15" },
      new FakeSevdeskClient([UNCONFIGURED]),
    );
    expect(plan.preview.facts[0]).toEqual({
      label: "Beraternummer (accountant number)",
      value: "(not set) → 1001",
    });
    expect(plan.previewDe.facts[0]?.value).toBe("(nicht gesetzt) → 1001");
    expect(plan.preview.warnings.at(-1)).toContain("2026-03-15 is not the first day of a month");
    expect(plan.previewDe.warnings.at(-1)).toContain("15.03.2026");
  });

  it.each(["2031-01-01", "1990-01-01"])(
    "warns in both languages about a fiscal-year start of %s, more than a year away",
    async (date) => {
      const plan = await prepareWrite(
        datevSettingsUpdateTool,
        { accountingYearBegin: date },
        new FakeSevdeskClient([CONFIGURED]),
      );
      const german = `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
      expect(plan.preview.warnings).toContain(
        `The fiscal-year start ${date} is more than a year away from today; it should be the ` +
          "first day of the current fiscal year. Set another date only when the tax adviser " +
          "asks for it: every later DATEV export is split by it.",
      );
      expect(plan.previewDe.warnings).toContain(
        `Der Wirtschaftsjahresbeginn ${german} liegt mehr als ein Jahr vom heutigen Tag ` +
          "entfernt; gemeint ist der erste Tag des laufenden Wirtschaftsjahres. Setz ein anderes " +
          "Datum nur, wenn die Steuerkanzlei es so will: Jeder spätere DATEV-Export wird danach " +
          "getrennt.",
      );
      expect(plan.preview.warnings).toHaveLength(plan.previewDe.warnings.length);
    },
  );

  it("does not warn about a fiscal-year start within a year", async () => {
    const plan = await prepareWrite(
      datevSettingsUpdateTool,
      { accountingYearBegin: "2026-07-01" },
      new FakeSevdeskClient([CONFIGURED]),
    );
    expect(plan.preview.warnings.join(" ")).not.toContain("more than a year");
  });

  it("warns in both languages when it resends a current number outside DATEV's range", async () => {
    const client = new FakeSevdeskClient([sevClient("999", "12345", "2026-01-01T00:00:00+01:00")]);

    const plan = await prepareWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321 },
      client,
    );

    expect(plan.preview.facts[0]).toEqual({
      label: "Beraternummer (accountant number)",
      value: "999 (unchanged)",
    });
    expect(plan.preview.warnings).toContain(
      "The current Beraternummer (accountant number) 999 lies outside DATEV's range " +
        "(1001–9999999) and is sent again unchanged: DATEV's import may refuse the export. Give " +
        "the right number from the tax adviser as well.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Die bisherige Beraternummer 999 liegt außerhalb des DATEV-Bereichs (1001–9999999) und " +
        "wird unverändert erneut gesendet: Der DATEV-Import kann den Export ablehnen. Gib die " +
        "richtige Nummer der Steuerkanzlei mit an.",
    );
    expect(plan.preview.warnings).toHaveLength(plan.previewDe.warnings.length);
    expect(client.writes()).toEqual([]);
  });

  it.each([
    [{}, CONFIGURED, "give at least one"],
    [{ accountantNumber: 1234567 }, CONFIGURED, "nothing to change"],
    [{ accountantNumber: 1001 }, UNCONFIGURED, "not set in sevDesk yet"],
  ] as const)("refuses %j before anything is sent", async (args, route, text) => {
    const client = new FakeSevdeskClient([route]);
    const error = await prepareWrite(datevSettingsUpdateTool, args, client).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toContain(text);
    expect(client.writes()).toEqual([]);
  });
});

describe("sevdesk_datev_settings_update: execute", () => {
  it("sends all three settings once with the commit tier and reports what sevDesk stored", async () => {
    const before = new FakeSevdeskClient([CONFIGURED, PUT]);
    const after = new FakeSevdeskClient([
      sevClient("1234567", "54321", "2026-01-01T00:00:00+01:00"),
    ]);

    const { output } = await executeWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321 },
      switchingClient(before, after),
    );

    expect(before.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: PUT_PATH,
        tier: "commit",
        body: {
          accountantNumber: 1234567,
          accountantClientNumber: 54321,
          accountingYearBegin: Date.parse("2026-01-01T00:00:00+01:00") / 1000,
        },
      }),
    ]);
    expect(output.data).toEqual({
      settings: {
        accountantNumber: "1234567",
        accountantClientNumber: "54321",
        accountingYearBegin: "2026-01-01",
      },
      changed: ["accountantClientNumber"],
      storedAsSent: true,
      warnings: [],
    });
    expect(output.summary).toBe(
      "DATEV settings updated (accountantClientNumber); sevDesk stored the values as sent.",
    );
    expect(output.affected).toEqual([{ objectName: "SevClient", id: "9001" }]);
  });

  it("warns when sevDesk reads back something else", async () => {
    const before = new FakeSevdeskClient([CONFIGURED, PUT]);
    const after = new FakeSevdeskClient([
      sevClient("1234567", "12345", "2026-01-01T00:00:00+01:00"),
    ]);

    const { output } = await executeWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321 },
      switchingClient(before, after),
    );

    expect(output.data).toMatchObject({ storedAsSent: false });
    expect((output.data as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining("Mandantennummer (client number) as 12345, not as sent (54321)"),
    ]);
  });

  it("reads a stored leading zero back as the same number, not as a difference", async () => {
    const before = new FakeSevdeskClient([
      sevClient("01001", "12345", "2026-01-01T00:00:00+01:00"),
      PUT,
    ]);
    // Sent as the JSON number 1001, so sevDesk reads it back without the zero.
    const after = new FakeSevdeskClient([sevClient("1001", "54321", "2026-01-01T00:00:00+01:00")]);

    const { output } = await executeWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321 },
      switchingClient(before, after),
    );

    expect(before.writes()[0]?.body).toMatchObject({ accountantNumber: 1001 });
    expect(output.data).toMatchObject({ storedAsSent: true, warnings: [] });
  });

  it("names the changed account when the read-back fails", async () => {
    const before = new FakeSevdeskClient([CONFIGURED, PUT]);
    const after = new FakeSevdeskClient([
      { path: "/SevClient", response: { body: { objects: [] } } },
    ]);

    const error = await executeWrite(
      datevSettingsUpdateTool,
      { accountantClientNumber: 54321 },
      switchingClient(before, after),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ completedWrites: [{ objectName: "SevClient", id: "9001" }] });
  });
});
