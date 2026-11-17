/**
 * The acceptance of #94: an English invoice on a second letterhead with a 3 % discount can be
 * drafted, previewed and finalized through the server.
 *
 * One walk through MCP, against answers scripted in the recorded shapes (D-113, D-116, D-140):
 * `sevdesk_invoice_create_draft` with a 3 % discount (write tier, no question), then
 * `sevdesk_document_set_layout` with `en_US` and the second letterhead (the human approves the
 * change), then `sevdesk_invoice_finalize`, whose question shows the English language, the second
 * letterhead and the discount, before the human approves it. The scripted sevDesk keeps the layout
 * that `changeParameter` sets (an invoice stores `en` for `en_US`) and answers `render` with it,
 * and the invoice reads as finalized after `sendBy`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SevdeskClient, SevdeskRequest } from "../../src/sevdesk/types.js";
import { documentSetLayoutTool } from "../../src/tools/documents/layout-tool.js";
import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { finalizeTool } from "../../src/tools/lifecycle/finalize.js";
import { approve } from "../helpers/confirm-client.js";
import { type FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { letterpapersRoute } from "../helpers/layout-routes.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  discountRow,
  discountsRoute,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  withRoutes,
} from "../unit/tools/drafts/routes.js";
import {
  changeParameterRoute,
  layoutObjects,
  renderRoute,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

type Layout = { language: string; template: string; letterpaper: string };

/** Invoices store `en` and `de` for `en_US` and `de_DE`, every other language as sent (D-140). */
function stored(key: string, value: string): string {
  if (key !== "language") return value;
  return value === "en_US" ? "en" : value === "de_DE" ? "de" : value;
}

/**
 * sevDesk as far as this walk needs state: the layout `changeParameter` sets and `render` reads,
 * and the invoice finalized by `sendBy`. Every request still goes to `fake` first, which records
 * it and answers from the routes.
 */
function scriptedSevdesk(fake: FakeSevdeskClient): SevdeskClient {
  const layout: Layout = { language: "de", template: "tpl-standard", letterpaper: "lp-1" };
  let finalized = false;
  const draft = (loadFixture("drafts/invoice-2101.json").body as { objects: unknown[] }).objects;
  return {
    request: async (request: SevdeskRequest) => {
      const answer = await fake.request(request);
      const { method, path } = request;
      if (method === "PUT" && path === "/Invoice/2101/changeParameter") {
        const body = request.body as { key: keyof Layout; value: string };
        layout[body.key] = stored(body.key, body.value);
        return { metaData: layoutObjects(layout) };
      }
      if (method === "POST" && path === "/Invoice/2101/render") return layoutObjects(layout);
      if (method === "PUT" && path === "/Invoice/2101/sendBy") finalized = true;
      if (method === "GET" && path === "/Invoice/2101" && finalized) {
        return draft.map((row) => ({
          ...(row as Record<string, unknown>),
          status: "200",
          invoiceNumber: "RE-1101",
        }));
      }
      return answer;
    },
    list: (path, query, options) => fake.list(path, query, options),
    listAll: (path, query, options) => fake.listAll(path, query, options),
    download: (request) => fake.download(request),
  };
}

describe("#94 acceptance: an English invoice on a second letterhead with 3 % discount", () => {
  it("is drafted, previewed and finalized through the server", async () => {
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [invoiceCreateDraftTool, documentSetLayoutTool, finalizeTool("invoice")],
      routes: withRoutes(
        invoiceCreateRoutes,
        discountsRoute("Invoice", 2101, [
          discountRow("Invoice", 2101, { value: "3", text: "Treuerabatt" }),
        ]),
        renderRoute("invoice"),
        letterpapersRoute(),
        changeParameterRoute("/Invoice/2101/changeParameter", "invoice", {}),
        writeRoute("PUT", "/Invoice/2101/sendBy", "invoice-send-by.json"),
      ),
      wrap: scriptedSevdesk,
      connect: { era: "modern", transport: "http", answer: approve },
    });

    // 1. The draft with a 3 % discount on the whole invoice: write tier, nobody is asked.
    const drafted = await mcp.callTool({
      name: "sevdesk_invoice_create_draft",
      arguments: { ...invoiceCreateArgs, discount: { percent: 3, text: "Treuerabatt" } },
    });
    expect(resultData(drafted)).toMatchObject({
      status: "done",
      result: { invoice: { id: 2101 } },
    });
    expect(prompts).toHaveLength(0);

    // 2. English, on the second letterhead: the human approves the change of the layout.
    const laidOut = await mcp.callTool({
      name: "sevdesk_document_set_layout",
      arguments: {
        kind: "invoice",
        id: 2101,
        language: "en_US",
        letterpaper: "Zweites Briefpapier",
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.message).toContain(
      "Language (Sprache): German (Germany), de_DE → English (USA), en_US",
    );
    expect(prompts[0]?.message).toContain(
      "Letterhead (Briefpapier): Briefpapier 1 (id lp-1) → Zweites Briefpapier (id lp-2)",
    );
    expect(resultData(laidOut)).toMatchObject({
      status: "done",
      result: {
        applied: ["language", "letterpaper"],
        layout: {
          language: { code: "en_US", value: "en" },
          letterpaper: { id: "lp-2", name: "Zweites Briefpapier" },
        },
      },
    });

    // 3. The finalize question shows what becomes binding: English, the second letterhead and
    // the discount; then the human approves it.
    const finalized = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 2101 },
    });
    expect(prompts).toHaveLength(2);
    const question = prompts[1]?.message ?? "";
    expect(question).toContain("Finalize invoice 2101");
    expect(question).toContain("Language (Sprache): English (USA), en_US");
    expect(question).toContain("Letterhead (Briefpapier): Zweites Briefpapier (id lp-2)");
    expect(question).toContain("Discount on the whole document (Rabatt):\n  3 % of the net total");
    expect(resultData(finalized)).toMatchObject({
      status: "done",
      result: { invoice: { id: 2101, status: { code: 200 } } },
    });

    expect(writesOf(fake)).toEqual([
      { method: "POST", path: "/Invoice/Factory/saveInvoice" },
      { method: "PUT", path: "/Invoice/2101/changeParameter" },
      { method: "PUT", path: "/Invoice/2101/changeParameter" },
      { method: "PUT", path: "/Invoice/2101/sendBy" },
    ]);
    const saved = fake.writes()[0]?.body as { discountSave?: unknown };
    expect(saved.discountSave).toEqual([
      expect.objectContaining({ percentage: true, value: 3, text: "Treuerabatt" }),
    ]);
    expect(
      fake
        .writes()
        .slice(1, 3)
        .map((call) => call.body),
    ).toEqual([
      { key: "language", value: "en_US" },
      { key: "letterpaper", value: "lp-2" },
    ]);
  });
});
