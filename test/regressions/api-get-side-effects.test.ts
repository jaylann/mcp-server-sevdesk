/**
 * `sevdesk_api_get` must never change data in sevDesk, whatever path and query the model picks.
 *
 * sevDesk has GETs that change state (spec/deviations.md D-023: `getPdf` without
 * `preventSendBy` finalizes a draft, `sendByWithRender` marks a document as sent, next-number
 * endpoints reserve the number, DATEV flags enshrine irreversibly), and it accepts the API token
 * as a `?token=` query parameter. A generic GET puts the path in the model's hands, so it is
 * guarded three times, each enough on its own:
 *
 * 1. `genericGetRefusal` refuses the request before anything is sent;
 * 2. `readOnlyClient` refuses any GET `resolveGetSafety` classifies as a side effect;
 * 3. the HTTP client refuses such a GET because a read tool declares no tier.
 *
 * Every refused call here runs with every tier and toolset enabled (no read-only or dry-run
 * mode to fall back on) and must make zero `fetch` calls; the last block switches layers 1 and 2
 * off one after the other to show the remaining layers still hold.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { allEnabledConfig, TEST_TOKEN } from "../helpers/config.js";
import { connectInProcess } from "../helpers/connect.js";
import { createFakeClock, createFakeFetch, envelope } from "../helpers/fake-fetch.js";

const bypass = vi.hoisted(() => ({ refusal: false, readOnlyClient: false }));

vi.mock("../../src/sevdesk/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sevdesk/paths.js")>();
  return {
    ...actual,
    genericGetRefusal: (...args: Parameters<typeof actual.genericGetRefusal>) =>
      bypass.refusal ? undefined : actual.genericGetRefusal(...args),
  };
});

vi.mock("../../src/sevdesk/scoped-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sevdesk/scoped-client.js")>();
  return {
    ...actual,
    readOnlyClient: (...args: Parameters<typeof actual.readOnlyClient>) =>
      bypass.readOnlyClient ? args[0] : actual.readOnlyClient(...args),
  };
});

const ALL = allEnabledConfig();

/** One MCP server with every tier and toolset on, over the real client with a scripted fetch. */
const fake = createFakeFetch();
let mcp: Client;

beforeAll(async () => {
  const clock = createFakeClock();
  const client = createSevdeskClient(ALL, {
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
    monotonicNow: clock.now,
    random: () => 0.5,
  });
  mcp = await connectInProcess({ config: ALL, client });
});

afterAll(async () => {
  await mcp.close();
});

beforeEach(() => {
  bypass.refusal = false;
  bypass.readOnlyClient = false;
  fake.requests.length = 0;
});

async function call(args: Record<string, unknown>) {
  const result = await mcp.callTool({ name: "sevdesk_api_get", arguments: args });
  const content = result.content as readonly { text?: string }[];
  return { isError: result.isError === true, text: content.map((b) => b.text ?? "").join("\n") };
}

const REFUSED_PATHS = [
  "/Invoice/1/getPdf",
  "/CreditNote/1/getPdf",
  "/Order/1/getPdf",
  "/Invoice/1/getXml",
  "/Invoice/1/render",
  "/CreditNote/1/sendByWithRender",
  "/Invoice/1/getPdf/2",
  "/Invoice/1/sendBy",
  "/Invoice/1/bookAmount",
  "/Invoice/1/enshrine",
  "/Invoice/1/cancelInvoice",
  "/Invoice/1/resetToDraft",
  "/Invoice/1/resetToOpen",
  "/Invoice/1/changeParameter",
  "/Invoice/1/sendViaEmail",
  "/Order/Factory/getNextOrderNumber",
  "/CreditNote/Factory/getNextCreditNoteNumber",
  "/Contact/Factory/getNextCustomerNumber",
  "/SevSequence/Factory/getByType",
  "/Export/createDatevCsvZipExportJob",
  "/Export/createDatevXmlZipExportJob",
  "/Export/datevCSV",
  "/Export/invoiceCsv",
  "/ExportJob/jobDownloadInfo",
  "/Progress/generateDownloadHash",
  "/Report/invoicelist",
  "/DocServer/getTemplatesWithThumb",
  "/Invoice/Factory/saveInvoice",
  "/Voucher/Factory/uploadTempFile",
  "/Invoice/1/setStatus",
];

const REFUSED_QUERIES: Record<string, string | number | boolean>[] = [
  { token: TEST_TOKEN },
  { TOKEN: "0".repeat(32) },
  { "api.key": TEST_TOKEN },
  { Authorization: TEST_TOKEN },
  { name: TEST_TOKEN },
  { preventSendBy: false },
  { enshrine: true },
  { enshrineDocuments: 1 },
  { useNextNumber: true },
  { download: true },
  { limit: 1001 },
  { countAll: false },
  { method: "DELETE" },
];

describe("sevdesk_api_get: refused requests make zero fetch calls (all tiers enabled)", () => {
  it.each(REFUSED_PATHS)("%s", async (path) => {
    const result = await call({ path });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/nothing was sent/);
    expect(fake.requests).toHaveLength(0);
  });

  it.each(REFUSED_QUERIES)("query %j", async (query) => {
    const result = await call({ path: "/Invoice", query });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/nothing was sent/);
    expect(result.text).not.toContain(TEST_TOKEN);
    expect(fake.requests).toHaveLength(0);
  });

  it("an allowed read goes out once, with the token only in the header", async () => {
    fake.reply(envelope([{ id: "1" }], "1"));
    const result = await call({ path: "/TextTemplate", query: { "contact[id]": 1 } });

    expect(result.isError).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.href).not.toContain(TEST_TOKEN);
    expect(fake.requests[0]?.headers.get("authorization")).toBe(TEST_TOKEN);
  });
});

/** Side-effect GETs `resolveGetSafety` knows, as the model could phrase them. */
const SIDE_EFFECTS: [string, Record<string, string | number | boolean>?][] = [
  ["/Invoice/1/getPdf", { preventSendBy: 0 }],
  ["/Invoice/1/getPdf/2"],
  ["/CreditNote/1/sendByWithRender"],
  ["/Order/Factory/getNextOrderNumber"],
  ["/Order/Factory/getNextOrderNumber", { useNextNumber: "yes" }],
  ["/Export/createDatevCsvZipExportJob"],
  ["/Export/datevCSV", { enshrine: 1 }],
];

describe("sevdesk_api_get: the remaining guards hold when a layer misses", () => {
  it.each(SIDE_EFFECTS)(
    "readOnlyClient blocks %s %j when the refusal list misses it",
    async (path, query) => {
      bypass.refusal = true;
      const result = await call({ path, ...(query === undefined ? {} : { query }) });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(
        /changes data in sevDesk, which is not allowed while running a generic read/,
      );
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each(SIDE_EFFECTS)(
    "the HTTP client blocks %s %j when both layers above miss it",
    async (path, query) => {
      bypass.refusal = true;
      bypass.readOnlyClient = true;
      const result = await call({ path, ...(query === undefined ? {} : { query }) });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/did not declare its tier\. Nothing was sent/);
      expect(fake.requests).toHaveLength(0);
    },
  );
});
