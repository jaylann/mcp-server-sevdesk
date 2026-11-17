/**
 * The reads `pnpm fixtures:record` took on the trial account on 2026-11-16 (Update 2.0) for the
 * competitor-gap issues on documents (#89, #91, #94), next to the probe runs of that day
 * (`scripts/lib/probes/gaps-documents-probes.ts`, spec/deviations.md D-107–D-116).
 *
 * The recurring templates run through the production invoice parser. No production code reads
 * the letterpaper list or order discounts yet, so their recorded shapes are pinned here and fed
 * to the probes that described them, as `undocumented-endpoints.test.ts` does for D-024; the
 * slices that add tools for them replace these checks with their parsers.
 *
 * Not recorded: `GET /DocServer/getTemplatesWithThumb` (3.2 MB even scrubbed; D-114 describes
 * it) and `GET /Order` (an older session holds the order list).
 */
import { describe, expect, it } from "vitest";

import { GAPS_DOCUMENTS_PROBES } from "../../scripts/lib/probes/gaps-documents-probes.js";
import { runProbes } from "../../scripts/lib/probes/runner.js";
import { createScrubber, FAKE_PDF_BASE64 } from "../../scripts/lib/scrub.js";
import { mapInvoiceDetail } from "../../src/domain/invoices.js";
import { TEST_TOKEN } from "../helpers/config.js";
import { loadFixture } from "../helpers/fake-client.js";
import { ScriptedClient, type ScriptedHandler } from "../unit/scripts/scripted-client.js";

/** Every recorded file of this session that this test covers (below `test/fixtures/`). */
const COVERED_FILES = [
  "recorded/2026-11-16/invoices/recurring-templates.json",
  "recorded/2026-11-16/layouts/letterpapers.json",
  "recorded/2026-11-16/orders/order-discounts.json",
] as const;

type Row = Record<string, unknown>;

function body(file: (typeof COVERED_FILES)[number]): Row {
  return loadFixture(file).body as Row;
}

function rows(file: (typeof COVERED_FILES)[number]): Row[] {
  return body(file)["objects"] as Row[];
}

/** Runs one probe of the module read-only against a handler (plus the version GET). */
async function probe(id: string, handler: ScriptedHandler) {
  const client = new ScriptedClient((call) =>
    call.path === "/Tools/bookkeepingSystemVersion"
      ? { objects: { version: "2.0" } }
      : handler(call),
  );
  const report = await runProbes({
    client,
    scrubber: createScrubber({ secrets: [TEST_TOKEN] }),
    probes: GAPS_DOCUMENTS_PROBES,
    allowWrites: false,
    tag: "MCP-E2E 20261116-2300-abcd",
    today: "2026-11-16",
    nowSeconds: 1_794_870_000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    only: [id],
  });
  expect(client.calls.every((call) => call.method === "GET")).toBe(true);
  return report.results[0];
}

