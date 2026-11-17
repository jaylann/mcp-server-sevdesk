/**
 * Read answers recorded on the trial account on 2026-11-16 (Update 2.0) for issues #86 and #87:
 * tags, tag relations, cost centres and custom contact field settings (spec/deviations.md D-086,
 * D-088, D-091). No production parser reads them yet, so, like
 * `test/contract/undocumented-endpoints.test.ts`, each file is pinned three ways: its recorded
 * keys and scalar types, a read through `sevdesk_api_get` (the only tool that reaches these
 * endpoints today), and a run of the probe that asked the question. The tools #86 and #87 add must
 * parse these files with their own schemas and extend this test.
 *
 * Not committed: `contacts/custom-fields.json` (`GET /ContactCustomField`). The recording answered
 * an empty list (the probe had deleted its values), which pins no row shape; the value rows are in
 * D-086 from the probe's write evidence.
 */
import { describe, expect, it } from "vitest";

import { GAPS_CONTACTS_PROBES } from "../../scripts/lib/probes/gaps-contacts-probes.js";
import { runProbes } from "../../scripts/lib/probes/runner.js";
import { createScrubber } from "../../scripts/lib/scrub.js";
import { apiGet } from "../../src/domain/api-get.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { apiGetTool } from "../../src/tools/advanced/api-get.js";
import { TEST_TOKEN } from "../helpers/config.js";
import { loadFixture } from "../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, jsonResponse } from "../helpers/fake-fetch.js";
import { ScriptedClient, type ScriptedHandler } from "../unit/scripts/scripted-client.js";

/** Every recorded file of this branch below `test/fixtures/recorded/2026-11-16/`. */
const RECORDED_GAPS_CONTACTS = [
  {
    file: "recorded/2026-11-16/tags/tags-list.json",
    path: "/Tag",
    objectName: "Tag",
    keys: [
      "id",
      "objectName",
      "additionalInformation",
      "create",
      "name",
      "objectType",
      "sevClient",
    ],
    references: [],
  },
  {
    file: "recorded/2026-11-16/tags/tag-relations.json",
    path: "/TagRelation",
    objectName: "TagRelation",
    keys: ["id", "objectName", "additionalInformation", "create", "tag", "object", "sevClient"],
    references: ["tag", "object"],
  },
  {
    file: "recorded/2026-11-16/cost-centres/cost-centres-list.json",
    path: "/CostCentre",
    objectName: "CostCentre",
    keys: [
      "id",
      "objectName",
      "additionalInformation",
      "create",
      "update",
      "sevClient",
      "number",
      "name",
      "color",
      "postingAccount",
      "defaultCentre",
    ],
    references: [],
  },
  {
    file: "recorded/2026-11-16/contacts/custom-field-settings.json",
    path: "/ContactCustomFieldSetting",
    objectName: "ContactCustomFieldSetting",
    keys: [
      "id",
      "objectName",
      "additionalInformation",
      "create",
      "update",
      "sevClient",
      "name",
      "identifier",
      "description",
      "placeholder",
    ],
    references: [],
  },
] as const;

type Row = Record<string, unknown>;

interface Body {
  readonly objects: Row[];
  readonly total?: number;
}

function bodyOf(file: string): Body {
  return loadFixture(file).body as Body;
}

function realClient(...replies: Response[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: TEST_TOKEN,
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read"]),
      readOnly: true,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, fake };
}

async function runProbe(probe: string, handler: ScriptedHandler) {
  const client = new ScriptedClient((call) =>
    call.path === "/Tools/bookkeepingSystemVersion"
      ? { objects: { version: "2.0" } }
      : handler(call),
  );
  const report = await runProbes({
    client,
    scrubber: createScrubber({ secrets: [TEST_TOKEN] }),
    probes: GAPS_CONTACTS_PROBES,
    allowWrites: false,
    tag: "MCP-E2E 20261116-2200-abcd",
    today: "2026-11-16",
    nowSeconds: 1_794_870_000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    only: [probe],
  });
  return { result: report.results[0], client };
}

/**
 * Serves a recorded list with paging and the `name` filter (honoured on the trial, D-088), its
 * first row by id, and an empty list elsewhere.
 */
function serving(lists: Readonly<Record<string, Body>>): ScriptedHandler {
  return (call) => {
    const body = lists[call.path];
    if (body !== undefined) {
      const rows =
        call.query["name"] === undefined
          ? body.objects
          : body.objects.filter((row) => row["name"] === call.query["name"]);
      const offset = Number(call.query["offset"] ?? 0);
      const limit = Number(call.query["limit"] ?? 100);
      const total = call.query["name"] === undefined ? body.total : rows.length;
      return { total, objects: rows.slice(offset, offset + limit) };
    }
    const parent = Object.keys(lists).find((path) => call.path.startsWith(`${path}/`));
    if (parent !== undefined) return { objects: lists[parent]?.objects.slice(0, 1) ?? [] };
    return { total: 0, objects: [] };
  };
}

