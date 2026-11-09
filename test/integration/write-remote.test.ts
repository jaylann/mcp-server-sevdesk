/**
 * The write flow over HTTP (`config.deployment.kind === "http"`): browser approvals go to the
 * approvals inbox and are owned by the caller's grant and account, and the texts name the inbox
 * and the server's settings instead of the local page and the MCP client configuration. The
 * stdio wording is covered (unchanged) by the other write-flow tests.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalChannel, ApprovalView } from "../../src/safety/approval-types.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { createDummyTools, dummyInvoiceBody } from "../helpers/dummy-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  grantAuthInfo,
  httpDeployment,
  resultData,
  resultSummary,
  resultText,
  writeHarness,
  type WriteHarnessOptions,
  writesOf,
} from "../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const A = grantAuthInfo({ accountId: "1001", token: TOKEN_A, grantId: "grant-a" });

function dummy(name: string): AnyToolDefinition {
  return createDummyTools().tools.find((tool) => tool.name === name)!;
}

const routes: FakeRoute[] = [
  { path: "/Invoice/7", response: { body: dummyInvoiceBody() } },
  { method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: { id: "7" } } } },
];

function inboxChannel(): ApprovalChannel & { readonly views: ApprovalView[] } {
  const views: ApprovalView[] = [];
  return {
    kind: "remote",
    inboxUrl: "https://mcp.example.com/approvals",
    views,
    attach: () => undefined,
    present: (view) => {
      views.push(view);
      return Promise.resolve({ opened: false });
    },
    close: () => Promise.resolve(),
  };
}

function remote(options: Partial<WriteHarnessOptions> = {}) {
  const channel = inboxChannel();
  return {
    channel,
    harness: writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes,
      ...options,
      config: { deployment: httpDeployment("oauth"), confirm: "browser", ...options.config },
      safetyOptions: { approvalChannel: channel, ...options.safetyOptions },
      connect: { authInfo: A, ...options.connect },
    }),
  };
}

describe("browser approvals over HTTP", () => {
  it("names the inbox and the reference, for the user to sign in and decide", async () => {
    const { channel, harness } = remote();
    const { client, fake, approvalLog, openedUrls } = await harness;

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    const data = resultData(result);
    const { reference, expiresAt, opened } = data["approval"] as {
      reference: string;
      expiresAt: string;
      opened: boolean;
    };
    expect(data["status"]).toBe("approval_pending");
    expect(opened).toBe(false);
    expect(resultSummary(result as never)).toBe(
      "Nothing has been changed yet. The user must approve or reject this request in the " +
        `approvals inbox (reference ${reference}). Ask the user to open ` +
        "https://mcp.example.com/approvals, sign in there and decide, then call " +
        `sevdesk_dummy_finalize again with exactly the same arguments before ${expiresAt}.`,
    );
    expect(channel.views).toMatchObject([
      { reference, owner: { grantKey: "grant-a", accountScope: "1001" } },
    ]);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain(TOKEN_A);
    expect(approvalLog).toEqual([]);
    expect(openedUrls).toEqual([]);
    expect(writesOf(fake)).toEqual([]);
  });

  it("scopes bearer-mode approvals to the configured account", async () => {
    const { channel, harness } = remote({
      config: { deployment: httpDeployment("bearer"), account: { id: "1001" } },
      connect: { authInfo: { token: "x", clientId: "bearer", scopes: [] } },
    });
    const { client } = await harness;

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(channel.views[0]?.owner).toEqual({ grantKey: "bearer", accountScope: "1001" });
  });

  it("names the inbox when too many approvals wait", async () => {
    const { harness } = remote();
    const { client, safety } = await harness;
    for (const argsHash of ["1", "2", "3", "4", "5"]) {
      await safety.approvals.create(
        { grantKey: "grant-a", accountScope: "1001" },
        {
          toolName: "sevdesk_dummy_finalize",
          toolTitle: "Finalize",
          tier: "commit",
          tierText: "legally binding bookkeeping",
          argsHash,
          previewHash: "p",
          preview: { action: "A.", facts: [], warnings: [], irreversible: false },
          callId: "c",
        },
      );
    }

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    expect(resultText(result as never)).toContain(
      "5 approval requests are already waiting in the approvals inbox " +
        "(https://mcp.example.com/approvals).",
    );
  });

  it("says when the approval request could not be created", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { harness } = remote();
    const { client, safety, fake } = await harness;
    vi.spyOn(safety.approvals, "create").mockRejectedValue(new Error("inbox down"));

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    expect(resultText(result as never)).toContain(
      "the approval request could not be created (see the server log). Nothing was sent to sevDesk.",
    );
    expect(resultText(result as never)).not.toContain("local approval page");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not be created: Error"));
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("elicitation over HTTP", () => {
  it("points a client that cannot be asked to SEVDESK_CONFIRM=browser and the inbox", async () => {
    const { harness } = remote({
      config: { confirm: "elicit", deployment: httpDeployment("oauth", undefined) },
      connect: { elicitation: false },
    });
    const { client, fake } = await harness;

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    expect(resultText(result as never)).toBe(
      "sevdesk_dummy_finalize needs the user's approval, but this MCP client cannot be asked for " +
        "it here (it does not support MCP elicitation, or not over this HTTP connection). Nothing " +
        "was sent to sevDesk. Tell the user: to use this tool, the server's operator can set " +
        "SEVDESK_CONFIRM=browser and restart the server; the user then approves each such action " +
        "in the approvals inbox (https://mcp.example.com/approvals) after signing in there. " +
        "dryRun: true still previews the change.",
    );
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("audit log over HTTP", () => {
  async function auditDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-write-remote-"));
    dirs.push(dir);
    return dir;
  }

  it("asks the server's operator when the audit log cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = await auditDir();
    await mkdir(join(dir, "audit.jsonl"));
    const { harness } = remote({
      config: { confirm: "off", auditLogPath: join(dir, "audit.jsonl") },
    });
    const { client, fake } = await harness;

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBe(true);
    expect(resultText(result as never)).toContain(
      "Ask the server's operator to check the audit log path and its permissions.",
    );
    expect(writesOf(fake)).toEqual([]);
  });

  it("names account and grant over HTTP, but not over stdio", async () => {
    const dir = await auditDir();
    const httpPath = join(dir, "http.jsonl");
    const stdioPath = join(dir, "stdio.jsonl");
    const { harness } = remote({ config: { confirm: "off", auditLogPath: httpPath } });
    const viaHttp = await harness;
    const viaStdio = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes,
      config: { confirm: "off", auditLogPath: stdioPath },
    });

    for (const { client } of [viaHttp, viaStdio]) {
      await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });
    }

    const read = async (path: string) =>
      (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of await read(httpPath)) {
      expect(line).toMatchObject({ account: "1001", grant: "grant-a" });
    }
    for (const line of await read(stdioPath)) {
      expect(line).not.toHaveProperty("account");
      expect(line).not.toHaveProperty("grant");
    }
  });
});
