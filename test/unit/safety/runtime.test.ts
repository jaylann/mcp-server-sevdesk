import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GRANT_EXTRA_KEY,
  type RequestPrincipal,
  VerifiedGrant,
} from "../../../src/accounts/types.js";
import type { ApprovalChannel, ApprovalView } from "../../../src/safety/approval-types.js";
import {
  CONFIRMATION_TTL_SECONDS,
  type ConfirmState,
  confirmStateSchema,
  createSafetyRuntime,
} from "../../../src/safety/runtime.js";
import { decideInBrowser } from "../../helpers/approval-browser.js";
import { TEST_TOKEN, testConfig } from "../../helpers/config.js";

afterEach(() => {
  vi.useRealTimers();
});

function ctx(method = "tools/call", clientId?: string, grant?: VerifiedGrant): ServerContext {
  const authInfo: Partial<AuthInfo> | undefined =
    clientId === undefined
      ? undefined
      : { clientId, ...(grant === undefined ? {} : { extra: { [GRANT_EXTRA_KEY]: grant } }) };
  return {
    mcpReq: { method },
    ...(authInfo === undefined ? {} : { http: { authInfo } }),
  } as unknown as ServerContext;
}

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";

function grant(grantId: string, accountId: string): VerifiedGrant {
  return new VerifiedGrant(
    { grantId, accountId, clientId: CLIENT, tiers: new Set(["read", "commit"]) },
    TEST_TOKEN,
  );
}

const STDIO: RequestPrincipal = { grantKey: "stdio", accountScope: "local" };
const PAGE_URL = /http:\/\/127\.0\.0\.1:\d+\/open\/[A-Za-z0-9_-]{43}/;

const STATE: ConfirmState = {
  v: 1,
  tool: "sevdesk_invoice_finalize",
  argsHash: "a".repeat(64),
  previewHash: "p".repeat(64),
  nonce: "n",
  callId: "c",
};

describe("safety runtime: request-state codec", () => {
  it("round-trips the confirmation state and the schema accepts it", async () => {
    const runtime = createSafetyRuntime(testConfig());

    const sealed = await runtime.codec.mint(STATE, ctx());
    const opened = await runtime.codec.verify(sealed, ctx());

    expect(sealed).toMatch(/^v1\./);
    expect(opened).toEqual(STATE);
    expect(confirmStateSchema.parse(opened)).toEqual(STATE);
  });

  it("refuses a tampered state", async () => {
    const runtime = createSafetyRuntime(testConfig());
    const sealed = await runtime.codec.mint(STATE, ctx());
    const [version, body, mac] = sealed.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()),
        p: { ...STATE, argsHash: "b".repeat(64) },
      }),
    ).toString("base64url");

    await expect(
      runtime.codec.verify(`${version ?? ""}.${forged}.${mac ?? ""}`, ctx()),
    ).rejects.toThrow();
  });

  it("refuses a state minted by another runtime (each has its own random key)", async () => {
    const sealed = await createSafetyRuntime(testConfig()).codec.mint(STATE, ctx());

    await expect(createSafetyRuntime(testConfig()).codec.verify(sealed, ctx())).rejects.toThrow();
  });

  it("binds the state to the method and the authenticated client", async () => {
    const runtime = createSafetyRuntime(testConfig());
    const sealed = await runtime.codec.mint(STATE, ctx("tools/call", "client-a"));

    await expect(runtime.codec.verify(sealed, ctx("tools/call", "client-a"))).resolves.toEqual(
      STATE,
    );
    await expect(runtime.codec.verify(sealed, ctx("tools/call", "client-b"))).rejects.toThrow();
    await expect(runtime.codec.verify(sealed, ctx("prompts/get", "client-a"))).rejects.toThrow();
  });

  it("binds the state to the grant and the account, not only the OAuth client", async () => {
    const runtime = createSafetyRuntime(testConfig());
    const a1 = grant("grant-a1", "1001");
    const sealed = await runtime.codec.mint(STATE, ctx("tools/call", CLIENT, a1));

    await expect(runtime.codec.verify(sealed, ctx("tools/call", CLIENT, a1))).resolves.toEqual(
      STATE,
    );
    // Another user of the same OAuth client (claude.ai), another grant of the same account, and
    // a request without a grant are all refused.
    await expect(
      runtime.codec.verify(sealed, ctx("tools/call", CLIENT, grant("grant-b", "2002"))),
    ).rejects.toThrow();
    await expect(
      runtime.codec.verify(sealed, ctx("tools/call", CLIENT, grant("grant-a2", "1001"))),
    ).rejects.toThrow();
    await expect(runtime.codec.verify(sealed, ctx("tools/call", CLIENT))).rejects.toThrow();
  });

  it(`expires a state after ${CONFIRMATION_TTL_SECONDS} seconds`, async () => {
    vi.useFakeTimers({ now: new Date("2026-11-07T20:00:00Z") });
    const runtime = createSafetyRuntime(testConfig());
    const sealed = await runtime.codec.mint(STATE, ctx());

    vi.setSystemTime(new Date("2026-11-07T20:09:59Z"));
    await expect(runtime.codec.verify(sealed, ctx())).resolves.toEqual(STATE);
    vi.setSystemTime(new Date("2026-11-07T20:10:01Z"));
    await expect(runtime.codec.verify(sealed, ctx())).rejects.toThrow();
  });
});

const APPROVAL = {
  toolName: "sevdesk_dummy_finalize",
  toolTitle: "Finalize",
  tier: "commit",
  tierText: "legally binding bookkeeping",
  argsHash: "a",
  previewHash: "p",
  preview: { action: "A.", facts: [], warnings: [], irreversible: false },
  callId: "c",
} as const;

