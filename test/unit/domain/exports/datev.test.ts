import { describe, expect, it } from "vitest";

import {
  DATEV_DOWNLOAD_INFO_PATH,
  DATEV_HASH_PATH,
  DATEV_JOB_PATH,
  DATEV_PROGRESS_PATH,
  datevFilename,
  datevJobQuery,
  exportFilename,
  fiscalYearStartWithin,
  looksLikeZip,
  MAY_HAVE_STARTED,
  readDatevExportConfig,
  scopeParameter,
  startDatevExportJob,
  waitForDatevExport,
} from "../../../../src/domain/exports/datev.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { resolveGetSafety } from "../../../../src/sevdesk/paths.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";

const JOB = "0a0e1eff-9590-1bea-1195-a3cfc04364cc";
const HASH = "22ae177d286f17aac5daac591c70164159b64c7f_0a0e1eff";

const routes = {
  configured: { path: "/SevClient", response: { fixture: "exports/sev-client-datev.json" } },
  unconfigured: { path: "/SevClient", response: { fixture: "exports/sev-client-no-datev.json" } },
  start: {
    method: "POST",
    path: DATEV_JOB_PATH,
    response: { fixture: "exports/datev-job-start.json" },
  },
  hash: { path: DATEV_HASH_PATH, response: { fixture: "exports/datev-progress-hash.json" } },
  done: { path: DATEV_PROGRESS_PATH, response: { fixture: "exports/datev-progress-done.json" } },
  info: {
    path: DATEV_DOWNLOAD_INFO_PATH,
    response: { fixture: "exports/datev-download-info.json" },
  },
} satisfies Record<string, FakeRoute>;

/** A client whose answers for `path` follow `answers` in order (the last one repeats). */
class SequenceClient extends FakeSevdeskClient {
  private readonly sequences: Map<string, unknown[]>;

  constructor(base: readonly FakeRoute[], sequences: Record<string, unknown[]>) {
    super(base);
    this.sequences = new Map(Object.entries(sequences));
  }

  override request(request: Parameters<FakeSevdeskClient["request"]>[0]): Promise<unknown> {
    const queue = this.sequences.get(request.path);
    if (queue === undefined) return super.request(request);
    this.calls.push({
      operation: "request",
      method: request.method,
      path: request.path,
      query: request.query ?? {},
      sideEffect: false,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

const noSleep = () => Promise.resolve();

describe("readDatevExportConfig", () => {
  it("reads the DATEV settings from GET /SevClient", async () => {
    const client = new FakeSevdeskClient([routes.configured]);
    await expect(readDatevExportConfig(client)).resolves.toEqual({
      accountantNumber: "1234567",
      accountantClientNumber: "12345",
      accountingYearBegin: "2026-01-01",
      missing: [],
    });
  });

  it("names every missing setting (null, zero, not digits, unreadable date)", async () => {
    await expect(
      readDatevExportConfig(new FakeSevdeskClient([routes.unconfigured])),
    ).resolves.toMatchObject({
      missing: [
        "accountant number (Beraternummer)",
        "client number (Mandantennummer)",
        "start of the fiscal year (Wirtschaftsjahresbeginn)",
      ],
    });
    const odd = new FakeSevdeskClient([
      {
        path: "/SevClient",
        response: {
          body: {
            objects: {
              accountantNumber: "0",
              accountantClientNumber: "12a",
              accountingYearBegin: "soon",
            },
          },
        },
      },
    ]);
    await expect(readDatevExportConfig(odd)).resolves.toMatchObject({
      missing: expect.any(Array) as unknown,
    });
    expect((await readDatevExportConfig(odd)).missing).toHaveLength(3);
  });

  it("refuses an answer without an object", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevClient", response: { body: { objects: [] } } },
    ]);
    await expect(readDatevExportConfig(client)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});

describe("the job", () => {
  const params = { from: "2026-01-01", to: "2026-03-31", scope: ["assets", "earnings"] as const };

  it("builds the scope in the spec's order and never sends enshrineDocuments", () => {
    expect(
      scopeParameter(["assets", "earnings", "transactions", "expenditure", "cash_register"]),
    ).toBe("EXTCD");
    const query = datevJobQuery({ ...params, exportByPaydate: true });
    expect(query).toEqual({
      startDate: Date.parse("2026-01-01T00:00:00+01:00") / 1000,
      endDate: Date.parse("2026-04-01T00:00:00+02:00") / 1000 - 1,
      scope: "ED",
      exportByPaydate: "true",
      includeDocumentImages: "false",
    });
    expect(
      Object.keys(
        datevJobQuery({ ...params, exportByPaydate: false, includeDocumentImages: true }),
      ),
    ).toEqual(["startDate", "endDate", "scope", "exportByPaydate", "includeDocumentImages"]);
    expect(resolveGetSafety(DATEV_JOB_PATH, query, false).sideEffect).toBe(true);
  });

  it("starts the job with a POST and the query, and reads the id", async () => {
    const client = new FakeSevdeskClient([routes.start]);

    await expect(startDatevExportJob(client, params)).resolves.toBe(JOB);

    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: DATEV_JOB_PATH,
        query: datevJobQuery(params),
      }),
    ]);
    expect(client.writes()[0]?.body).toBeUndefined();
  });

  it("accepts an id inside an object and refuses anything else", async () => {
    const wrapped = new FakeSevdeskClient([
      {
        method: "POST",
        path: DATEV_JOB_PATH,
        response: { body: { objects: [{ jobId: "abc-1" }] } },
      },
    ]);
    await expect(startDatevExportJob(wrapped, params)).resolves.toBe("abc-1");
    const odd = new FakeSevdeskClient([
      { method: "POST", path: DATEV_JOB_PATH, response: { body: { objects: "../etc/passwd" } } },
    ]);
    const error = await startDatevExportJob(odd, params).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "unexpected_response" });
    expect((error as Error).message).toContain(MAY_HAVE_STARTED);
  });
});

