/**
 * Live read-only checks (`pnpm test:live`): every read tool, called with minimal arguments against
 * the account behind SEVDESK_API_TOKEN, must answer without `isError` and with output that
 * matches its schema. Nothing is written to sevDesk: the stack runs with SEVDESK_READ_ONLY=1, so
 * the HTTP client refuses any data-changing request before sending it. PDFs are only fetched for
 * documents that are no longer drafts, and the test checks that a preview left their status alone
 * (B1). The file tools get temporary folders (SEVDESK_FILE_DIRS with a generated Factur-X PDF,
 * SEVDESK_OUTPUT_DIR), removed afterwards. Arguments live in `cases.ts`.
 *
 * Without a token the whole file is skipped with the reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  berlinToday,
  readOnlyEnv,
  runTag,
  tokenMissingReason,
} from "../../scripts/lib/live-env.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { type Ids, type LocalFiles, prepareLocalFiles, READ_CASES } from "./cases.js";
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
const CASES = READ_CASES;

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
  let files: (LocalFiles & { cleanup(): Promise<void> }) | undefined;

  beforeAll(async () => {
    files = await prepareLocalFiles(runTag(), berlinToday());
    stack = await connectLive({
      ...readOnlyEnv(process.env),
      SEVDESK_FILE_DIRS: files.fileDir,
      SEVDESK_OUTPUT_DIR: files.outputDir,
    });
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
      transaction: first(await callOk(stack.mcp, "sevdesk_transactions_list", {})),
    });
  }, 120_000);

  afterAll(async () => {
    await stack.close();
    await files?.cleanup();
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
      if (!listed.some((tool) => tool.name === item.tool)) {
        ctx.skip(`${item.tool} is not offered (not shipped yet, or its folder is not configured)`);
      }
      if (files === undefined) throw new Error("The local folders were not prepared.");
      const args = item.args(ids, files);
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
