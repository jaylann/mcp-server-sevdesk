import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeEntry,
  endpointKey,
  firstId,
  NOT_RECORDED,
  type RecordEntry,
  recordPlan,
  resolveEntry,
} from "../../../scripts/lib/fixture-plan.js";
import { recordFixtures } from "../../../scripts/lib/record.js";
import { createScrubber } from "../../../scripts/lib/scrub.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type ScriptedCall, ScriptedClient } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const PLAN = recordPlan("2026-11-20");

/** Committed fixture files below test/fixtures/ (recordings excluded). */
function committedFixtures(dir = FIXTURES): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "recorded" ? [] : committedFixtures(path);
    return name.endsWith(".json") ? [relative(FIXTURES, path).split(sep).join("/")] : [];
  });
}

/**
 * For a fixture that holds the answer to a read (its provenance ref names a GET): the endpoint
 * named in the ref (`undefined` when it names none). `null` for fixtures of writes.
 */
function readEndpoint(file: string): string | undefined | null {
  const ref = (
    JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as { _provenance: { ref: string } }
  )._provenance.ref;
  if (!/\bGET\b|\/get\/responses/.test(ref)) return null;
  const named = /\bGET\s+(\/[^\s?,)]+)/.exec(ref)?.[1];
  if (named !== undefined) return endpointKey(named);
  const pointer = /paths\/([^/]+)\/get/.exec(ref)?.[1];
  return pointer === undefined ? undefined : endpointKey(pointer.replace(/~1/g, "/"));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "record-fixtures-"));
  tempDirs.push(dir);
  return dir;
}