describe("waitForDatevExport", () => {
  it("follows the progress to the end and returns the download info", async () => {
    const running = { percent: 33, current: 33, errors: [], total: 100, failure: false };
    const done = { percent: 100, current: 100, errors: [], total: 100, failure: false };
    const client = new SequenceClient([routes.hash, routes.info], {
      [DATEV_PROGRESS_PATH]: [running, running, done],
    });
    const sleeps: number[] = [];
    const progress: [number, number | undefined, string][] = [];

    const info = await waitForDatevExport(client, JOB, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onProgress: (current, total, message) => {
        progress.push([current, total, message]);
      },
    });

    expect(info).toMatchObject({
      filename: "BITTE-ENTPACKEN_Buchungsstapel_1234567_12345_20260101_bis_20260331.zip",
      expires: "2026-11-15",
    });
    expect(info.link).toMatch(/^https:\/\/sevexport-filestorage-workload-prod\./);
    expect(sleeps).toEqual([1000, 2000]);
    expect(progress.at(-1)).toEqual([100, 100, "DATEV export: 100 of 100."]);
    expect(client.callsTo(DATEV_HASH_PATH)[0]?.query).toEqual({ jobId: JOB });
    expect(client.callsTo(DATEV_PROGRESS_PATH)[0]?.query).toEqual({ hash: HASH });
    expect(client.callsTo(DATEV_DOWNLOAD_INFO_PATH)[0]?.query).toEqual({ jobId: JOB });
  });

  it("skips progress it cannot read and polls the download info until it has a link", async () => {
    const notYet = new SevdeskError({ kind: "validation", message: "not ready" });
    const client = new SequenceClient([], {
      [DATEV_HASH_PATH]: [new SevdeskError({ kind: "server", message: "no hash" })],
      [DATEV_DOWNLOAD_INFO_PATH]: [notYet, { link: "" }, { link: " https://x/y ", filename: null }],
    });

    const info = await waitForDatevExport(client, JOB, { sleep: noSleep });

    expect(info).toEqual({ link: "https://x/y", filename: undefined, expires: undefined });
    expect(client.callsTo(DATEV_PROGRESS_PATH)).toEqual([]);
  });

  it("stops at an unreadable progress answer or one without a total", async () => {
    const unreadable = new SequenceClient([routes.hash, routes.info], {
      [DATEV_PROGRESS_PATH]: [new SevdeskError({ kind: "unexpected_response", message: "x" })],
    });
    await expect(waitForDatevExport(unreadable, JOB, { sleep: noSleep })).resolves.toMatchObject({
      filename: expect.any(String) as unknown,
    });
    const noTotal = new SequenceClient([routes.hash, routes.info], {
      [DATEV_PROGRESS_PATH]: [{ current: 0, total: 0 }],
    });
    await expect(waitForDatevExport(noTotal, JOB, { sleep: noSleep })).resolves.toBeDefined();
  });

  it.each([
    [{ current: 10, total: 100, failure: true }],
    [{ current: 10, total: 100, errors: ["Konto fehlt"] }],
    [{ current: 10, total: 100, errors: { account: "missing" } }],
    [{ current: 10, total: 100, failure: "yes" }],
  ])("fails the job when sevDesk reports a failure: %j", async (progress) => {
    const client = new SequenceClient([routes.hash], { [DATEV_PROGRESS_PATH]: [progress] });

    const promise = waitForDatevExport(client, JOB, { sleep: noSleep });

    await expect(promise).rejects.toMatchObject({ kind: "server" });
    await expect(promise).rejects.toThrow(`DATEV export job ${JOB} failed`);
  });

  it("gives up after the bounded wait with the job id, and on cancellation", async () => {
    const running = { current: 1, total: 100, errors: [], failure: "0" };
    const client = new SequenceClient([routes.hash], { [DATEV_PROGRESS_PATH]: [running] });
    const sleeps: number[] = [];

    await expect(
      waitForDatevExport(client, JOB, {
        maxWaitMs: 10_000,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(`job ${JOB} did not finish within 10 seconds`);
    expect(sleeps).toEqual([1000, 2000, 4000]);

    const stalled = new SequenceClient([], {
      [DATEV_HASH_PATH]: [{}],
      [DATEV_DOWNLOAD_INFO_PATH]: [{}],
    });
    await expect(
      waitForDatevExport(stalled, JOB, { sleep: () => Promise.reject(new Error("aborted")) }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rethrows auth failures and cancellations instead of polling on", async () => {
    const client = new SequenceClient([], {
      [DATEV_HASH_PATH]: [new SevdeskError({ kind: "auth", message: "token" })],
    });
    await expect(waitForDatevExport(client, JOB, { sleep: noSleep })).rejects.toMatchObject({
      kind: "auth",
    });
  });
});

describe("fiscalYearStartWithin", () => {
  it("finds a fiscal-year start inside the period", () => {
    expect(fiscalYearStartWithin("2026-01-01", "2026-12-31", "2026-01-01")).toBeUndefined();
    expect(fiscalYearStartWithin("2025-12-01", "2026-01-31", "2020-01-01")).toBe("2026-01-01");
    expect(fiscalYearStartWithin("2026-01-01", "2026-12-31", "2019-07-01")).toBe("2026-07-01");
    expect(fiscalYearStartWithin("2026-07-01", "2027-06-30", "2019-07-01")).toBeUndefined();
    expect(fiscalYearStartWithin("2026-03-01", "2026-03-31", "2019-07-01")).toBeUndefined();
  });
});

describe("files", () => {
  it("recognizes ZIP archives by their magic", () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(looksLikeZip(new TextEncoder().encode("<Error/>"))).toBe(false);
  });

  it("names files safely from sevDesk's name or our own", () => {
    const fallback = datevFilename({ from: "2026-01-01", to: "2026-03-31", scope: ["earnings"] });
    expect(fallback).toBe("DATEV_2026-01-01_2026-03-31_E.zip");
    expect(
      exportFilename("BITTE-ENTPACKEN_Buchungsstapel_1_2_20260101_bis_20260331.zip", fallback),
    ).toBe("BITTE-ENTPACKEN_Buchungsstapel_1_2_20260101_bis_20260331.zip");
    expect(exportFilename("../../etc/passwd", fallback)).toBe("passwd.zip");
    expect(exportFilename("..\\..\\Ünïcødé name.ZIP", fallback)).toBe("Unic_de_name.zip");
    expect(exportFilename("...", fallback)).toBe(fallback);
    expect(exportFilename(undefined, fallback)).toBe(fallback);
    expect(exportFilename("CON.zip", fallback)).toBe(fallback);
    expect(exportFilename(`${"a".repeat(300)}.zip`, fallback)).toHaveLength(150);
  });
});
