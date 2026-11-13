/** Deterministic recorded-row expansion for full default and 100-item pages; no live account. */
import { z } from "zod";

import { createServerFactory } from "../src/server.js";
import type { AnyToolDefinition } from "../src/tools/types.js";
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
  invoices_list_max: { name: "sevdesk_invoices_list", arguments: { limit: 100 } },
} as const;

const collection = z.object({ objects: z.array(z.json()) });
const row = z.object({ id: z.string().regex(/^\d+$/) }).catchall(z.json());

/** Repeat recorded shapes, preserving the first page and assigning distinct fixed-width ids. */
export function expandRecordedRows(rows: readonly unknown[], size: number): unknown[] {
  if (rows.length === 0 || !Number.isSafeInteger(size) || size < rows.length || size > 100) {
    throw new Error("Invalid recorded corpus size.");
  }
  const parsed = rows.map((value) => row.parse(value));
  const maximum = Math.max(...parsed.map((value) => Number(value.id)));
  return Array.from({ length: size }, (_, index) => {
    const original = structuredClone(parsed[index % parsed.length]!);
    return { ...original, id: index < parsed.length ? original.id : String(maximum + index + 1) };
  });
}

const recorded = (path: string, file: string, size?: number): FakeRoute => {
  const body = collection.parse(loadFixture(`recorded/${file}.json`).body);
  return {
    path,
    // Captures are single pages with upstream totals larger than the recorded data. Discard
    // those totals so FakeSevdeskClient pages exactly the available rows and reports terminate.
    response: {
      body: { objects: size === undefined ? body.objects : expandRecordedRows(body.objects, size) },
    },
  };
};

/** Uses the actual legacy SDK text blocks, including summaries and untrusted-data fences. */
export async function captureResponses(
  tools?: readonly AnyToolDefinition[],
): Promise<Partial<Record<keyof typeof RESPONSE_CALLS, string>>> {
  const fake = new FakeSevdeskClient([
    recorded("/Invoice/138793718", "2026-11-07/invoices/invoice-by-id"),
    recorded("/InvoicePos", "2026-11-07/invoices/invoice-positions"),
    recorded("/Unity", "2026-11-07/meta/units"),
    recorded("/StaticCountry", "2026-11-07/meta/static-countries"),
    recorded("/Invoice", "2026-11-07/invoices/invoices-list", 100),
    recorded("/Contact", "2026-11-07/contacts/contacts-list", 100),
    recorded("/Voucher", "2026-11-08/vouchers/vouchers-list", 100),
    recorded("/CheckAccountTransaction", "2026-11-07/banking/transactions-list", 100),
    recorded("/CheckAccount", "2026-11-07/banking/check-accounts"),
  ]);
  const factory = createServerFactory({
    config: testConfig(),
    client: fake,
    ...(tools === undefined ? {} : { tools }),
  });
  const now = Date.now;
  // The harness runs serially; restore the clock even on errors. Due/overdue fields must
  // describe the fixed reference day, not whichever day a PR happens to run.
  Date.now = () => Date.parse("2026-11-13T12:00:00Z");
  try {
    const client = await connectFactory(factory, { era: "legacy" });
    try {
      const responses: Partial<Record<keyof typeof RESPONSE_CALLS, string>> = {};
      for (const id of Object.keys(RESPONSE_CALLS) as (keyof typeof RESPONSE_CALLS)[]) {
        try {
          const result = await client.callTool(RESPONSE_CALLS[id]);
          if (
            result.isError ||
            result.structuredContent !== undefined ||
            result.content.some((block) => block.type !== "text")
          )
            continue;
          const text = result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
          if (text) responses[id] = text;
        } catch {
          // Removed tools, changed inputs and missing fixture routes are expected during PR
          // comparisons. Keep other calls and the compatibility diff; never count error text.
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
