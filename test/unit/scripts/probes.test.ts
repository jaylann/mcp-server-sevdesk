import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ALL_PROBES, NOT_PROBED } from "../../../scripts/lib/probes/catalog.js";
import {
  addDays,
  berlinMidnight,
  createdId,
  diffState,
  germanDate,
  type ProbeDefinition,
  requestLine,
  sendState,
  str,
} from "../../../scripts/lib/probes/core.js";
import { renderReport } from "../../../scripts/lib/probes/report.js";
import { orderProbes, type RunOptions, runProbes } from "../../../scripts/lib/probes/runner.js";
import { createScrubber } from "../../../scripts/lib/scrub.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type ScriptedCall, ScriptedClient, type ScriptedHandler } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TAG = "MCP-E2E 20261120-1000-abcd";

function options(client: ScriptedClient, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    client,
    scrubber: createScrubber({ secrets: [TOKEN] }),
    probes: ALL_PROBES,
    allowWrites: false,
    tag: TAG,
    today: "2026-11-20",
    nowSeconds: 1_795_000_000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    ...overrides,
  };
}

/** An empty 2.0 account: every list is empty, by-id reads find nothing. */
const emptyAccount: ScriptedHandler = (call) => {
  if (call.path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
  if (/\/\d+$/.test(call.path)) return { objects: [] };
  return { total: "0", objects: [] };
};

describe("probe catalog", () => {
  it("has unique ids, a mode prefix and a question for every probe", () => {
    const ids = ALL_PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const probe of ALL_PROBES) {
      expect(probe.id.startsWith(`${probe.mode}-`), probe.id).toBe(true);
      expect(probe.question.length).toBeGreaterThan(20);
      expect(probe.deviations.length).toBeGreaterThan(0);
    }
  });

  it("maps only to deviation entries that exist in spec/deviations.md (or regression ids)", () => {
    const register = readFileSync(new URL("../../../spec/deviations.md", import.meta.url), "utf8");
    const referenced = [
      ...ALL_PROBES.flatMap((probe) => probe.deviations),
      ...NOT_PROBED.flatMap((check) => check.deviations),
    ];
    for (const id of new Set(referenced)) {
      // Regression ids (B8) and proposals for a new entry (NEW) are not in the register yet.
      if (/^(?:B\d+|NEW)$/.test(id)) continue;
      expect(register, id).toContain(`### ${id}:`);
    }
  });

  it("covers the recording checklist", () => {
    const covered = new Set(ALL_PROBES.flatMap((probe) => probe.deviations));
    for (const id of [
      "D-023",
      "D-033",
      "D-046",
      "D-047",
      "D-020",
      "D-048",
      "D-049",
      "D-024",
      "D-043",
      "D-040",
      "D-037",
      "D-038",
      "D-027",
      "D-013",
    ]) {
      expect(covered.has(id), id).toBe(true);
    }
    expect(ALL_PROBES.map((probe) => probe.id)).toEqual(
      expect.arrayContaining([
        "write-numbering-order-draft",
        "write-numbering-credit-note",
        "write-numbering-invoice",
        "write-next-order-number",
        "write-delete-draft-invoice",
        "write-getpdf-preview-drafts",
        "write-invoice-from-order",
        "read-origin-filter",
        "read-cancellation-origin",
      ]),
    );
  });

  it("never probes irreversible endpoints, and e-mails only from the e-mail probe", () => {
    const source = ["read-probes.ts", "write-probes.ts"]
      .map((file) =>
        readFileSync(new URL(`../../../scripts/lib/probes/${file}`, import.meta.url), "utf8"),
      )
      .join("\n");
    expect(source).not.toMatch(/\/enshrine|sendByWithRender|Export\/|useNextNumber: "true"/);
    expect(source.match(/sendViaEmail`/g)).toHaveLength(1);
    expect(source.match(/tier: "external"/g)).toHaveLength(1);
    expect(
      ALL_PROBES.filter((probe) => probe.sendsEmail === true).map((probe) => probe.id),
    ).toEqual(["write-send-email-shape"]);
    expect(NOT_PROBED.map((check) => check.what).join("\n")).toMatch(/createDatevXmlZipExportJob/);
    expect(NOT_PROBED.map((check) => check.what).join("\n")).toMatch(/useNextNumber=true/);
  });

  it("orders write probes before read probes", () => {
    const ordered = orderProbes(ALL_PROBES);
    const firstRead = ordered.findIndex((probe) => probe.mode === "read");
    expect(ordered.slice(firstRead).every((probe) => probe.mode === "read")).toBe(true);
  });
});

describe("runProbes (read-only)", () => {
  it("sends only GETs, skips write and opt-in probes, and stays inconclusive on an empty account", async () => {
    const client = new ScriptedClient(emptyAccount);
    const report = await runProbes(options(client));

    expect(client.writes()).toEqual([]);
    expect(client.calls.every((call) => call.method === "GET")).toBe(true);
    expect(report.systemVersion).toBe("2.0");
    expect(report.writes).toBe(false);
    expect(report.created).toEqual([]);

    const byId = new Map(report.results.map((result) => [result.id, result]));
    expect(byId.get("write-numbering-invoice")).toMatchObject({
      status: "skipped",
      finding: expect.stringMatching(/needs --allow-writes/) as unknown,
      deviations: [
        { id: "D-027", verdict: "not checked" },
        { id: "B4", verdict: "not checked" },
      ],
    });
    expect(byId.get("read-rate-limit-burst")).toMatchObject({
      status: "skipped",
      finding: expect.stringMatching(/opt-in/) as unknown,
    });
    expect(byId.get("read-getxml-shapes")?.status).toBe("inconclusive");
    expect(byId.get("read-credit-note-statuses")?.status).toBe("confirmed");
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);
  });

  it("stops before any probe when the account cannot be read", async () => {
    const client = new ScriptedClient(() => {
      throw new SevdeskError({ kind: "auth", message: "The token was rejected.", status: 401 });
    });
    await expect(runProbes(options(client))).rejects.toThrow(
      /Cannot read the bookkeeping system version \(401\): The token was rejected\./,
    );
    expect(client.calls).toHaveLength(1);
  });

  it("runs only selected probes and captures a probe's crash as an error", async () => {
    const crashing: ProbeDefinition = {
      id: "read-crash",
      title: "crash",
      mode: "read",
      question: "What happens when a probe throws?",
      deviations: ["D-001"],
      run: () => Promise.reject(new Error(`boom with ${TOKEN} and hans@huber.de`)),
    };
    const report = await runProbes(
      options(new ScriptedClient(emptyAccount), {
        probes: [...ALL_PROBES, crashing],
        only: ["read-crash", "read-unknown-id"],
      }),
    );
    expect(report.results.map((result) => result.id)).toEqual(["read-unknown-id", "read-crash"]);
    expect(report.results[1]).toMatchObject({
      status: "error",
      finding: "boom with <redacted> and person1@example.com",
      deviations: [{ id: "D-001", verdict: "not checked" }],
    });
  });

  it("detects an unknown id answered with an empty list and keeps scrubbed evidence", async () => {
    const report = await runProbes(
      options(new ScriptedClient(emptyAccount), { only: ["read-unknown-id"] }),
    );
    const [result] = report.results;
    expect(result).toMatchObject({
      status: "confirmed",
      finding: "Contact: 2xx with an empty list; Invoice: 2xx with an empty list.",
      deviations: [
        { id: "D-001", verdict: "confirms" },
        { id: "D-021", verdict: "informs" },
      ],
    });
    expect(result?.evidence.map((exchange) => exchange.request)).toEqual([
      "GET /Contact/999999999",
      "GET /Invoice/999999999",
    ]);
  });

  it("checks that cancellation invoices point to their original, counting tagged ones", async () => {
    const handler: ScriptedHandler = (call) => {
      if (call.path === "/Invoice") {
        return {
          total: "3",
          objects: [
            { id: "31", invoiceType: "SR", origin: { id: "30", objectName: "Invoice" } },
            { id: "41", invoiceType: "SR", origin: null },
            { id: "30", invoiceType: "RE", origin: null },
          ],
        };
      }
      if (call.path === "/Invoice/30") return { objects: [{ id: "30", header: `${TAG} Invoice` }] };
      return emptyAccount(call);
    };
    const report = await runProbes(
      options(new ScriptedClient(handler), { only: ["read-cancellation-origin"] }),
    );
    expect(report.results[0]).toMatchObject({
      status: "contradicted",
      finding:
        "2 SR invoices, 1 with an origin Invoice, without: 41. Of 1 origins read, 1 exist (1 created by this tooling).",
      deviations: [{ id: "D-037", verdict: "contradicts" }],
    });
  });

  it("compares the origin filter with a local filter of one contact's documents", async () => {
    const rows = [
      { id: "31", contact: { id: "7" }, origin: { id: "30", objectName: "Invoice" } },
      { id: "32", contact: { id: "7" }, origin: null },
    ];
    const handler: ScriptedHandler = (call) => {
      if (call.path === "/Invoice") {
        const filtered = call.query["origin[id]"] === 30;
        return { objects: filtered ? rows.filter((row) => row.origin !== null) : rows };
      }
      return emptyAccount(call);
    };
    const client = new ScriptedClient(handler);
    const report = await runProbes(options(client, { only: ["read-origin-filter"] }));
    expect(report.results[0]).toMatchObject({
      status: "confirmed",
      finding: expect.stringMatching(
        /\/Invoice, contact 7, origin Invoice 30: filtered answer 1 rows, local filter of the 2 unfiltered rows 1 \(same rows: honored\); \/CreditNote: no row/,
      ) as unknown,
    });
    expect(client.calls.some((call) => call.query["origin[objectName]"] === "Invoice")).toBe(true);
  });

  it("reports a getPdf preview that changed a finalized document as a contradiction", async () => {
    let previewed = false;
    const handler: ScriptedHandler = (call) => {
      if (call.path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
      if (call.path === "/Invoice") return { total: "1", objects: [{ id: "5", status: "200" }] };
      if (call.path === "/Invoice/5/getPdf") {
        previewed = true;
        return { objects: { content: "JVBER" } };
      }
      if (call.path === "/Invoice/5") {
        return {
          objects: [
            { id: "5", status: "200", sendDate: previewed ? "2026-11-20T10:00:00+01:00" : null },
          ],
        };
      }
      return emptyAccount(call);
    };
    const client = new ScriptedClient(handler);
    const report = await runProbes(options(client, { only: ["read-getpdf-preview-finalized"] }));

    expect(report.results[0]).toMatchObject({
      status: "contradicted",
      finding: expect.stringMatching(
        /Invoice 5: PDF read, changed \(sendDate: \(empty\) → 2026-11-20/,
      ) as unknown,
    });
    expect(client.calls.find((call) => call.path === "/Invoice/5/getPdf")?.query).toEqual({
      preventSendBy: "true",
    });
  });
});

describe("runProbes (write mode)", () => {
  /** A trial account that accepts drafts, finalizes them and assigns numbers on sendBy. */
  function trialAccount() {
    const documents = new Map<string, Record<string, unknown>>();
    let nextId = 100;
    const handler: ScriptedHandler = (call: ScriptedCall) => {
      if (call.path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
      if (call.path === "/SevUser")
        return { total: "1", objects: [{ id: "7", objectName: "SevUser" }] };
      if (call.method === "POST" && call.path === "/Contact")
        return { objects: { id: String(nextId++), objectName: "Contact" } };
      const save = /^\/(Invoice|CreditNote|Order)\/Factory\/save(?:Invoice|CreditNote|Order)$/.exec(
        call.path,
      );
      if (save !== null) {
        const kind = save[1] ?? "";
        const key = kind === "CreditNote" ? "creditNote" : kind.toLowerCase();
        const id = String(nextId++);
        const header = (call.body as Record<string, Record<string, unknown>>)[key] ?? {};
        documents.set(`${kind}/${id}`, { ...header, id, status: "100", [`${key}Number`]: null });
        return { objects: { [key]: { id, objectName: kind } } };
      }
      const sendBy = /^\/(Invoice|CreditNote|Order)\/(\d+)\/sendBy$/.exec(call.path);
      if (sendBy !== null) {
        const doc = documents.get(`${sendBy[1] ?? ""}/${sendBy[2] ?? ""}`);
        if (doc !== undefined)
          Object.assign(doc, {
            status: "200",
            invoiceNumber: "RE-1001",
            creditNoteNumber: "GU-1001",
          });
        return { objects: doc };
      }
      if (call.path === "/Order/Factory/getNextOrderNumber") return { objects: "AN-1001" };
      if (/^\/Invoice\/\d+\/sendViaEmail$/.test(call.path)) {
        return {
          objects: {
            id: "1",
            objectName: "Email",
            toEmail: (call.body as { toEmail?: string }).toEmail,
          },
        };
      }
      const byId = /^\/(Invoice|CreditNote|Order)\/(\d+)$/.exec(call.path);
      if (byId !== null) {
        const doc = documents.get(`${byId[1] ?? ""}/${byId[2] ?? ""}`);
        return { objects: doc === undefined ? [] : [doc] };
      }
      if (call.method !== "GET")
        throw new SevdeskError({
          kind: "validation",
          message: "Invalid request",
          status: 422,
          upstreamMessage: "not simulated",
        });
      return emptyAccount(call);
    };
    return new ScriptedClient(handler);
  }

  it("creates tagged drafts without document numbers and finalizes with the commit tier", async () => {
    const client = trialAccount();
    const report = await runProbes(
      options(client, {
        allowWrites: true,
        only: [
          "write-numbering-invoice",
          "write-numbering-credit-note",
          "write-numbering-order-draft",
          "write-next-order-number",
        ],
      }),
    );

    const statuses = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
    expect(statuses).toEqual({
      "write-numbering-invoice": "confirmed",
      "write-numbering-credit-note": "observed",
      "write-numbering-order-draft": "observed",
      "write-next-order-number": "observed",
    });
    const invoice = report.results.find((result) => result.id === "write-numbering-invoice");
    expect(invoice?.finding).toMatch(
      /has no number \(null\/empty\)\. sendBy: ok, status 200, a number \(RE-1001\)/,
    );
    expect(
      report.results.find((result) => result.id === "write-next-order-number")?.finding,
    ).toMatch(/the same number, so the sequence did not advance/);

    const writes = client.writes();
    for (const call of writes) {
      expect(JSON.stringify(call.body ?? {})).not.toMatch(
        /invoiceNumber|creditNoteNumber|orderNumber/,
      );
      expect(call.tier).toBe(call.path.endsWith("/sendBy") ? "commit" : "write");
    }
    const contact = writes.find((call) => call.path === "/Contact");
    expect(contact?.body).toMatchObject({ name: TAG });
    expect(writes.filter((call) => call.path === "/Contact")).toHaveLength(1);
    const savedInvoice = writes.find((call) => call.path === "/Invoice/Factory/saveInvoice")
      ?.body as Record<string, Record<string, unknown>>;
    expect(savedInvoice["invoice"]).toMatchObject({
      header: `${TAG} Invoice`,
      customerInternalNote: TAG,
      status: "100",
      invoiceDate: "20.11.2026",
      contactPerson: { id: 7, objectName: "SevUser" },
      taxRule: { id: "1", objectName: "TaxRule" },
    });
    expect(savedInvoice["invoicePosSave"]).toEqual([
      expect.objectContaining({
        objectName: "InvoicePos",
        name: `${TAG} position 1`,
        price: 100,
        taxRate: 19,
      }),
    ]);
    const savedCreditNote = writes.find(
      (call) => call.path === "/CreditNote/Factory/saveCreditNote",
    )?.body as Record<string, unknown>;
    expect(savedCreditNote["creditNote"]).toMatchObject({
      creditNoteType: "CN",
      bookingCategory: "PROVISION",
      taxRule: { id: "9", objectName: "TaxRule" },
      deliveryDate: berlinMidnight("2026-11-20"),
      creditNoteDate: "20.11.2026",
      discount: 0,
    });
    expect(savedCreditNote["creditNotePosDelete"]).toBeNull();
    expect(savedInvoice["invoice"]).toMatchObject({ deliveryDate: berlinMidnight("2026-11-20") });
    expect(
      client.calls.find((call) => call.path === "/Order/Factory/getNextOrderNumber")?.query,
    ).toEqual({
      orderType: "AN",
      useNextNumber: "false",
    });

    expect(
      report.created.map((record) => [record.objectName, record.state.split(" ")[0], record.probe]),
    ).toEqual([
      ["Contact", "active", "write-numbering-order-draft"],
      ["Order", "draft", "write-numbering-order-draft"],
      ["CreditNote", "finalized", "write-numbering-credit-note"],
      ["Invoice", "finalized", "write-numbering-invoice"],
    ]);
  });

  it("e-mails only with --probe-email, only to that address, with the external tier", async () => {
    const without = trialAccount();
    const skipped = await runProbes(
      options(without, { allowWrites: true, only: ["write-send-email-shape"] }),
    );
    expect(skipped.results[0]).toMatchObject({
      status: "skipped",
      finding: expect.stringMatching(/needs --probe-email/) as unknown,
    });
    expect(without.writes()).toEqual([]);

    const client = trialAccount();
    const report = await runProbes(
      options(client, {
        allowWrites: true,
        probeEmail: "me@example.org",
        only: ["write-send-email-shape"],
      }),
    );
    const emails = client.writes().filter((call) => call.path.endsWith("/sendViaEmail"));
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      tier: "external",
      body: { toEmail: "me@example.org", copy: false },
    });
    expect(report.results[0]?.status).toBe("observed");
    expect(renderReport(report)).not.toContain("me@example.org");
  });

  it("runs every write probe without crashing and never e-mails without an address", async () => {
    const client = trialAccount();
    const report = await runProbes(
      options(client, {
        allowWrites: true,
        only: ALL_PROBES.filter((probe) => probe.mode === "write").map((probe) => probe.id),
      }),
    );
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);
    expect(client.calls.some((call) => call.path.includes("sendViaEmail"))).toBe(false);
    for (const call of client.writes()) expect(call.tier).not.toBe("external");
    for (const call of client.writes().filter((item) => item.path.includes("bookAmount"))) {
      expect(call.tier).toBe("commit");
    }
  });

  it("renders the report with summary, deviation index, evidence, manual checks and cleanup", async () => {
    const report = await runProbes(
      options(trialAccount(), {
        allowWrites: true,
        only: ["write-numbering-invoice", "read-unknown-id"],
      }),
    );
    const markdown = renderReport(report);

    expect(markdown).toMatch(/^# sevDesk API probe report\n/);
    expect(markdown).toContain(`- Mode: with write probes (test data tagged \`${TAG}\`)`);
    expect(markdown).toContain(
      "| [write-numbering-invoice](#write-numbering-invoice) | write | confirmed | D-027 (confirms), B4 (confirms) |",
    );
    expect(markdown).toContain("- D-027: write-numbering-invoice: confirms");
    expect(markdown).toContain("`PUT /Invoice/101/sendBy");
    expect(markdown).toContain("## Not probed (manual)");
    expect(markdown).toContain(
      "| Invoice | 101 | finalized (cannot be deleted; cancel or leave) | write-numbering-invoice |",
    );
    expect(markdown).not.toContain(TOKEN);
  });
});

describe("core helpers", () => {
  it("formats request lines, ids, states and dates", () => {
    expect(requestLine("GET", "/CreditNotePos", { "creditNote[id]": 5, flag: true })).toBe(
      "GET /CreditNotePos?creditNote[id]=5&flag=1",
    );
    expect(createdId({ invoice: { id: "12" } }, "invoice")).toBe(12);
    expect(createdId([{ id: "3" }])).toBe(3);
    expect(createdId({ id: "4", objectName: "Invoice" }, "creditNote")).toBe(4);
    expect(createdId(null)).toBeUndefined();
    expect(str({ a: null, b: 5, c: { id: "1" } }, "c")).toBe('{"id":"1"}');
    expect(str({ a: null }, "a")).toBe("");
    const before = sendState({ status: "100", sendDate: null });
    expect(diffState(before, before)).toBe("");
    expect(diffState(before, sendState({ status: "200", sendDate: "x" }))).toBe(
      "status: 100 → 200; sendDate: (empty) → x",
    );
    expect(berlinMidnight("2026-11-20")).toBe(Date.parse("2026-11-19T23:00:00Z") / 1000);
    expect(berlinMidnight("2026-07-01")).toBe(Date.parse("2026-06-30T22:00:00Z") / 1000);
    expect(germanDate("2026-11-20")).toBe("20.11.2026");
    expect(addDays("2026-11-20", -30)).toBe("2026-10-21");
  });
});
