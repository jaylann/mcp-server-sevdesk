/**
 * The cancel tool through the full MCP write flow (confirmation, execute, error rendering): when
 * sevDesk accepts the cancellation but its answer names no cancellation invoice, the user must
 * read our own guidance ("do not cancel again") and the already-changed invoice, not a generic
 * "try again later".
 */
import { describe, expect, it } from "vitest";

import { invoiceCancelTool } from "../../../../src/tools/lifecycle/cancel.js";
import {
  closeWriteHarnessesAfterEach,
  resultText,
  writeHarness,
  writesOf,
} from "../../../helpers/write-flow.js";
import { documentRoute, invoiceRow } from "./helpers.js";

closeWriteHarnessesAfterEach();

describe("sevdesk_invoice_cancel through MCP", () => {
  it("shows the trusted do-not-cancel-again guidance when sevDesk names no cancellation invoice", async () => {
    const { client, fake, prompts } = await writeHarness({
      tools: [invoiceCancelTool],
      routes: [
        documentRoute("invoice", invoiceRow()),
        {
          method: "POST",
          path: "/Invoice/1001/cancelInvoice",
          response: { body: { objects: { objectName: "Invoice" } } },
        },
      ],
    });

    const result = await client.callTool({
      name: "sevdesk_invoice_cancel",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(1);
    expect(writesOf(fake)).toEqual([{ method: "POST", path: "/Invoice/1001/cancelInvoice" }]);
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain(
      "sevDesk accepted the cancellation of invoice 1001, but its answer did not name the " +
        "cancellation invoice. Do not cancel again: check the invoice with sevdesk_invoice_get " +
        "and find the cancellation with sevdesk_invoices_list (type cancellation).",
    );
    expect(text).toContain("the call had already created or changed: Invoice 1001.");
    expect(text).not.toMatch(/try again/i);
  });
});
