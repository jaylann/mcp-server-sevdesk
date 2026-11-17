/**
 * The layout tool's PDF preview never sends a document (B1, D-023, D-113).
 *
 * sevDesk takes a layout change on an order or credit-note draft only after a PDF preview, and
 * `getPdf` without `preventSendBy` marks the document as sent: a draft invoice or credit note is
 * finalized, an order committed. `sevdesk_document_set_layout` fetches that preview itself, as a
 * commit tool whose client may send what a commit tool may send. This test drives the tool
 * through the real HTTP client (a scripted `fetch`, every tier enabled, so nothing but the
 * request's own shape keeps it a preview) and checks every URL that went out: each `getPdf`
 * carries the literal `preventSendBy=true`, the layout is read with `render` and
 * `{forceReload: false}` only, and nothing is sent twice.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { documentSetLayoutTool } from "../../src/tools/documents/layout-tool.js";
import { testConfig } from "../helpers/config.js";
import { loadFixture } from "../helpers/fake-client.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
} from "../helpers/fake-fetch.js";
import { executeWrite } from "../helpers/write-tools.js";
import { creditNoteRow, layoutObjects, orderRow } from "../unit/tools/lifecycle/helpers.js";

const EVERY_TIER = testConfig({
  allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
});

/** Answers each request by its path, so the test does not depend on their order. */
function router(row: Record<string, unknown>, pdfFixture: string): FakeReply {
  return (request) => {
    const path = request.url.pathname.replace("/api/v1", "");
    if (path.endsWith("/render")) return envelope(layoutObjects({}, "order"));
    if (path.endsWith("/getPdf")) {
      return envelope((loadFixture(pdfFixture).body as { objects: unknown }).objects);
    }
    if (path.endsWith("/changeParameter")) {
      return envelope({ result: 1, metaData: layoutObjects({ language: "en_US" }, "order") });
    }
    if (path === "/StaticCountry") {
      return envelope(
        (loadFixture("meta/static-countries.json").body as { objects: unknown }).objects,
      );
    }
    return envelope([row]);
  };
}

describe("B1 for the layout tool: the PDF preview it needs never sends the document", () => {
  it.each([
    ["order", "Order", orderRow({ status: "100" }), "documents/order-pdf.json"],
    [
      "credit_note",
      "CreditNote",
      creditNoteRow({ status: "100", creditNoteNumber: "GU-1101" }),
      "documents/credit-note-pdf.json",
    ],
  ] as const)(
    "%s: getPdf goes out with preventSendBy=true, once",
    async (kind, objectName, row, pdf) => {
      const id = Number(row["id"]);
      const fake = createFakeFetch(...Array.from({ length: 12 }, () => router(row, pdf)));
      const clock = createFakeClock();
      const client = createSevdeskClient(EVERY_TIER, {
        fetch: fake.fetch,
        sleep: clock.sleep,
        now: clock.now,
        monotonicNow: clock.now,
        random: () => 0.5,
      });

      const { output } = await executeWrite(
        documentSetLayoutTool,
        { kind, id, language: "en_US" },
        client,
        { allowedTiers: EVERY_TIER.allowedTiers },
      );

      expect(output.data["applied"]).toEqual(["language"]);

      const sent = fake.requests.map((request) => ({
        method: request.method,
        path: request.url.pathname.replace("/api/v1", ""),
        query: request.url.search,
        body: request.body,
      }));
      const previews = sent.filter((request) => request.path.endsWith("/getPdf"));
      expect(previews).toEqual([
        {
          method: "GET",
          path: `/${objectName}/${String(id)}/getPdf`,
          query: "?preventSendBy=true",
          body: undefined,
        },
      ]);
      for (const request of sent.filter((item) => item.path.endsWith("/render"))) {
        expect(request).toMatchObject({ method: "POST", query: "", body: '{"forceReload":false}' });
      }
      // The preview comes before the first change.
      const firstChange = sent.findIndex((request) => request.path.endsWith("/changeParameter"));
      expect(firstChange).toBeGreaterThan(
        sent.findIndex((request) => request.path.endsWith("/getPdf")),
      );
      expect(sent.some((request) => /sendBy/i.test(request.path))).toBe(false);
    },
  );
});
