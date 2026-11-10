/**
 * The undocumented endpoints `sevdesk_api_get` names as examples (spec/deviations.md D-024):
 * `GET /TextTemplate`, `/PartUnity` and `/Document`. Their fixtures in `test/fixtures/advanced/`
 * come from the community model (j-mastr/sevdesk-api). The probes `read-text-template`,
 * `read-part-unity` and `read-document` ran on the trial account on 2026-11-10; the recorded
 * answers are checked against the community model below.
 *
 * Each fixture runs through the production read (`apiGet` over the real client) and through its
 * probe, so a recorded answer that later replaces it is checked by the same contract:
 * JSON in the envelope, paging fields, nothing binary left, `sevClient` echoes removed.
 */
import { describe, expect, it } from "vitest";

import { READ_PROBES } from "../../scripts/lib/probes/read-probes.js";
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

const ENDPOINTS = [
  { path: "/TextTemplate", fixture: "advanced/text-templates.json", probe: "read-text-template" },
  { path: "/PartUnity", fixture: "advanced/part-unities.json", probe: "read-part-unity" },
  { path: "/Document", fixture: "advanced/documents.json", probe: "read-document" },
] as const;

interface Body {
  readonly objects: Record<string, unknown>[];
  readonly total?: number;
}

function bodyOf(fixture: string): Body {
  return loadFixture(fixture).body as Body;
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

describe.each(ENDPOINTS)("$path (D-024)", ({ path, fixture, probe }) => {
  it("has a community fixture that names its pending probe", () => {
    const { _provenance: provenance } = loadFixture(fixture);
    expect(provenance.source).toBe("community");
    expect(provenance.ref).toMatch(/^https:\/\/github\.com\/j-mastr\/sevdesk-api\//);
    expect(provenance.note).toContain(`probe ${probe}`);
    expect(provenance.note).toContain("D-024");
    expect(READ_PROBES.find((candidate) => candidate.id === probe)?.deviations).toEqual(["D-024"]);
  });

  it("reads through sevdesk_api_get in read-only mode: one GET, cleaned, valid output", async () => {
    const body = bodyOf(fixture);
    const { client, fake } = realClient(jsonResponse(body));
    const read = await apiGet(client, { path, limit: 100, offset: 0 }, { secrets: [TEST_TOKEN] });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.pathname).toBe(`/api/v1${path}`);
    expect(fake.requests[0]?.url.searchParams.get("countAll")).toBe("1");
    const expected = body.objects.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      delete copy["sevClient"];
      return copy;
    });
    expect(read.result).toEqual({
      path,
      objects: expected,
      total: body.total,
      hasMore: false,
      omittedFields: ["/*/sevClient"],
    });
    expect(apiGetTool.output.parse(read.result)).toEqual(read.result);
  });

  it(`is confirmed by probe ${probe} with keys and types and no binary fields`, async () => {
    const body = bodyOf(fixture);
    const handler: ScriptedHandler = (call) => {
      if (call.path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
      if (call.path === path) {
        const offset = Number(call.query["offset"] ?? 0);
        const limit = Number(call.query["limit"] ?? 100);
        return { total: body.total, objects: body.objects.slice(offset, offset + limit) };
      }
      if (call.path.startsWith(`${path}/`)) return { objects: body.objects.slice(0, 1) };
      return { total: 0, objects: [] };
    };
    const client = new ScriptedClient(handler);
    const report = await runProbes({
      client,
      scrubber: createScrubber({ secrets: [TEST_TOKEN] }),
      probes: READ_PROBES,
      allowWrites: false,
      tag: "MCP-E2E 20261109-2200-abcd",
      today: "2026-11-09",
      nowSeconds: 1_794_000_000,
      baseUrl: "https://my.sevdesk.de/api/v1",
      only: [probe],
    });

    expect(client.calls.every((call) => call.method === "GET")).toBe(true);
    const [result] = report.results;
    expect(result?.status).toBe("confirmed");
    for (const key of Object.keys(body.objects[0] ?? {})) {
      expect(result?.finding).toContain(key);
    }
    expect(result?.finding).toContain("Binary-looking fields: none");
    expect(result?.finding).not.toMatch(/Musterfirma|Sehr geehrte|beleg-/);
  });
});

/**
 * The answers the probes and `pnpm fixtures:record` read on the trial account (2026-11-10,
 * Update 2.0). `/PartUnity` had no rows there, so only its community fixture exists.
 * `/TextTemplate` ignores `limit` and `offset` (all 9 rows for limit=2); `/Document` honours both.
 */