describe.each(RECORDED_GAPS_CONTACTS)("$path (recorded 2026-11-16)", (entry) => {
  it("is a scrubbed recording of the GET it names", () => {
    const { _provenance: provenance } = loadFixture(entry.file);
    expect(provenance).toMatchObject({
      source: "recorded",
      date: "2026-11-16",
      systemVersion: "2.0",
    });
    expect(provenance.ref).toMatch(new RegExp(`^GET ${entry.path}\\?`));
  });

  it("has the recorded keys, string scalars, {id, objectName} references and a numeric total", () => {
    const body = bodyOf(entry.file);
    expect(typeof body.total).toBe("number");
    expect(body.objects.length).toBeGreaterThan(0);
    for (const row of body.objects) {
      expect(Object.keys(row)).toEqual(entry.keys);
      expect(row["objectName"]).toBe(entry.objectName);
      expect(row["id"]).toMatch(/^\d+$/);
      expect(row["sevClient"]).toEqual({ id: "9001", objectName: "SevClient" });
      for (const key of entry.references) {
        const ref = row[key] as Row;
        expect(Object.keys(ref), key).toEqual(["id", "objectName"]);
        expect(ref["id"], key).toMatch(/^\d+$/);
      }
    }
  });

  it("reads through sevdesk_api_get in read-only mode: one GET, cleaned, valid output", async () => {
    const body = bodyOf(entry.file);
    const { client, fake } = realClient(jsonResponse(body));
    const read = await apiGet(
      client,
      { path: entry.path, limit: 100, offset: 0 },
      { secrets: [TEST_TOKEN] },
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.pathname).toBe(`/api/v1${entry.path}`);
    expect(apiGetTool.output.parse(read.result)).toEqual(read.result);
    expect(read.result).toMatchObject({ path: entry.path, total: body.total });
    expect(JSON.stringify(read.result)).not.toContain("SevClient");
  });
});

describe("recorded values the tools will rely on", () => {
  it("tags carry no usage count; objectType is null (D-088)", () => {
    for (const row of bodyOf("recorded/2026-11-16/tags/tags-list.json").objects) {
      expect(row["objectType"]).toBeNull();
      expect(Object.keys(row).some((key) => /count|usage/i.test(key))).toBe(false);
    }
  });

  it("tag relations point at invoices, orders, credit notes or vouchers (D-088)", () => {
    const kinds = new Set(
      bodyOf("recorded/2026-11-16/tags/tag-relations.json").objects.map(
        (row) => (row["object"] as Row)["objectName"],
      ),
    );
    for (const kind of kinds) expect(["Invoice", "Order", "CreditNote", "Voucher"]).toContain(kind);
  });

  it("cost centres have a short number, a 0/1 defaultCentre string and null color and account (D-091)", () => {
    for (const row of bodyOf("recorded/2026-11-16/cost-centres/cost-centres-list.json").objects) {
      expect(row["number"]).toMatch(/^[a-zA-Z0-9 äöüßÄÖÜ]{1,8}$/u);
      expect(row["defaultCentre"]).toMatch(/^[01]$/);
      expect(row["color"]).toBeNull();
      expect(row["postingAccount"]).toBeNull();
    }
  });

  it("a custom field setting has an identifier and a placeholder the spec does not name (D-086)", () => {
    const [row] = bodyOf("recorded/2026-11-16/contacts/custom-field-settings.json").objects;
    expect(typeof row?.["identifier"]).toBe("string");
    expect(typeof row?.["placeholder"]).toBe("string");
    expect(row?.["description"]).toBeNull();
  });
});

describe("the probes on the recorded answers", () => {
  it("read-tag-lists describes the recorded tags and relations by keys and counts", async () => {
    const tags = bodyOf("recorded/2026-11-16/tags/tags-list.json");
    const relations = bodyOf("recorded/2026-11-16/tags/tag-relations.json");
    const { result, client } = await runProbe(
      "read-tag-lists",
      serving({ "/Tag": tags, "/TagRelation": relations }),
    );
    expect(client.calls.every((call) => call.method === "GET")).toBe(true);
    expect(result?.status).toBe("observed");
    expect(result?.finding).toContain(
      `GET /Tag: ${tags.objects.length} row(s), total ${tags.total ?? ""}, keys ${RECORDED_GAPS_CONTACTS[0].keys.join(", ")}`,
    );
    expect(result?.finding).toMatch(/name filter: 1 row\(s\), 1 with that name \(honoured\)/);
    expect(result?.finding).toMatch(/objects CreditNote 4, Order 1; limit=1: 1 row\(s\)\./);
    expect(result?.finding).not.toMatch(/Mustertag/);
  });

  it("read-cost-centre-list describes the recorded cost centres and their paging", async () => {
    const centres = bodyOf("recorded/2026-11-16/cost-centres/cost-centres-list.json");
    const { result } = await runProbe("read-cost-centre-list", serving({ "/CostCentre": centres }));
    expect(result?.status).toBe("observed");
    expect(result?.finding).toContain(
      `GET /CostCentre: 3 row(s), total 3, keys ${RECORDED_GAPS_CONTACTS[2].keys.join(", ")}`,
    );
    expect(result?.finding).toMatch(/offset=1: row 344962 \(the second of the full list: true\)/);
    expect(result?.finding).not.toMatch(/Mustername|M62573/);
  });
});
