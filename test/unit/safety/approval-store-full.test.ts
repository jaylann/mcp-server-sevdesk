/**
 * What the model is told when an approval request cannot be created because of a limit (review
 * 2026-11, round 3): the per-account limit sends the user to their waiting requests; the store's
 * overall cap must not, because the requests in the way belong to other accounts and the user's
 * own inbox may be empty.
 */
import { describe, expect, it, vi } from "vitest";

import { ApprovalStoreFullError } from "../../../src/safety/approval-store.js";
import { ApprovalLimitError } from "../../../src/safety/approval-types.js";
import { createDummyTools, dummyInvoiceBody } from "../../helpers/dummy-tools.js";
import {
  closeWriteHarnessesAfterEach,
  httpDeployment,
  resultText,
  writeHarness,
  writesOf,
} from "../../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

async function harness() {
  return writeHarness({
    tools: createDummyTools().tools.filter((tool) => tool.name === "sevdesk_dummy_finalize"),
    routes: [{ path: "/Invoice/7", response: { body: dummyInvoiceBody() } }],
    config: { confirm: "browser", deployment: httpDeployment("oauth") },
  });
}

describe("approval limit refusals of the write flow", () => {
  it("does not send the user to the inbox when the store's overall cap refuses", async () => {
    const { client, safety, fake } = await harness();
    vi.spyOn(safety.approvals, "create").mockRejectedValue(new ApprovalStoreFullError(100));

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("too many are open across all accounts");
    expect(text).toContain("nothing for them to approve or reject");
    expect(text).toContain("Nothing was sent to sevDesk.");
    expect(text).not.toContain("approvals inbox");
    expect(text).not.toContain("https://mcp.example.com/approvals");
    expect(text).not.toContain("already waiting");
    expect(writesOf(fake)).toEqual([]);
  });

  it("still names the inbox when the account's own waiting requests are the limit", async () => {
    const { client, safety, fake } = await harness();
    vi.spyOn(safety.approvals, "create").mockRejectedValue(new ApprovalLimitError(5));

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    expect(resultText(result as never)).toContain(
      "5 approval requests are already waiting in the approvals inbox " +
        "(https://mcp.example.com/approvals).",
    );
    expect(writesOf(fake)).toEqual([]);
  });
});
