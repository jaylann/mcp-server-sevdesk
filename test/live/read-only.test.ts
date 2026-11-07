/**
 * Live read-only checks (`pnpm test:live`): every read tool, called with minimal arguments against
 * the account behind SEVDESK_API_TOKEN, must answer without `isError` and with output that
 * matches its schema. Nothing is written: the stack runs with SEVDESK_READ_ONLY=1, so the HTTP
 * client refuses any data-changing request before sending it. PDFs are only fetched for documents
 * that are no longer drafts, and the test checks that a preview left their status alone (B1).
 *
 * Without a token the whole file is skipped with the reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readOnlyEnv, tokenMissingReason } from "../../scripts/lib/live-env.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import {
  callOk,
  callTool,
  connectLive,
  expectValidOutput,
  itemsOf,
  type LiveStack,
  statusCode,
} from "./live-stack.js";

const skipReason = tokenMissingReason(process.env);

/** Ids the by-id tools need, learned from the list tools. */
interface Ids {
  contact?: number;
  invoice?: number;
  invoiceFinal?: number;
  creditNote?: number;
  creditNoteFinal?: number;
  order?: number;
  orderFinal?: number;
  voucher?: number;
  part?: number;
}

type Args = Readonly<Record<string, unknown>>;

interface LiveCase {
  readonly tool: string;
  /** Arguments; `undefined` when the account lacks the record the call needs. */
  readonly args: (ids: Ids) => Args | undefined;
  /** A refusal that is a valid answer (e.g. getXml for an invoice that is not an e-invoice). */
  readonly acceptError?: RegExp;
  readonly label?: string;
}

const SINCE = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const byId = (key: keyof Ids) => (ids: Ids) =>
  ids[key] === undefined ? undefined : { id: ids[key] };

const CASES: readonly LiveCase[] = [
  { tool: "sevdesk_account_info", args: () => ({}) },
  { tool: "sevdesk_contacts_search", args: () => ({}) },
  { tool: "sevdesk_contact_get", args: byId("contact") },
  { tool: "sevdesk_contacts_next_customer_number", args: () => ({}) },
  { tool: "sevdesk_invoices_list", args: () => ({}) },
  { tool: "sevdesk_invoice_get", args: byId("invoice") },
  { tool: "sevdesk_invoice_pdf", args: byId("invoiceFinal") },
  {
    tool: "sevdesk_invoice_xml",
    args: byId("invoiceFinal"),
    acceptError: /e-invoice|E-Rechnung|XML/i,
  },
  { tool: "sevdesk_credit_notes_list", args: () => ({}) },
  { tool: "sevdesk_credit_note_get", args: byId("creditNote") },
  { tool: "sevdesk_credit_note_pdf", args: byId("creditNoteFinal") },
  { tool: "sevdesk_orders_list", args: () => ({}) },
  { tool: "sevdesk_order_get", args: byId("order") },
  { tool: "sevdesk_order_pdf", args: byId("orderFinal") },
  { tool: "sevdesk_vouchers_list", args: () => ({}) },
  { tool: "sevdesk_voucher_get", args: byId("voucher") },
  { tool: "sevdesk_bank_accounts_list", args: () => ({}) },
  { tool: "sevdesk_transactions_list", args: () => ({}) },
  { tool: "sevdesk_parts_list", args: () => ({}) },
  { tool: "sevdesk_part_get", args: byId("part") },
  { tool: "sevdesk_cash_position", args: () => ({}) },
  { tool: "sevdesk_changed_since", args: () => ({ since: SINCE }) },
  { tool: "sevdesk_payables_aging", args: () => ({}) },
  { tool: "sevdesk_receivables_aging", args: () => ({}) },
  ...(["invoices", "credit_notes", "vouchers", "transactions"] as const).map((subject) => ({
    tool: "sevdesk_records_summarize",
    label: `sevdesk_records_summarize (${subject})`,
    args: () => ({ subject }),
  })),
];

/** The status of a document before and after its PDF preview (B1 against the real API). */
const PDF_SOURCES: Readonly<
  Record<string, { readonly get: string; readonly key: string; readonly id: keyof Ids }>
