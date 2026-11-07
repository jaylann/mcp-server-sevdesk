import { describe, expect, it } from "vitest";

import { nextCustomerNumberTool as tool } from "../../../../src/tools/contacts/next-customer-number.js";
import { FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

describe("sevdesk_contacts_next_customer_number (spec)", () => {
  it("is a read tool with explicit annotations and no arguments", () => {
    expect(tool.tier).toBe("read");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.input.safeParse({}).success).toBe(true);
    expect(tool.input.safeParse({ prefix: "K" }).success).toBe(false);
  });

  it("returns the next number with a summary that does not echo it", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Contact/Factory/getNextCustomerNumber",
        response: { fixture: "contacts/next-customer-number.json" },
      },
    ]);
    const result = await tool.handler({}, testContext(client));
    expect(result.data).toEqual({ customerNumber: "K-1004" });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.summary).not.toContain("K-1004");
    expect(client.methods()).toEqual(["GET"]);
  });
});