describe("safety runtime: parts", () => {
  it("has a nonce store with the confirmation lifetime", () => {
    let now = 0;
    const runtime = createSafetyRuntime(testConfig(), { now: () => now });
    const nonce = runtime.nonces.issue();

    now = CONFIRMATION_TTL_SECONDS * 1000;
    expect(runtime.nonces.consume(nonce)).toBe(false);
  });

  it("enables the audit log only with a path", () => {
    expect(createSafetyRuntime(testConfig()).audit.enabled).toBe(false);
    expect(createSafetyRuntime(testConfig({ auditLogPath: "/tmp/x.jsonl" })).audit.enabled).toBe(
      true,
    );
  });

  it.each([
    [true, 1],
    [false, 0],
  ] as const)("uses the opener only when confirmOpen is %s", async (confirmOpen, calls) => {
    const urls: string[] = [];
    const runtime = createSafetyRuntime(testConfig({ confirmOpen }), {
      log: () => undefined,
      openUrl: (url) => {
        urls.push(url);
        return Promise.resolve(true);
      },
    });

    const ticket = await runtime.approvals.create(STDIO, APPROVAL);
    await runtime.close();

    expect(urls).toHaveLength(calls);
    expect(ticket.opened).toBe(calls === 1);
  });

  it("presents approvals through an injected channel instead of the local page", async () => {
    const presented: ApprovalView[] = [];
    const close = vi.fn(() => Promise.resolve());
    const channel: ApprovalChannel = {
      kind: "remote",
      inboxUrl: "https://mcp.example.com/approvals",
      attach: () => undefined,
      present: (view) => {
        presented.push(view);
        return Promise.resolve({ opened: false });
      },
      close: () => close(),
    };
    const log = vi.fn();
    const openUrl = vi.fn(() => Promise.resolve(true));
    const runtime = createSafetyRuntime(testConfig({ confirmOpen: true }), {
      approvalChannel: channel,
      log,
      openUrl,
    });
    const owner = { grantKey: "grant-a1", accountScope: "1001" };

    const ticket = await runtime.approvals.create(owner, APPROVAL);
    await runtime.close();

    expect(presented).toMatchObject([{ id: ticket.id, owner }]);
    expect(log).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("writes approval-page decisions to the audit log, and reports a failed line on stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-runtime-"));
    try {
      const path = join(dir, "audit.jsonl");
      const lines: string[] = [];
      const runtime = createSafetyRuntime(testConfig({ auditLogPath: path }), {
        log: (line) => lines.push(line),
      });
      const ticket = await runtime.approvals.create(STDIO, APPROVAL);
      await decideInBrowser(PAGE_URL.exec(lines[0] ?? "")?.[0] ?? "", "reject");
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
          event: "approval_decided",
          decision: "rejected",
          reference: ticket.reference,
          callId: "c",
          tool: "sevdesk_dummy_finalize",
        });
      });
      await runtime.close();

      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const brokenLines: string[] = [];
      const broken = createSafetyRuntime(testConfig({ auditLogPath: dir }), {
        log: (line) => brokenLines.push(line),
      });
      await broken.approvals.create(STDIO, APPROVAL);
      await decideInBrowser(PAGE_URL.exec(brokenLines[0] ?? "")?.[0] ?? "", "approve");
      await vi.waitFor(() => {
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining("could not write the approval_decided line"),
        );
      });
      await broken.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names account and grant on decisions over HTTP, and redacts each event's secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-runtime-"));
    try {
      const path = join(dir, "audit.jsonl");
      let decide: ((id: string) => void) | undefined;
      const channel: ApprovalChannel = {
        kind: "remote",
        inboxUrl: "https://mcp.example.com/approvals",
        attach: (store) => {
          decide = (id) => store.decide(id, "approved");
        },
        present: () => Promise.resolve({ opened: false }),
        close: () => Promise.resolve(),
      };
      // OAuth mode: the runtime is built from the settings, without a token of its own.
      const {
        token: _token,
        account: _account,
        deployment: _deployment,
        ...settings
      } = testConfig({ auditLogPath: path });
      const runtime = createSafetyRuntime(settings, { approvalChannel: channel });
      const owner = { grantKey: "grant-a1", accountScope: "1001" };
      const ticket = await runtime.approvals.create(owner, APPROVAL);

      decide?.(ticket.id);
      await runtime.audit.record({
        event: "executing",
        account: "1001",
        grant: "grant-a1",
        callId: "c",
        tool: "sevdesk_dummy_finalize",
        tier: "commit",
        argsHash: "a",
        args: { note: `token ${TEST_TOKEN}` },
        approval: "browser",
        secrets: [TEST_TOKEN],
      });

      await vi.waitFor(async () => {
        const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
        expect(lines).toHaveLength(2);
      });
      const text = await readFile(path, "utf8");
      const [decided, executing] = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(decided).toMatchObject({
        event: "approval_decided",
        account: "1001",
        grant: "grant-a1",
        decision: "approved",
      });
      expect(executing).toMatchObject({ account: "1001", grant: "grant-a1" });
      expect(text).not.toContain(TEST_TOKEN);
      expect(text).toContain("token [REDACTED]");
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes the approval server", async () => {
    const runtime = createSafetyRuntime(testConfig(), { log: () => undefined });
    await runtime.approvals.create(STDIO, APPROVAL);

    await runtime.close();

    expect(runtime.approvals.current(STDIO, "sevdesk_dummy_finalize", "a")).toBeUndefined();
  });
});