> = {
  sevdesk_invoice_pdf: { get: "sevdesk_invoice_get", key: "invoice", id: "invoiceFinal" },
  sevdesk_credit_note_pdf: {
    get: "sevdesk_credit_note_get",
    key: "creditNote",
    id: "creditNoteFinal",
  },
  sevdesk_order_pdf: { get: "sevdesk_order_get", key: "order", id: "orderFinal" },
};

describe.skipIf(skipReason !== undefined)("live: read tools against the real account", () => {
  let stack: LiveStack;
  let listed: {
    name: string;
    inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  }[] = [];
  const ids: Ids = {};

  beforeAll(async () => {
    stack = await connectLive(readOnlyEnv(process.env));
    listed = (await stack.mcp.listTools()).tools as typeof listed;

    const first = (data: unknown, final = false): number | undefined => {
      const row = itemsOf(data).find((item) => !final || statusCode(item) !== 100);
      return typeof row?.["id"] === "number" ? row["id"] : undefined;
    };
    const contacts = await callOk(stack.mcp, "sevdesk_contacts_search", {});
    const invoices = await callOk(stack.mcp, "sevdesk_invoices_list", {});
    const creditNotes = await callOk(stack.mcp, "sevdesk_credit_notes_list", {});
    const orders = await callOk(stack.mcp, "sevdesk_orders_list", {});
    Object.assign(ids, {
      contact: first(contacts),
      invoice: first(invoices),
      invoiceFinal: first(invoices, true),
      creditNote: first(creditNotes),
      creditNoteFinal: first(creditNotes, true),
      order: first(orders),
      orderFinal: first(orders, true),
      voucher: first(await callOk(stack.mcp, "sevdesk_vouchers_list", {})),
      part: first(await callOk(stack.mcp, "sevdesk_parts_list", {})),
    });
  }, 120_000);

  afterAll(async () => {
    await stack.close();
  });

  it("is read-only: the server lists read tools only and refuses writes in the client", () => {
    expect(stack.config.readOnly).toBe(true);
    expect([...stack.config.allowedTiers]).toEqual(["read"]);
    for (const tool of listed) {
      expect(ALL_TOOLS.find((shipped) => shipped.name === tool.name)?.tier, tool.name).toBe("read");
    }
  });

  it("has a live case for every listed read tool", () => {
    const covered = new Set([...CASES.map((item) => item.tool), "sevdesk_reference_lookup"]);
    expect(listed.map((tool) => tool.name).filter((name) => !covered.has(name))).toEqual([]);
  });

  it("answers every reference lookup kind", async () => {
    const kinds =
      listed.find((tool) => tool.name === "sevdesk_reference_lookup")?.inputSchema.properties?.[
        "kind"
      ]?.enum ?? [];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const data = await callOk(stack.mcp, "sevdesk_reference_lookup", { kind });
      expectValidOutput("sevdesk_reference_lookup", data);
    }
  }, 120_000);

  /** Status and send state of the document a PDF tool previews. */
  async function sendStateOf(source: (typeof PDF_SOURCES)[string]): Promise<string> {
    const data = (await callOk(stack.mcp, source.get, { id: ids[source.id] })) as Record<
      string,
      unknown
    >;
    const document = data[source.key] as Record<string, unknown> | undefined;
    return JSON.stringify({ status: statusCode(document), sent: document?.["sent"] ?? null });
  }

  it.for(CASES.map((item) => [item.label ?? item.tool, item] as const))(
    "%s answers without isError and with schema-valid output",
    async ([, item], ctx) => {
      const args = item.args(ids);
      if (args === undefined) ctx.skip("the account has no record this call needs");
      const source = PDF_SOURCES[item.tool];
      const before = source === undefined ? undefined : await sendStateOf(source);

      const call = await callTool(stack.mcp, item.tool, args);
      if (call.isError && item.acceptError?.test(call.text) === true) return;
      expect(call.isError, `${item.tool}: ${call.text}`).toBe(false);
      expectValidOutput(item.tool, call.data);

      if (source !== undefined) {
        expect(await sendStateOf(source), `${item.tool} changed the document (B1)`).toBe(before);
      }
    },
  );
});

if (skipReason !== undefined) {
  it.skip(`live read-only checks skipped: ${skipReason}`, () => undefined);
}
