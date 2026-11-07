import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { accountInfoTool as tool } from "../../../../src/tools/meta/account-info.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const regularAccount: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client.json" },
};

function client(
  versionFixture = "meta/bookkeeping-system-version.json",
  account: FakeRoute = regularAccount,
) {
  return new FakeSevdeskClient([
    { path: "/Tools/bookkeepingSystemVersion", response: { fixture: versionFixture } },
    { path: "/SevUser", response: { fixture: "meta/sev-users.json" } },
    account,
  ]);
}

describe("sevdesk_account_info (spec + community fixtures)", () => {
  it("is a read tool with explicit annotations and no arguments", () => {
    expect(tool.name).toBe("sevdesk_account_info");
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.input.safeParse({ verbose: true }).success).toBe(false);
  });

  it("reports version, users and the default (read-only) configuration", async () => {
    const fake = client();
    const result = await tool.handler({}, testContext(fake));

    expect(fake.methods()).toEqual(["GET", "GET", "GET"]);
    expect(fake.callsTo("/SevClient")).toHaveLength(1);
    expect(fake.callsTo("/SevUser")[0]?.query).toMatchObject({ limit: 1000 });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.bookkeepingSystemVersion).toBe("2.0");
    expect(result.data.taxRegime).toBe("regular");
    expect(result.data.chartOfAccounts).toBe("skr04");
    expect(result.data.users).toEqual([
      { id: 2001, name: "Erika Musterfrau", email: "erika@example.com" },
      { id: 2002, name: "Max Mustermann" },
    ]);
    expect(result.data.usersTotal).toBe(2);
    expect(result.data.server).toEqual({
      allowedTiers: ["read"],
      enabledToolsets: [
        "meta",
        "contacts",
        "invoices",
        "credit-notes",
        "orders",
        "vouchers",
        "banking",
        "parts",
        "reports",
      ],
      readOnly: false,
      dryRun: false,
      confirmMode: "elicit",
    });
    expect(result.data.notes).toEqual([
      expect.stringContaining("Update 2.0"),
      "Regular VAT (Regelbesteuerung): documents default to tax rule 1 (0, 7 or 19 %); tax rule " +
        "11 (Kleinunternehmer) is refused.",
      expect.stringContaining("Only read tools are enabled"),
    ]);
    expect(result.summary).toBe(
      "sevDesk bookkeeping system 2.0, regular VAT, 2 users; allowed tiers: read.",
    );
  });

  it("reports a Kleinunternehmer account and reads the settings fresh each time", async () => {
    const fake = client(undefined, {
      path: "/SevClient",
      response: { fixture: "drafts/sev-client-small-business.json" },
    });
    const ctx = testContext(fake);
    await tool.handler({}, ctx);
    const result = await tool.handler({}, ctx);
    expect(fake.callsTo("/SevClient")).toHaveLength(2);
    expect(result.data.taxRegime).toBe("small_business");
    expect(result.data.notes[1]).toMatch(/^Kleinunternehmer account \(§19 UStG\): documents/);
    expect(result.summary).toContain("Kleinunternehmer (§19 UStG)");
  });

  it("says when the VAT regulation cannot be read and keeps the other fields", async () => {
    const result = await tool.handler(
      {},
      testContext(
        client(undefined, {
          path: "/SevClient",
          response: { error: new SevdeskError({ kind: "not_found", message: "Nothing." }) },
        }),
      ),
    );
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.taxRegime).toBe("unknown");
    expect(result.data).not.toHaveProperty("chartOfAccounts");
    expect(result.data.notes[1]).toMatch(/^The VAT regulation could not be read/);
    expect(result.summary).toContain("VAT regulation unknown");
  });

  it("reports an unknown regime on a 403 and still answers", async () => {
    const result = await tool.handler(
      {},
      testContext(
        client(undefined, {
          path: "/SevClient",
          response: {
            error: new SevdeskError({ kind: "auth", message: "Forbidden.", status: 403 }),
          },
        }),
      ),
    );
    expect(result.data.taxRegime).toBe("unknown");
    expect(result.data.usersTotal).toBe(2);
  });

  it("explains a 1.0 account, dry-run and confirmation when writes are allowed", async () => {
    const result = await tool.handler(
      {},
      testContext(client("meta/bookkeeping-system-version-1.json"), {
        SEVDESK_ALLOW: "write,commit",
        SEVDESK_DRY_RUN: "1",
        SEVDESK_TOOLSETS: "contacts",
      }),
    );
    expect(result.data.bookkeepingSystemVersion).toBe("1.0");
    expect(result.data.server.allowedTiers).toEqual(["read", "write", "commit"]);
    expect(result.data.server.enabledToolsets).toEqual(["meta", "contacts"]);
    expect(result.data.notes).toEqual([
      expect.stringContaining("taxType"),
      expect.stringContaining("Regular VAT"),
      expect.stringContaining("Dry-run is on"),
      expect.stringContaining("ask the user for confirmation"),
    ]);
  });

  it("says when read-only mode is forced", async () => {
    const result = await tool.handler(
      {},
      testContext(client(), { SEVDESK_ALLOW: "all", SEVDESK_READ_ONLY: "1" }),
    );
    expect(result.data.server).toMatchObject({ allowedTiers: ["read"], readOnly: true });
    expect(result.data.notes).toContainEqual(expect.stringContaining("Read-only mode"));
  });
});
