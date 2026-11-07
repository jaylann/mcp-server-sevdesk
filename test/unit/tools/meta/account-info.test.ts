import { describe, expect, it } from "vitest";

import { accountInfoTool as tool } from "../../../../src/tools/meta/account-info.js";
import { FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

function client(versionFixture = "meta/bookkeeping-system-version.json") {
  return new FakeSevdeskClient([
    { path: "/Tools/bookkeepingSystemVersion", response: { fixture: versionFixture } },
    { path: "/SevUser", response: { fixture: "meta/sev-users.json" } },
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

    expect(fake.methods()).toEqual(["GET", "GET"]);
    expect(fake.callsTo("/SevUser")[0]?.query).toMatchObject({ limit: 1000 });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.bookkeepingSystemVersion).toBe("2.0");
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
      expect.stringContaining("Only read tools are enabled"),
    ]);
    expect(result.summary).toBe("sevDesk bookkeeping system 2.0, 2 users; allowed tiers: read.");
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