/** A small simulated account answering every read of the plan. */
function account(call: ScriptedCall): unknown {
  const { path } = call;
  if (path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
  if (path === "/TaxRule")
    return {
      total: "1",
      objects: [{ id: "1", objectName: "TaxRule", name: "Umsatzsteuerpflichtige Umsätze" }],
    };
  if (path === "/SevUser") {
    return {
      total: "1",
      objects: [
        {
          id: "7",
          objectName: "SevUser",
          fullname: "Hans Huber",
          email: "hans@huber.de",
          sevClient: { id: "512345", objectName: "SevClient" },
        },
      ],
    };
  }
  if (path === "/Contact") {
    return {
      total: "2",
      objects: [
        {
          id: "11",
          objectName: "Contact",
          name: "Huber Bau GmbH",
          surename: null,
          familyname: null,
        },
        { id: "12", objectName: "Contact", name: null, surename: "Hans", familyname: "Huber" },
      ],
    };
  }
  if (path === "/Contact/11")
    return {
      objects: [
        { id: "11", objectName: "Contact", name: "Huber Bau GmbH", vatNumber: "DE123456789" },
      ],
    };
  if (path === "/Invoice") {
    return {
      total: "2",
      objects: [
        {
          id: "21",
          objectName: "Invoice",
          status: "100",
          invoiceNumber: null,
          header: `Token ${TOKEN}`,
        },
        {
          id: "22",
          objectName: "Invoice",
          status: "200",
          invoiceNumber: "RE-1038",
          addressName: "Huber Bau GmbH",
        },
      ],
    };
  }
  if (path === "/Invoice/22/getPdf") {
    return {
      objects: {
        filename: "RE-1038.pdf",
        mimeType: "application/pdf",
        base64encoded: true,
        content: `JVBER${"A".repeat(400)}`,
      },
    };
  }
  if (path === "/Invoice/22/getXml") {
    throw new SevdeskError({
      kind: "validation",
      message: "Invalid request",
      status: 400,
      upstreamMessage: "Keine E-Rechnung vorhanden",
    });
  }
  if (path === "/CheckAccount")
    throw new SevdeskError({
      kind: "server",
      message: "sevDesk had an internal error.",
      status: 503,
    });
  // Everything else: an empty collection or an empty by-id answer.
  return { total: "0", objects: [] };
}

describe("recordPlan", () => {
  it("records the endpoint of every committed read fixture or says why not", () => {
    const mirrored = new Set(PLAN.flatMap((entry) => entry.mirrors));
    const recorded = new Set(PLAN.map((entry) => endpointKey(entry.path)));
    const missing = committedFixtures().filter((file) => {
      const endpoint = readEndpoint(file);
      if (endpoint === null || mirrored.has(file) || file in NOT_RECORDED) return false;
      return endpoint === undefined || !recorded.has(endpoint);
    });
    expect(missing).toEqual([]);
  });

  it("normalizes endpoints without ids", () => {
    expect(endpointKey("/api/v1/Invoice?embed=contact")).toBe("/Invoice");
    expect(endpointKey("/Invoice/{invoice}")).toBe("/Invoice");
    expect(endpointKey("/Invoice/1001/getPdf")).toBe("/Invoice/{}/getPdf");
    expect(endpointKey("/CheckAccount/{checkAccountId}/getBalanceAtDate")).toBe(
      "/CheckAccount/{}/getBalanceAtDate",
    );
    expect(endpointKey("/Contact/Factory/getNextCustomerNumber")).toBe(
      "/Contact/Factory/getNextCustomerNumber",
    );
  });

  it("only mirrors fixtures that exist, with unique output files", () => {
    for (const entry of PLAN) {
      for (const mirror of entry.mirrors)
        expect(existsSync(join(FIXTURES, mirror)), mirror).toBe(true);
    }
    for (const file of Object.keys(NOT_RECORDED))
      expect(existsSync(join(FIXTURES, file)), file).toBe(true);
    const files = PLAN.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("orders entries so every required id is collected by an earlier entry", () => {
    const provided = new Set<string>();
    const probe = { id: 1, status: "200", surename: "x", familyname: "y" };
    for (const entry of PLAN) {
      for (const slot of entry.requires ?? [])
        expect(provided.has(slot), `${entry.file} needs ${slot}`).toBe(true);
      for (const slot of Object.keys(entry.collect?.([probe, { id: 2, status: "200" }]) ?? {}))
        provided.add(slot);
    }
  });

  it("reads only, and PDFs only of non-drafts with preventSendBy=true", () => {
    for (const entry of PLAN.filter((item) => item.path.endsWith("/getPdf"))) {
      expect(entry.query).toEqual({ preventSendBy: "true" });
      expect(entry.requires?.[0]).toMatch(/Final$/);
    }
    expect(
      PLAN.some((entry) => /enshrine|sendBy|sendVia|Factory\/save|bookAmount/i.test(entry.path)),
    ).toBe(false);
  });
});

describe("plan helpers", () => {
  const entry: RecordEntry = {
    file: "x.json",
    mirrors: [],
    path: "/Invoice/{invoice}/getPdf",
    query: { preventSendBy: "true", "invoice[id]": "{invoice}", depth: 1 },
    requires: ["invoice"],
  };

  it("fills placeholders and reports the first missing id", () => {
    expect(resolveEntry(entry, { invoice: 5 })).toEqual({
      ok: true,
      path: "/Invoice/5/getPdf",
      query: { preventSendBy: "true", "invoice[id]": "5", depth: 1 },
    });
    expect(resolveEntry(entry, {})).toEqual({ ok: false, missing: "invoice" });
  });

  it("describes requests readably", () => {
    expect(describeEntry(entry)).toBe(
      "GET /Invoice/{invoice}/getPdf?preventSendBy=true&invoice[id]={invoice}&depth=1",
    );
    expect(
      describeEntry({
        file: "y",
        mirrors: [],
        path: "/Contact",
        query: { depth: true },
        list: true,
      }),
    ).toBe("GET /Contact?depth=1&limit=n");
  });

  it("finds the first matching positive id", () => {
    expect(firstId([{ id: "0" }, { id: "x" }, { id: "9", status: "200" }])).toBe(9);
    expect(firstId({ id: "4" })).toBe(4);
    expect(firstId([{ id: "3", status: "100" }], (row) => row["status"] !== "100")).toBeUndefined();
  });
});

describe("recordFixtures", () => {
  it("writes scrubbed fixtures in the committed format and never the token", async () => {
    const dir = await tempDir();
    const client = new ScriptedClient(account);
    const lines: string[] = [];

    const outcome = await recordFixtures({
      client,
      scrubber: createScrubber({ secrets: [TOKEN] }),
      secrets: [TOKEN],
      outDir: dir,
      date: "2026-11-20",
      limit: 5,
      entries: PLAN,
      log: (line) => lines.push(line),
    });

    expect(outcome.systemVersion).toBe("2.0");
    expect(
      client.calls.every((call) => call.method === "GET" && call.operation === "download"),
    ).toBe(true);
    expect(client.calls.find((call) => call.path === "/Invoice")?.query).toEqual({
      embed: "contact",
      limit: 5,
      offset: 0,
      countAll: true,
    });
    // PDFs only for the non-draft invoice 22, never for draft 21.
    expect(client.calls.map((call) => call.path)).toContain("/Invoice/22/getPdf");
    expect(client.calls.map((call) => call.path)).not.toContain("/Invoice/21/getPdf");

    expect(outcome.failed).toEqual([{ file: "banking/check-accounts.json", reason: "server 503" }]);
    expect(outcome.skipped).toContainEqual({
      file: "documents/invoice-xml.json",
      reason: "validation 400: Keine E-Rechnung vorhanden",
    });
    expect(outcome.skipped).toContainEqual({
      file: "banking/balance.json",
      reason: "no checkAccount id: the account has no matching record",
    });

    const written = outcome.written.map((item) => item.file);
    expect(written).toContain("invoices/invoices-list.json");
    const files = await readdir(dir, { recursive: true });
    for (const file of written) {
      const text = await readFile(join(dir, file), "utf8");
      expect(text).not.toContain(TOKEN);
      const fixture = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(fixture)).toEqual(["_provenance", "status", "body"]);
      expect(fixture["status"]).toBe(200);
      const provenance = fixture["_provenance"] as Record<string, unknown>;
      expect(Object.keys(provenance).sort()).toEqual([
        "date",
        "note",
        "ref",
        "source",
        "systemVersion",
      ]);
      expect(provenance).toMatchObject({
        source: "recorded",
        date: "2026-11-20",
        systemVersion: "2.0",
      });
    }
    expect(files).toContain(join("invoices", "invoices-list.json"));

    const invoices = JSON.parse(
      await readFile(join(dir, "invoices/invoices-list.json"), "utf8"),
    ) as {
      _provenance: { ref: string; note: string };
      body: { total: string; objects: Record<string, unknown>[] };
    };
    expect(invoices._provenance.ref).toBe(
      "GET /Invoice?embed=contact&limit=n (recording session 2026-11-20)",
    );
    expect(invoices._provenance.note).toMatch(
      /Mirrors invoices\/invoices-list\.json\. A recorded single page/,
    );
    expect(invoices.body.total).toBe("2");
    expect(invoices.body.objects[1]).toMatchObject({
      invoiceNumber: "RE-0001",
      addressName: "Musterfirma 1 GmbH",
      status: "200",
    });
    expect(invoices.body.objects[0]).toMatchObject({
      invoiceNumber: null,
      header: "Muster-Text 1",
    });

    const taxRules = await readFile(join(dir, "meta/tax-rules.json"), "utf8");
    expect(taxRules).toContain("Umsatzsteuerpflichtige Umsätze");
    const users = await readFile(join(dir, "meta/sev-users.json"), "utf8");
    expect(users).not.toMatch(/Huber|huber\.de|512345/);
    const pdf = await readFile(join(dir, "documents/invoice-pdf.json"), "utf8");
    expect(pdf).not.toContain("AAAAAAAAAA");
    expect(
      lines.some((line) => line.startsWith("wrote invoices/invoices-list.json (2 rows)")),
    ).toBe(true);
  });

  it("refuses to overwrite a session's files unless forced", async () => {
    const dir = await tempDir();
    const entries = PLAN.slice(0, 1);
    const run = (force: boolean) =>
      recordFixtures({
        client: new ScriptedClient(account),
        scrubber: createScrubber({ secrets: [TOKEN] }),
        secrets: [TOKEN],
        outDir: dir,
        date: "2026-11-20",
        limit: 5,
        entries,
        force,
      });

    await run(false);
    await expect(run(false)).rejects.toThrow(/EEXIST/);
    await expect(run(true)).resolves.toMatchObject({ written: [{ file: entries[0]?.file }] });
  });

  it("rejects an invalid page size before sending anything", async () => {
    const client = new ScriptedClient(account);
    await expect(
      recordFixtures({
        client,
        scrubber: createScrubber({ secrets: [] }),
        secrets: [],
        outDir: await tempDir(),
        date: "2026-11-20",
        limit: 0,
        entries: PLAN,
      }),
    ).rejects.toThrow(/limit/);
    expect(client.calls).toEqual([]);
  });
});
