import { afterEach, describe, expect, it } from "vitest";

import { createSandbox, type Sandbox } from "../../../scripts/lib/approvals-sandbox.js";
import { decideInBrowser } from "../../helpers/approval-browser.js";

const LAUNCH_LINK = /http:\/\/127\.0\.0\.1:\d+\/open\/[A-Za-z0-9_-]{43}/;
const MINUTE = 60_000;

let sandbox: Sandbox | undefined;
afterEach(async () => {
  await sandbox?.close();
  sandbox = undefined;
});

function start(): { sandbox: Sandbox; log: string[]; opened: string[] } {
  const log: string[] = [];
  const opened: string[] = [];
  sandbox = createSandbox({
    open: true,
    log: (line) => log.push(line),
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
  });
  return { sandbox, log, opened };
}

/** The launch link the approval page logged for `reference`. */
function linkFor(log: readonly string[], reference: string | undefined): string {
  const line = log.findLast((entry) => reference !== undefined && entry.includes(reference));
  const link = LAUNCH_LINK.exec(line ?? "")?.[0];
  if (link === undefined) throw new Error(`no approval link for ${String(reference)}`);
  return link;
}

describe("approvals sandbox", () => {
  it("asks for approval through the real local page, with the link only in the log", async () => {
    const { sandbox, log, opened } = start();
    expect(sandbox.tasks).toBeGreaterThanOrEqual(10);

    const first = await sandbox.request();
    expect(first).toMatchObject({ tool: "sevdesk_invoice_finalize", status: "approval_pending" });
    expect(first.reference).toMatch(/^[A-Z2-9]{6}$/);
    expect(first.summary).not.toMatch(LAUNCH_LINK);
    expect(opened).toEqual([linkFor(log, first.reference)]);
    expect(sandbox.waiting()).toEqual([first]);
  });

  it("refuses the network while it runs, and gives it back when it closes", async () => {
    const realFetch = globalThis.fetch;
    const { sandbox } = start();
    await expect(fetch("https://my.sevdesk.de/api/v1/Invoice")).rejects.toThrow(
      "nothing leaves this machine",
    );
    await sandbox.close();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("runs an approved call when the assistant retries, and declines a rejected one", async () => {
    const { sandbox, log } = start();
    const approved = await sandbox.request();
    const rejected = await sandbox.request();
    expect(rejected.tool).not.toBe(approved.tool);

    expect((await decideInBrowser(linkFor(log, approved.reference), "approve")).status).toBe(200);
    expect((await decideInBrowser(linkFor(log, rejected.reference), "reject")).status).toBe(200);

    const retried = await sandbox.retryWaiting();
    expect(retried.map((outcome) => [outcome.tool, outcome.status])).toEqual([
      [approved.tool, "done"],
      [rejected.tool, "declined"],
    ]);
    expect(sandbox.waiting()).toEqual([]);
  });

  it("asks again after the stored record changed", async () => {
    const { sandbox } = start();
    const first = await sandbox.request();
    const changed = await sandbox.changeNewest();
    expect(changed).toMatchObject({ tool: first.tool, status: "approval_pending" });
    expect(changed?.reference).not.toBe(first.reference);
    expect(changed?.summary).toMatch(/^The record changed/);
  });

  it("lets waiting requests expire when the clock moves on", async () => {
    const { sandbox } = start();
    const first = await sandbox.request();
    sandbox.skip(10 * MINUTE + 1000);
    const [again] = await sandbox.retryWaiting();
    expect(again).toMatchObject({ tool: first.tool, status: "approval_pending" });
    expect(again?.reference).not.toBe(first.reference);
  });

  it("reports the limit of waiting requests as the assistant would see it", async () => {
    const { sandbox } = start();
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await sandbox.request());
    expect(outcomes.slice(0, 5).every((outcome) => outcome.status === "approval_pending")).toBe(
      true,
    );
    expect(outcomes[5]?.status).toBe("error");
    expect(sandbox.waiting()).toHaveLength(5);
  });
});
