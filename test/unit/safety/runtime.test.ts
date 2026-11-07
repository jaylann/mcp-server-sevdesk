import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_TTL_SECONDS,
  type ConfirmState,
  confirmStateSchema,
  createSafetyRuntime,
} from "../../../src/safety/runtime.js";
import { decideInBrowser } from "../../helpers/approval-browser.js";
import { testConfig } from "../../helpers/config.js";

afterEach(() => {
  vi.useRealTimers();
});

function ctx(method = "tools/call", clientId?: string): ServerContext {
  return {
    mcpReq: { method },
    ...(clientId === undefined ? {} : { http: { authInfo: { clientId } } }),
  } as unknown as ServerContext;
}

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

    const ticket = await runtime.approvals.create(APPROVAL);
    await runtime.close();

    expect(urls).toHaveLength(calls);
    expect(ticket.opened).toBe(calls === 1);
  });

  it("writes approval-page decisions to the audit log, and reports a failed line on stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-runtime-"));
    try {
      const path = join(dir, "audit.jsonl");
      const runtime = createSafetyRuntime(testConfig({ auditLogPath: path }), {
        log: () => undefined,
      });
      const ticket = await runtime.approvals.create(APPROVAL);
      await decideInBrowser(ticket.url, "reject");
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
      const broken = createSafetyRuntime(testConfig({ auditLogPath: dir }), {
        log: () => undefined,
      });
      const second = await broken.approvals.create(APPROVAL);
      await decideInBrowser(second.url, "approve");
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

  it("closes the approval server", async () => {
    const runtime = createSafetyRuntime(testConfig(), { log: () => undefined });
    await runtime.approvals.create(APPROVAL);

    await runtime.close();

    expect(runtime.approvals.current("sevdesk_dummy_finalize", "a")).toBeUndefined();
  });
});
