/** A small, finite recorded corpus; no live account, repeated rows or synthetic list padding. */
import { z } from "zod";

import { createServerFactory } from "../src/server.js";
import { testConfig } from "../test/helpers/config.js";
import { connectFactory } from "../test/helpers/connect.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../test/helpers/fake-client.js";

// These ids are also the publisher's fixed row vocabulary. Keep that allowlist in sync.
export const RESPONSE_CALLS = {
  invoice_get: { name: "sevdesk_invoice_get", arguments: { id: 138793718 } },
  records_summarize: {
    name: "sevdesk_records_summarize",
    arguments: { subject: "invoices", groupBy: "month" },
  },
  contacts_search: { name: "sevdesk_contacts_search", arguments: {} },
  transactions_list: { name: "sevdesk_transactions_list", arguments: {} },
  vouchers_list: { name: "sevdesk_vouchers_list", arguments: {} },
  invoices_list: { name: "sevdesk_invoices_list", arguments: {} },
  invoices_list_max: { name: "sevdesk_invoices_list", arguments: { limit: 5 } },
} as const;

const collection = z.object({ objects: z.array(z.json()) });
const recorded = (path: string, file: string): FakeRoute => ({
  path,
  // Captures are single pages with upstream totals larger than the recorded data. Discard
  // those totals so FakeSevdeskClient pages exactly the available rows and reports terminate.
  response: { body: collection.parse(loadFixture(`recorded/${file}.json`).body) },
});

/** Uses the actual legacy SDK text blocks, including summaries and untrusted-data fences. */
export async function captureResponses(): Promise<Record<keyof typeof RESPONSE_CALLS, string>> {
  const fake = new FakeSevdeskClient([
    recorded("/Invoice/138793718", "2026-11-07/invoices/invoice-by-id"),
    recorded("/InvoicePos", "2026-11-07/invoices/invoice-positions"),
    recorded("/Unity", "2026-11-07/meta/units"),
    recorded("/StaticCountry", "2026-11-07/meta/static-countries"),
    recorded("/Invoice", "2026-11-07/invoices/invoices-list"),
    recorded("/Contact", "2026-11-07/contacts/contacts-list"),
    recorded("/Voucher", "2026-11-08/vouchers/vouchers-list"),
    recorded("/CheckAccountTransaction", "2026-11-07/banking/transactions-list"),
    recorded("/CheckAccount", "2026-11-07/banking/check-accounts"),
  ]);
  const factory = createServerFactory({ config: testConfig(), client: fake });
  const now = Date.now;
  // The harness runs serially; restore the clock even on errors. Due/overdue fields must
  // describe the recording day, not whichever day a PR happens to run.
  Date.now = () => Date.parse("2026-11-13T12:00:00Z");
  try {
    const client = await connectFactory(factory, { era: "legacy" });
    try {
      const responses = {} as Record<keyof typeof RESPONSE_CALLS, string>;
      for (const id of Object.keys(RESPONSE_CALLS) as (keyof typeof RESPONSE_CALLS)[]) {
        const result = await client.callTool(RESPONSE_CALLS[id]);
        if (result.isError || result.content.some((block) => block.type !== "text")) {
          throw new Error(`Response capture failed: ${id}`);
        }
        responses[id] = result.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        if (!responses[id] || result.structuredContent !== undefined) {
          throw new Error(`Expected legacy text response: ${id}`);
        }
      }
      if (fake.writes().length > 0) throw new Error("Response capture attempted a write.");
      return responses;
    } finally {
      await client.close();
    }
  } finally {
    Date.now = now;
    await factory.close();
  }
}