describe("recorded 2026-11-16: provenance", () => {
  it.each(COVERED_FILES)("%s is a scrubbed recording of a GET on Update 2.0", (file) => {
    const { _provenance: provenance, status } = loadFixture(file);
    expect(provenance).toMatchObject({
      source: "recorded",
      date: "2026-11-16",
      systemVersion: "2.0",
    });
    expect(provenance.ref).toMatch(/^GET \//);
    expect(status).toBe(200);
  });
});

describe("GET /Invoice?showWkr=all: recurring templates (D-111, D-112, D-049)", () => {
  const file = "recorded/2026-11-16/invoices/recurring-templates.json";

  it("lists only templates, active ones (status 200) included, with total and paging", () => {
    const templates = rows(file);
    expect(templates.length).toBeGreaterThan(0);
    expect(body(file)["total"]).toBeGreaterThanOrEqual(templates.length);
    expect(new Set(templates.map((row) => row["invoiceType"]))).toEqual(new Set(["WKR"]));
    expect(templates.map((row) => row["status"])).toEqual(expect.arrayContaining(["100", "200"]));
  });

  it("carries the schedule fields the parser does not read yet (D-111)", () => {
    for (const row of rows(file)) {
      for (const key of [
        "accountIntervall",
        "accountNextInvoice",
        "accountStartDate",
        "accountEndDate",
        "accountLastInvoice",
      ]) {
        expect(Object.hasOwn(row, key), key).toBe(true);
      }
      // No recurring* field of the voucher model (issue #91 named them).
      expect(Object.keys(row).filter((key) => key.startsWith("recurring"))).toEqual([]);
      // sevDesk sets the next run to the start date; a template without a start has neither.
      expect(row["accountNextInvoice"]).toEqual(row["accountStartDate"]);
    }
  });

  it("reads through the invoice parser: interval as sent, next run as a Berlin date", () => {
    const parsed = rows(file).map((row) => ({ row, detail: mapInvoiceDetail(row, "2026-11-16") }));
    for (const { row, detail } of parsed) {
      expect(detail.type.code).toBe("WKR");
      expect(detail.recurring?.interval).toBe(row["accountIntervall"] ?? undefined);
      const next = row["accountNextInvoice"];
      expect(detail.recurring?.nextInvoice).toBe(
        typeof next === "string" ? next.slice(0, 10) : undefined,
      );
    }
    // Any interval string is stored as sent, also ones that are no ISO-8601 duration (D-111).
    expect(parsed.map(({ detail }) => detail.recurring?.interval)).toEqual(
      expect.arrayContaining(["P0Y1M0W", "monthly", "1 month"]),
    );
    expect(parsed.some(({ detail }) => detail.recurring?.nextInvoice === "2026-11-15")).toBe(true);
  });

  it("is what read-recurring-generated reads: tagged templates, none in the default list", async () => {
    const templates = rows(file).map((row) => ({
      ...row,
      // The scrubber replaced the run tag in header and note; restore a tag so the probe counts them.
      customerInternalNote: "MCP-E2E 20261116-2210-skny",
    }));
    const result = await probe("read-recurring-generated", (call) => {
      if (call.path !== "/Invoice") return { total: 0, objects: [] };
      if (call.query["showWkr"] === "all") return { total: templates.length, objects: templates };
      return { total: 0, objects: [] };
    });
    expect(result?.status).toBe("observed");
    expect(result?.finding).toMatch(
      new RegExp(`^${templates.length} tagged template\\(s\\), 0 generated invoice\\(s\\) found`),
    );
    expect(result?.finding).toMatch(/accountStartDate 2026-11-15T00:00:00\+01:00/);
    expect(result?.finding).not.toMatch(/in the default list: true/);
  });
});

describe("GET /DocServer/getLetterpapersWithThumb (D-114)", () => {
  const file = "recorded/2026-11-16/layouts/letterpapers.json";

  it("answers result and letterpapers under objects, with the thumbnails scrubbed", () => {
    const objects = body(file)["objects"] as Row;
    expect(Object.keys(objects)).toEqual(["result", "letterpapers"]);
    expect(objects["result"]).toBe(1);
    const list = objects["letterpapers"] as Row[];
    expect(list).toHaveLength(1);
    const [row] = list;
    expect(Object.keys(row ?? {})).toEqual([
      "id",
      "pdf",
      "sevClient",
      "name",
      "default",
      "isCustom",
      "img",
    ]);
    expect(row).toMatchObject({ sevClient: "0", isCustom: false, pdf: FAKE_PDF_BASE64 });
    expect(typeof row?.["default"]).toBe("number");
    expect(typeof row?.["id"]).toBe("string");
    // The ~86 KB base64 thumbnail became a short fake.
    expect(String(row?.["img"]).length).toBeLessThan(40);
  });

  it("is what read-docserver-layouts describes, without any base64", async () => {
    const letterpapers = body(file);
    const result = await probe("read-docserver-layouts", (call) =>
      call.path === "/DocServer/getLetterpapersWithThumb"
        ? letterpapers
        : { objects: { result: 1, templates: [] } },
    );
    expect(result?.finding).toMatch(
      /GET \/DocServer\/getLetterpapersWithThumb: application\/json, rows objects\.letterpapers, 1 row\(s\) \(0 default, 1 with sevClient "0", 0 other\); keys: id: string, pdf: string, sevClient: string, name: string, default: number, isCustom: boolean, img: string/,
    );
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });
});

describe("GET /Order/{id}/getDiscounts (D-116)", () => {
  const file = "recorded/2026-11-16/orders/order-discounts.json";

  it("answers an empty list with total null for an order without discounts", () => {
    expect(body(file)).toEqual({ objects: [], total: null });
  });

  it("makes read-order-get-discounts inconclusive, naming the empty answer", async () => {
    const answer = body(file);
    const result = await probe("read-order-get-discounts", (call) => {
      if (call.path === "/Order") {
        return { total: 1, objects: [{ id: "31710400", objectName: "Order", header: "x" }] };
      }
      return answer;
    });
    expect(result).toMatchObject({
      status: "inconclusive",
      finding: "No order of 1 has a discount: 31710400 (a list of 0).",
    });
  });
});