describe("recorded answers (2026-11-10)", () => {
  const RECORDED = [
    {
      path: "/TextTemplate",
      fixture: "recorded/2026-11-10/advanced/text-templates.json",
      community: "advanced/text-templates.json",
      // The trial rows carry `additionalInformation` and no `sevUser`, unlike the community model.
      onlyRecorded: ["additionalInformation"],
      onlyCommunity: ["sevUser"],
    },
    {
      path: "/Document",
      fixture: "recorded/2026-11-10/advanced/documents.json",
      community: "advanced/documents.json",
      onlyRecorded: [],
      onlyCommunity: [],
    },
  ] as const;

  it.each(RECORDED)(
    "$path: the recorded keys differ from the community model only where noted",
    ({ fixture, community, onlyRecorded, onlyCommunity }) => {
      expect(loadFixture(fixture)._provenance.source).toBe("recorded");
      const recorded = new Set(Object.keys(bodyOf(fixture).objects[0] ?? {}));
      const modelled = new Set(Object.keys(bodyOf(community).objects[0] ?? {}));
      expect([...recorded].filter((key) => !modelled.has(key))).toEqual(onlyRecorded);
      expect([...modelled].filter((key) => !recorded.has(key))).toEqual(onlyCommunity);
    },
  );

  it.each(RECORDED)(
    "$path: the recorded answer reads through sevdesk_api_get",
    async ({ path, fixture }) => {
      const body = bodyOf(fixture);
      const { client } = realClient(jsonResponse(body));
      const read = await apiGet(client, { path, limit: 100, offset: 0 }, { secrets: [TEST_TOKEN] });
      expect(apiGetTool.output.parse(read.result)).toEqual(read.result);
      expect(read.result).toMatchObject({ path, total: body.total });
    },
  );

  it("an endpoint that ignores limit sends everything and reports no further page", async () => {
    const body = bodyOf("recorded/2026-11-10/advanced/text-templates.json");
    expect(body.objects.length).toBeGreaterThan(2);
    const { client } = realClient(jsonResponse(body));
    const read = await apiGet(
      client,
      { path: "/TextTemplate", limit: 2, offset: 0 },
      { secrets: [TEST_TOKEN] },
    );
    expect(read.result).toMatchObject({ total: body.total, hasMore: false });
    expect((read.result as { objects: unknown[] }).objects).toHaveLength(body.objects.length);
  });
});

describe("probe outcomes the live run may report", () => {
  async function run(probe: string, handler: ScriptedHandler) {
    const client = new ScriptedClient((call) =>
      call.path === "/Tools/bookkeepingSystemVersion"
        ? { objects: { version: "2.0" } }
        : handler(call),
    );
    const report = await runProbes({
      client,
      scrubber: createScrubber({ secrets: [TEST_TOKEN] }),
      probes: READ_PROBES,
      allowWrites: false,
      tag: "MCP-E2E 20261109-2200-abcd",
      today: "2026-11-09",
      nowSeconds: 1_794_000_000,
      baseUrl: "https://my.sevdesk.de/api/v1",
      only: [probe],
    });
    return report.results[0];
  }

  it("an empty account is inconclusive", async () => {
    const result = await run("read-text-template", () => ({ total: 0, objects: [] }));
    expect(result).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(/answers JSON .* but the account has no rows/) as unknown,
    });
  });

  it("a missing endpoint contradicts D-024", async () => {
    const { SevdeskError } = await import("../../src/sevdesk/errors.js");
    const result = await run("read-part-unity", () => {
      throw new SevdeskError({ kind: "not_found", message: "Not found.", status: 404 });
    });
    expect(result).toMatchObject({
      status: "contradicted",
      finding: "GET /PartUnity: 404 Not found.",
    });
  });

  it("names ignored paging, a non-list answer and binary fields", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: String(index + 1),
      thumbnail: "AAAA",
      textType: "HEAD",
    }));
    const ignored = await run("read-text-template", (call) =>
      call.path === "/TextTemplate" && call.query["textType"] !== "HEAD"
        ? { objects: rows }
        : { objects: rows.slice(0, 1) },
    );
    expect(ignored?.finding).toMatch(
      /3 rows for limit=2, no total; limit ignored, offset ignored or unstable/,
    );
    expect(ignored?.finding).toMatch(/Binary-looking fields: thumbnail \(4 chars\)/);
    expect(ignored?.finding).toMatch(/textType filter: 1 rows, 1 matching \(honored\)/);

    const scalar = await run("read-document", () => ({ objects: "5" }));
    expect(scalar).toMatchObject({
      status: "observed",
      finding: "GET /Document: objects is string.",
    });
  });

  it("refuses a non-JSON answer", async () => {
    const { RawAnswer } = await import("../unit/scripts/scripted-client.js");
    const result = await run(
      "read-document",
      () => new RawAnswer(new TextEncoder().encode("%PDF-1.7"), "application/pdf"),
    );
    expect(result).toMatchObject({
      status: "contradicted",
      finding: "GET /Document answered application/pdf, not JSON.",
    });
  });

  it("reports GET /Document/{id} failures and extra keys", async () => {
    const rows = [{ id: "5", filename: "a.pdf" }];
    const failing = await run("read-document", (call) => {
      if (call.path === "/Document") return { total: 1, objects: rows };
      return { objects: { id: "5" } };
    });
    expect(failing?.finding).toMatch(/GET \/Document\/\{id\}: objects is not a list\./);

    const extra = await run("read-document", (call) => {
      if (call.path === "/Document") return { total: 1, objects: rows };
      return { objects: [{ ...rows[0], content: "QUJD".repeat(200) }] };
    });
    expect(extra?.finding).toMatch(
      /GET \/Document\/\{id\}: 1 rows; keys beyond the list row: content; binary-looking fields: content \(800 chars\)\./,
    );
  });
});
