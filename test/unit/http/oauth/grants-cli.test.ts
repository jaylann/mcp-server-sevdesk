import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGrantsCommand } from "../../../../src/grants-cli.js";
import { GRANTS_FILE, openGrantStore } from "../../../../src/http/oauth/grant-store.js";
import type { GrantStore } from "../../../../src/http/types.js";
import { fakeClock } from "../../../helpers/oauth-browser.js";

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
let dir: string;
let server: GrantStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdmcp-grants-cli-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

function io(now?: () => number) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      ...(now === undefined ? {} : { now }),
    },
  };
}

async function seed(clock = fakeClock(Date.UTC(2026, 10, 9, 12, 0))) {
  server = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
  const a = await server.createPending({
    accountId: "4711",
    clientId: CLIENT,
    clientHost: "claude.ai",
    tiers: ["read", "write"],
    ttlSeconds: 90 * 86_400,
  });
  await server.activate(a.gid, "jti-0000000001");
  clock.advance(60_000);
  await server.rotate(a.gid, 1);
  const b = await server.createPending({
    accountId: "4711",
    clientId: CLIENT,
    clientHost: "claude.ai",
    tiers: ["read"],
    ttlSeconds: 90 * 86_400,
  });
  await server.activate(b.gid, "jti-0000000002");
  const c = await server.createPending({
    accountId: "5000",
    clientId: CLIENT,
    clientHost: "claude.ai",
    tiers: ["read"],
    ttlSeconds: 60,
  });
  await server.activate(c.gid, "jti-0000000003");
  return { clock, a, b, c };
}

describe("grants list", () => {
  it("lists grants as a table, newest first, with status and last refresh", async () => {
    const { clock, a, c } = await seed();
    clock.advance(120_000);
    const result = io(clock.now);
    await expect(
      runGrantsCommand(
        { kind: "grants-list", json: false },
        { SEVDESK_HTTP_STATE_DIR: dir },
        result.io,
      ),
    ).resolves.toBe(0);
    const lines = result.out.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^GRANT\s+ACCOUNT\s+CLIENT\s+TIERS\s+STATUS\s+CREATED\s+EXPIRES\s+LAST REFRESH$/,
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain(a.gid);
    expect(lines[3]).toMatch(
      /4711\s+claude\.ai\/oauth\/mcp-oauth-client-metadata\s+read,write\s+active\s+2026-11-09 12:00\s+2027-02-07 12:00\s+2026-11-09 12:01$/,
    );
    expect(lines.find((line) => line.includes(c.gid))).toMatch(/expired/);
  });

  it("lists grants as JSON", async () => {
    const { a } = await seed();
    const result = io();
    await runGrantsCommand(
      { kind: "grants-list", json: true },
      { SEVDESK_HTTP_STATE_DIR: dir },
      result.io,
    );
    const rows = JSON.parse(result.out.join("")) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row["id"] === a.gid)).toEqual({
      id: a.gid,
      account: "4711",
      client: CLIENT,
      clientHost: "claude.ai",
      tiers: ["read", "write"],
      status: "active",
      reason: null,
      createdAt: "2026-11-09T12:00:00.000Z",
      expiresAt: "2027-02-07T12:00:00.000Z",
      lastRefreshAt: "2026-11-09T12:01:00.000Z",
      revokedAt: null,
    });
  });

  it("says when there are no grants", async () => {
    const result = io();
    await runGrantsCommand(
      { kind: "grants-list", json: false },
      { SEVDESK_HTTP_STATE_DIR: dir },
      result.io,
    );
    expect(result.out.join("")).toBe("No grants.\n");
  });
});

describe("grants revoke", () => {
  it("revokes one grant while the server runs; the server sees it on sync", async () => {
    const { clock, a } = await seed();
    const result = io(clock.now);
    await expect(
      runGrantsCommand(
        { kind: "grants-revoke", target: { grantId: a.gid } },
        { SEVDESK_HTTP_STATE_DIR: dir },
        result.io,
      ),
    ).resolves.toBe(0);
    expect(result.out.join("")).toContain(`Revoked grant ${a.gid}.`);
    await server?.sync(true);
    expect(server?.get(a.gid)).toMatchObject({ status: "revoked", reason: "operator" });

    const again = io(clock.now);
    await runGrantsCommand(
      { kind: "grants-revoke", target: { grantId: a.gid } },
      { SEVDESK_HTTP_STATE_DIR: dir },
      again.io,
    );
    expect(again.out.join("")).toContain("already revoked");
    const list = io(clock.now);
    await runGrantsCommand(
      { kind: "grants-list", json: false },
      { SEVDESK_HTTP_STATE_DIR: dir },
      list.io,
    );
    expect(list.out.join("")).toContain("revoked (operator)");
  });

  it("revokes every grant of an account, or all", async () => {
    const { b, c } = await seed();
    const account = io();
    await runGrantsCommand(
      { kind: "grants-revoke", target: { accountId: "4711" } },
      { SEVDESK_HTTP_STATE_DIR: dir },
      account.io,
    );
    expect(account.out.join("")).toBe(
      "Revoked 2 active grants of account 4711. Their clients are signed out on their next request.\n",
    );
    await server?.sync(true);
    expect(server?.get(b.gid)?.status).toBe("revoked");
    expect(server?.get(c.gid)?.status).toBe("active");

    const none = io();
    await runGrantsCommand(
      { kind: "grants-revoke", target: { accountId: "4711" } },
      { SEVDESK_HTTP_STATE_DIR: dir },
      none.io,
    );
    expect(none.out.join("")).toBe("No active grants of account 4711.\n");

    const all = io();
    await runGrantsCommand(
      { kind: "grants-revoke", target: { all: true } },
      { SEVDESK_HTTP_STATE_DIR: dir },
      all.io,
    );
    expect(all.out.join("")).toMatch(/^Revoked 1 active grant\. /);
  });

  it("fails for an unknown grant id", async () => {
    await seed();
    const result = io();
    await expect(
      runGrantsCommand(
        { kind: "grants-revoke", target: { grantId: "nope" } },
        { SEVDESK_HTTP_STATE_DIR: dir },
        result.io,
      ),
    ).resolves.toBe(1);
    expect(result.err.join("")).toContain("no grant nope");
  });
});

describe("grants command errors", () => {
  it("needs an absolute state directory", async () => {
    for (const env of [{}, { SEVDESK_HTTP_STATE_DIR: "relative/dir" }]) {
      const result = io();
      await expect(
        runGrantsCommand({ kind: "grants-list", json: false }, env, result.io),
      ).resolves.toBe(1);
      expect(result.err.join("")).toContain("SEVDESK_HTTP_STATE_DIR");
    }
  });

  it("reports a corrupt store without a stack trace", async () => {
    await writeFile(join(dir, GRANTS_FILE), "garbage\n");
    const result = io();
    await expect(
      runGrantsCommand(
        { kind: "grants-list", json: false },
        { SEVDESK_HTTP_STATE_DIR: dir },
        result.io,
      ),
    ).resolves.toBe(1);
    expect(result.err.join("")).toMatch(/^grants: grants\.jsonl line 1 is not a valid/);
  });

  it("writes to stdout by default", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await runGrantsCommand({ kind: "grants-list", json: false }, { SEVDESK_HTTP_STATE_DIR: dir });
    expect(writes.join("")).toBe("No grants.\n");
  });
});
