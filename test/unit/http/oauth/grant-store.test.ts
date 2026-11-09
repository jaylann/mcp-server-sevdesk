import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GrantLimitError,
  GRANTS_FILE,
  LOCK_FILE,
  openGrantStore,
  StateDirError,
} from "../../../../src/http/oauth/grant-store.js";
import type { GrantStore } from "../../../../src/http/types.js";
import { captureLog, fakeClock } from "../../../helpers/oauth-browser.js";

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const DAY = 86_400;

function pending(store: GrantStore, accountId = "4711", ttlSeconds = 90 * DAY) {
  return store.createPending({
    accountId,
    clientId: CLIENT,
    clientHost: "claude.ai",
    tiers: ["write", "read"],
    ttlSeconds,
  });
}

let dir: string;
const open: GrantStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdmcp-grants-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
  await rm(dir, { recursive: true, force: true });
});

async function server(options: Parameters<typeof openGrantStore>[0]): Promise<GrantStore> {
  const store = await openGrantStore({ heartbeatMs: 0, ...options });
  open.push(store);
  return store;
}

describe("grant lifecycle (memory)", () => {
  it("activates a pending grant once; a second code exchange is a replay that revokes it", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const grant = await pending(store);
    expect(grant).toMatchObject({ status: "pending", gen: 0, tiers: ["read", "write"] });
    expect(grant.gid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(store.activate(grant.gid, "jti-0000000001")).resolves.toBe("activated");
    expect(store.get(grant.gid)).toMatchObject({ status: "active", gen: 1 });
    await expect(store.activate(grant.gid, "jti-0000000001")).resolves.toBe("replay");
    expect(store.get(grant.gid)).toMatchObject({ status: "revoked", reason: "code_replay" });
    await expect(store.activate(grant.gid, "jti-0000000001")).resolves.toBe("replay");
    await expect(store.activate("unknown-grant-id", "jti-0000000001")).resolves.toBe("unknown");
  });

  it("refuses to activate an expired grant", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const grant = await pending(store, "4711", 60);
    clock.advance(61_000);
    await expect(store.activate(grant.gid, "jti-0000000001")).resolves.toBe("unknown");
  });

  it("rotates refresh generations with a 30 s grace for the previous one", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const grant = await pending(store);
    await expect(store.rotate(grant.gid, 1)).resolves.toEqual({ ok: false, reason: "unknown" });
    await store.activate(grant.gid, "jti-0000000001");
    await expect(store.rotate(grant.gid, 1)).resolves.toEqual({ ok: true, gen: 2 });
    // A concurrent refresh with the previous generation, within the grace: same generation.
    clock.advance(30_000);
    await expect(store.rotate(grant.gid, 1)).resolves.toEqual({ ok: true, gen: 2 });
    expect(store.get(grant.gid)?.gen).toBe(2);
    await expect(store.rotate(grant.gid, 2)).resolves.toEqual({ ok: true, gen: 3 });
    clock.advance(31_000);
    await expect(store.rotate(grant.gid, 2)).resolves.toEqual({ ok: false, reason: "replay" });
    expect(store.get(grant.gid)).toMatchObject({ status: "revoked", reason: "refresh_replay" });
    await expect(store.rotate(grant.gid, 3)).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("treats an older or future generation as a replay", async () => {
    const store = await server({ stateDir: undefined });
    const a = await pending(store);
    await store.activate(a.gid, "jti-0000000001");
    await store.rotate(a.gid, 1);
    await store.rotate(a.gid, 2);
    await expect(store.rotate(a.gid, 1)).resolves.toEqual({ ok: false, reason: "replay" });
    const b = await pending(store);
    await store.activate(b.gid, "jti-0000000002");
    await expect(store.rotate(b.gid, 7)).resolves.toEqual({ ok: false, reason: "replay" });
    await expect(store.rotate("nope-nope-nope", 1)).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("reports expired grants on rotation", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const grant = await pending(store, "4711", DAY);
    await store.activate(grant.gid, "jti-0000000001");
    clock.advance(DAY * 1000);
    await expect(store.rotate(grant.gid, 1)).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("revokes grants with their sessions, per grant and per account", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const a = await pending(store);
    await store.activate(a.gid, "jti-0000000001");
    clock.advance(1000);
    const b = await pending(store);
    const other = await pending(store, "9999");
    await store.activate(other.gid, "jti-0000000003");
    const sessionA = await store.createSession({
      accountId: "4711",
      gid: a.gid,
      via: "consent",
      ttlSeconds: 3600,
    });
    const tokenSession = await store.createSession({
      accountId: "4711",
      via: "token",
      ttlSeconds: 3600,
    });
    expect(store.getSession(sessionA.sid)).toMatchObject({
      accountId: "4711",
      gid: a.gid,
      via: "consent",
    });

    // Newest first.
    const listed = store.list().map((grant) => grant.gid);
    expect(new Set(listed.slice(0, 2))).toEqual(new Set([b.gid, other.gid]));
    expect(listed[2]).toBe(a.gid);

    await expect(store.revoke(a.gid, "user")).resolves.toBe(true);
    expect(store.getSession(sessionA.sid)).toBeUndefined();
    expect(store.getSession(tokenSession.sid)).toBeDefined();
    await expect(store.revoke("missing-grant-id", "user")).resolves.toBe(false);

    // One active (other is a different account), b is pending: counts active ones only.
    await expect(store.revokeAccount("4711", "operator")).resolves.toBe(0);
    expect(store.get(b.gid)).toMatchObject({ status: "revoked", reason: "operator" });
    expect(store.getSession(tokenSession.sid)).toBeUndefined();
    await expect(store.revokeAccount("9999", "operator")).resolves.toBe(1);
  });

  it("ends sessions at expiry, on revocation and with an expired grant", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now });
    const grant = await pending(store, "4711", 7200);
    const session = await store.createSession({
      accountId: "4711",
      gid: grant.gid,
      via: "consent",
      ttlSeconds: 43_200,
    });
    const other = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 60 });
    await store.revokeSession(other.sid);
    expect(store.getSession(other.sid)).toBeUndefined();
    await store.revokeSession("missing-session");
    clock.advance(7200_000);
    expect(store.getSession(session.sid)).toBeUndefined();
    expect(store.getSession("missing-session")).toBeUndefined();
    const lone = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 60 });
    clock.advance(60_000);
    expect(store.getSession(lone.sid)).toBeUndefined();
  });

  it("caps grants (refusing new consents) and sessions (ending the oldest)", async () => {
    const clock = fakeClock();
    const store = await server({
      stateDir: undefined,
      now: clock.now,
      maxGrants: 2,
      maxSessions: 2,
    });
    const a = await pending(store);
    await store.activate(a.gid, "jti-0000000001");
    await pending(store);
    const refusal = await pending(store).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GrantLimitError);
    expect((refusal as Error).message).toMatch(/grants revoke/);
    await store.revoke(a.gid, "user");
    await expect(pending(store)).resolves.toMatchObject({ status: "pending" });

    const first = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 600 });
    clock.advance(1000);
    const second = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 600 });
    clock.advance(1000);
    const third = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 600 });
    expect(store.getSession(first.sid)).toBeUndefined();
    expect(store.getSession(second.sid)).toBeDefined();
    expect(store.getSession(third.sid)).toBeDefined();
  });

  it("prunes stale pending grants under cap pressure", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: undefined, now: clock.now, maxGrants: 1 });
    await pending(store);
    await expect(pending(store)).rejects.toBeInstanceOf(GrantLimitError);
    clock.advance(601_000);
    await expect(pending(store)).resolves.toBeDefined();
  });
});

describe("grant store file", () => {
  it("persists and compacts across restarts, with mode 0600", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const first = await openGrantStore({ stateDir: dir, now: clock.now, log, heartbeatMs: 0 });
    const grant = await pending(first);
    await first.activate(grant.gid, "jti-0000000001");
    await first.rotate(grant.gid, 1);
    const session = await first.createSession({
      accountId: "4711",
      gid: grant.gid,
      via: "consent",
      ttlSeconds: 3600,
    });
    const gone = await pending(first, "4711", 60);
    await first.revoke(gone.gid, "user");
    await first.close();
    await expect(lstat(join(dir, LOCK_FILE))).rejects.toThrow();

    clock.advance(10_000);
    const second = await server({ stateDir: dir, now: clock.now, log });
    expect(second.get(grant.gid)).toMatchObject({
      status: "active",
      gen: 2,
      tiers: ["read", "write"],
    });
    expect(second.get(gone.gid)).toMatchObject({ status: "revoked", reason: "user" });
    expect(second.getSession(session.sid)).toMatchObject({ gid: grant.gid });
    const info = await lstat(join(dir, GRANTS_FILE));
    expect(info.mode & 0o777).toBe(0o600);
    const lines = (await readFile(join(dir, GRANTS_FILE), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toEqual({ t: "store", v: 1 });
    expect(lines.filter((line) => line.includes('"t":"grant"'))).toHaveLength(2);
    // Nothing secret is ever written.
    expect(lines.join("\n")).not.toMatch(/sdmcp_|[0-9a-f]{32}/);
  });

  it("drops expired grants and dead sessions when compacting", async () => {
    const clock = fakeClock();
    const first = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
    const short = await pending(first, "4711", 60);
    const long = await pending(first);
    await first.createSession({ accountId: "4711", via: "token", ttlSeconds: 30 });
    await first.close();
    clock.advance(120_000);
    const second = await server({ stateDir: dir, now: clock.now });
    expect(second.get(short.gid)).toBeUndefined();
    // Pending for 2 minutes only: kept (its code could no longer be exchanged after 60 s, but
    // stale pending grants are only dropped after 10 minutes).
    expect(second.get(long.gid)?.status).toBe("pending");
    expect((await readFile(join(dir, GRANTS_FILE), "utf8")).match(/"t":"session"/g)).toBeNull();
  });

  it("refuses a corrupt file with the line number, and a newer format", async () => {
    await writeFile(join(dir, GRANTS_FILE), '{"t":"store","v":1}\n{"t":"grant","gid":1}\n', {
      mode: 0o600,
    });
    const error = await openGrantStore({ stateDir: dir, heartbeatMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StateDirError);
    expect((error as Error).message).toMatch(/line 2 .*corrupt/);
    // The lock was released again.
    await expect(lstat(join(dir, LOCK_FILE))).rejects.toThrow();

    await writeFile(join(dir, GRANTS_FILE), '{"t":"store","v":2}\n');
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(
      /newer version/,
    );
    await writeFile(join(dir, GRANTS_FILE), "not json\n");
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(StateDirError);
  });

  it("skips a torn last line from a crash", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const first = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
    const grant = await pending(first);
    await first.close();
    await appendFile(join(dir, GRANTS_FILE), '{"t":"revoke","gid":"');
    const second = await server({ stateDir: dir, now: clock.now, log });
    expect(second.get(grant.gid)?.status).toBe("pending");
    expect(log.events()).toContain("grant_store_torn_line");
  });

  it("refuses a symlink or directory and tightens a loose mode", async () => {
    await mkdir(join(dir, "elsewhere"));
    await writeFile(join(dir, "elsewhere", "target"), "");
    await symlink(join(dir, "elsewhere", "target"), join(dir, GRANTS_FILE));
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(
      /not a regular file/,
    );
    await rm(join(dir, GRANTS_FILE));
    await mkdir(join(dir, GRANTS_FILE));
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(
      /not a regular file/,
    );
    await rm(join(dir, GRANTS_FILE), { recursive: true });
    await writeFile(join(dir, GRANTS_FILE), "", { mode: 0o644 });
    await server({ stateDir: dir });
    expect((await lstat(join(dir, GRANTS_FILE))).mode & 0o777).toBe(0o600);
  });

  it("creates a missing state directory with mode 0700", async () => {
    const nested = join(dir, "state");
    await server({ stateDir: nested });
    expect((await lstat(nested)).mode & 0o777).toBe(0o700);
  });
});

describe("grant store lock", () => {
  it("refuses a second live server on the same directory", async () => {
    const clock = fakeClock();
    await server({ stateDir: dir, now: clock.now });
    clock.advance(29_000);
    const error = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StateDirError);
    expect((error as Error).message).toMatch(/Another mcp-server-sevdesk server uses .* 29 s ago/);
  });

  it("takes over a stale lock after a crash", async () => {
    const clock = fakeClock();
    const log = captureLog();
    await writeFile(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 1, token: "dead", beat: clock.now() - 31_000 }),
    );
    await server({ stateDir: dir, now: clock.now, log });
    expect(log.lines).toContainEqual({
      level: "warn",
      event: "state_lock_taken_over",
      fields: { ageSeconds: 31 },
    });
    const lock = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { token: string };
    expect(lock.token).not.toBe("dead");
  });

  it("judges an unreadable lock by its modification time", async () => {
    await writeFile(join(dir, LOCK_FILE), "garbage");
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(StateDirError);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, LOCK_FILE), old, old);
    await expect(server({ stateDir: dir })).resolves.toBeDefined();
  });

  it("refreshes the lock on every heartbeat and notices when it is lost", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const clock = fakeClock();
      const log = captureLog();
      const store = await openGrantStore({
        stateDir: dir,
        now: clock.now,
        log,
        heartbeatMs: 10_000,
      });
      open.push(store);
      const path = join(dir, LOCK_FILE);
      const before = JSON.parse(await readFile(path, "utf8")) as { beat: number; token: string };
      clock.advance(10_000);
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(async () => {
        const after = JSON.parse(await readFile(path, "utf8")) as { beat: number };
        expect(after.beat).toBe(before.beat + 10_000);
      });
      await writeFile(path, JSON.stringify({ pid: 2, token: "intruder", beat: clock.now() }));
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => {
        expect(log.events()).toContain("state_lock_lost");
      });
      await store.close();
      // A lock that is not ours is left alone.
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ token: "intruder" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("grants command next to a running server", () => {
  it("appends revocations that the server reads on sync (throttled to once a second)", async () => {
    const clock = fakeClock();
    const running = await server({ stateDir: dir, now: clock.now });
    const grant = await pending(running);
    await running.activate(grant.gid, "jti-0000000001");
    const session = await running.createSession({
      accountId: "4711",
      gid: grant.gid,
      via: "consent",
      ttlSeconds: 600,
    });
    await running.sync(true);

    const cli = await openGrantStore({ stateDir: dir, role: "cli", now: clock.now });
    expect(cli.get(grant.gid)?.status).toBe("active");
    await expect(cli.revoke(grant.gid, "operator")).resolves.toBe(true);
    await cli.close();
    await expect(lstat(join(dir, LOCK_FILE))).resolves.toBeDefined();

    expect(running.get(grant.gid)?.status).toBe("active");
    await running.sync();
    expect(running.get(grant.gid)?.status).toBe("active");
    clock.advance(1000);
    await running.sync();
    expect(running.get(grant.gid)).toMatchObject({ status: "revoked", reason: "operator" });
    expect(running.getSession(session.sid)).toBeUndefined();
  });

  it("reads an empty or missing directory as no grants", async () => {
    const cli = await openGrantStore({ stateDir: join(dir, "missing"), role: "cli" });
    expect(cli.list()).toEqual([]);
    await cli.close();
  });

  it("skips invalid appended lines at runtime and re-reads a truncated file", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const running = await server({ stateDir: dir, now: clock.now, log });
    const grant = await pending(running);
    await appendFile(join(dir, GRANTS_FILE), "garbage\n");
    await running.sync(true);
    expect(log.events()).toContain("grant_store_invalid_line");
    expect(running.get(grant.gid)?.status).toBe("pending");

    await truncate(join(dir, GRANTS_FILE), 0);
    await appendFile(
      join(dir, GRANTS_FILE),
      `${JSON.stringify({ t: "revoke", gid: grant.gid, why: "operator", at: 1 })}\n`,
    );
    await running.sync(true);
    expect(running.get(grant.gid)?.status).toBe("revoked");
  });

  it("keeps a partial line until it is complete", async () => {
    const clock = fakeClock();
    const running = await server({ stateDir: dir, now: clock.now });
    const grant = await pending(running);
    await running.sync(true);
    const line = JSON.stringify({ t: "revoke", gid: grant.gid, why: "operator", at: 1 });
    await appendFile(join(dir, GRANTS_FILE), line.slice(0, 10));
    await running.sync(true);
    expect(running.get(grant.gid)?.status).toBe("pending");
    await appendFile(join(dir, GRANTS_FILE), `${line.slice(10)}\n`);
    await running.sync(true);
    expect(running.get(grant.gid)?.status).toBe("revoked");
  });

  it("refuses writes after close", async () => {
    const running = await openGrantStore({ stateDir: dir, heartbeatMs: 0 });
    await running.close();
    await running.close();
    await expect(pending(running)).rejects.toThrow(/closed/);
  });
});
