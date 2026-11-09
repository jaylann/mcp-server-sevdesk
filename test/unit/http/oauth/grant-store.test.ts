import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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
    const path = join(dir, LOCK_FILE);
    await writeFile(path, JSON.stringify({ pid: 1, token: "dead", started: 0 }));
    const old = new Date(clock.now() - 31_000);
    await utimes(path, old, old);
    await server({ stateDir: dir, now: clock.now, log });
    expect(log.lines).toContainEqual({
      level: "warn",
      event: "state_lock_taken_over",
      fields: { ageSeconds: 31 },
    });
    const lock = JSON.parse(await readFile(path, "utf8")) as { token: string };
    expect(lock.token).not.toBe("dead");
    // Nothing is left over from the takeover.
    expect((await readdir(dir)).sort()).toEqual([GRANTS_FILE, LOCK_FILE]);
  });

  it("lets exactly one of two racing starters take over a stale lock", async () => {
    const path = join(dir, LOCK_FILE);
    for (let round = 0; round < 5; round += 1) {
      await writeFile(path, JSON.stringify({ pid: 1, token: `dead-${String(round)}`, started: 0 }));
      const old = new Date(Date.now() - 60_000);
      await utimes(path, old, old);
      const results = await Promise.allSettled([
        openGrantStore({ stateDir: dir, heartbeatMs: 0 }),
        openGrantStore({ stateDir: dir, heartbeatMs: 0 }),
        openGrantStore({ stateDir: dir, heartbeatMs: 0 }),
      ]);
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners, `round ${String(round)}`).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(StateDirError);
      }
      await winners[0]?.value.close();
      await rm(path, { force: true });
    }
    // Five rounds of three file-system races: slow under a fully parallel suite.
  }, 30_000);

  it("judges a lock by its modification time, also an unreadable one", async () => {
    await writeFile(join(dir, LOCK_FILE), "garbage");
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(StateDirError);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, LOCK_FILE), old, old);
    await expect(server({ stateDir: dir })).resolves.toBeDefined();
  });

  it("refreshes the lock on every heartbeat; a lost lock makes the store refuse and calls onFatal", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const clock = fakeClock();
      const log = captureLog();
      const fatal: StateDirError[] = [];
      const store = await openGrantStore({
        stateDir: dir,
        now: clock.now,
        log,
        heartbeatMs: 10_000,
        onFatal: (error) => fatal.push(error),
      });
      open.push(store);
      const grant = await pending(store);
      const path = join(dir, LOCK_FILE);
      const content = await readFile(path, "utf8");
      clock.advance(10_000);
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(async () => {
        expect((await stat(path)).mtimeMs).toBe(clock.now());
      });
      expect(await readFile(path, "utf8")).toBe(content);
      await writeFile(path, JSON.stringify({ pid: 2, token: "intruder", started: 0 }));
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => {
        expect(fatal).toHaveLength(1);
      });
      expect(log.events()).toContain("state_lock_lost");
      expect(fatal[0]?.message).toMatch(/Another server took the lock/);
      // Fail closed: nothing answers from the stale state any more.
      expect(() => store.get(grant.gid)).toThrow(StateDirError);
      expect(() => store.list()).toThrow(StateDirError);
      expect(() => store.getSession("any-session-id")).toThrow(StateDirError);
      await expect(store.sync(true)).rejects.toBeInstanceOf(StateDirError);
      await expect(store.rotate(grant.gid, 1)).rejects.toBeInstanceOf(StateDirError);
      await expect(store.revoke(grant.gid, "user")).rejects.toBeInstanceOf(StateDirError);
      await expect(pending(store)).rejects.toBeInstanceOf(StateDirError);
      await store.close();
      // A lock that is not ours is left alone.
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ token: "intruder" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a paused server whose lock another server took over (it never serves a revoked grant)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const clock = fakeClock();
      const fatal: StateDirError[] = [];
      const a = await openGrantStore({
        stateDir: dir,
        now: clock.now,
        heartbeatMs: 10_000,
        onFatal: (error) => fatal.push(error),
      });
      open.push(a);
      const grant = await pending(a);
      await a.activate(grant.gid, "jti-0000000001");
      // A is paused for more than 30 s; B starts and takes the lock over.
      const later = (): number => clock.now() + 31_000;
      const log = captureLog();
      const b = await openGrantStore({ stateDir: dir, now: later, log, heartbeatMs: 0 });
      open.push(b);
      expect(log.events()).toContain("state_lock_taken_over");
      const cli = await openGrantStore({ stateDir: dir, role: "cli" });
      await cli.revoke(grant.gid, "operator");
      await cli.close();
      await b.sync(true);
      expect(b.get(grant.gid)?.status).toBe("revoked");
      // A wakes up: its next heartbeat notices the takeover.
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => {
        expect(fatal).toHaveLength(1);
      });
      expect(() => a.get(grant.gid)).toThrow(StateDirError);
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

describe("per-account grant cap", () => {
  it("supersedes an account's oldest live grant instead of filling the global cap", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const store = await server({
      stateDir: undefined,
      now: clock.now,
      log,
      maxGrantsPerAccount: 2,
    });
    const first = await pending(store);
    await store.activate(first.gid, "jti-0000000001");
    clock.advance(1000);
    const second = await pending(store);
    clock.advance(1000);
    const other = await pending(store, "9999");
    const third = await pending(store);
    expect(store.get(first.gid)).toMatchObject({ status: "revoked", reason: "superseded" });
    expect(store.get(second.gid)?.status).toBe("pending");
    expect(store.get(third.gid)?.status).toBe("pending");
    expect(store.get(other.gid)?.status).toBe("pending");
    expect(log.lines).toContainEqual({
      level: "warn",
      event: "grant_superseded",
      fields: { grant: first.gid.slice(0, 8), account: "4711" },
    });
  });

  it("defaults to 20 live grants per account", async () => {
    const store = await server({ stateDir: undefined });
    const grants = [];
    for (let index = 0; index < 21; index += 1) grants.push(await pending(store));
    expect(store.list().filter((grant) => grant.status !== "revoked")).toHaveLength(20);
    expect(store.get(grants[0]?.gid ?? "")?.reason).toBe("superseded");
  });
});

describe("compaction", () => {
  it("compacts while running once enough was appended, keeping what the grants command adds", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const store = await server({ stateDir: dir, now: clock.now, log, compactBytes: 2048 });
    const grant = await pending(store);
    await store.activate(grant.gid, "jti-0000000001");
    for (let gen = 1; gen <= 40; gen += 1) await store.rotate(grant.gid, gen);
    const path = join(dir, GRANTS_FILE);
    const grown = (await stat(path)).size;
    expect(grown).toBeGreaterThan(2048);
    await store.sync(true);
    expect(log.events()).toContain("grant_store_compacted");
    expect((await stat(path)).size).toBeLessThan(grown / 4);
    expect(store.get(grant.gid)).toMatchObject({ status: "active", gen: 41 });

    // The store keeps appending to the new file, and a grants command still reaches it.
    await store.rotate(grant.gid, 41);
    const cli = await openGrantStore({ stateDir: dir, role: "cli" });
    expect(cli.get(grant.gid)?.gen).toBe(42);
    await cli.revoke(grant.gid, "operator");
    await cli.close();
    await store.sync(true);
    expect(store.get(grant.gid)?.status).toBe("revoked");
  });

  it("drops a half-written line at compaction; its writer appends it again to the new file", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const store = await server({ stateDir: dir, now: clock.now, log, compactBytes: 1 });
    const grant = await pending(store);
    await store.sync(true);
    const line = JSON.stringify({
      t: "revoke",
      gid: grant.gid,
      why: "operator",
      at: Math.floor(clock.now() / 1000),
    });
    const path = join(dir, GRANTS_FILE);
    await appendFile(path, line.slice(0, 20));
    // Compacts (1-byte threshold) while the line is incomplete.
    await store.sync(true);
    expect(store.get(grant.gid)?.status).toBe("pending");
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    // The writer (`appendFromCli`) sees the replaced inode and appends the whole line again.
    await appendFile(path, `${line}\n`);
    await store.sync(true);
    expect(store.get(grant.gid)).toMatchObject({ status: "revoked", reason: "operator" });
    expect(log.events()).not.toContain("grant_store_invalid_line");
  });

  it("carries complete lines appended during a compaction over to the new file", async () => {
    const clock = fakeClock();
    const store = await server({ stateDir: dir, now: clock.now, compactBytes: 1 });
    const grant = await pending(store);
    const other = await pending(store, "9999");
    const path = join(dir, GRANTS_FILE);
    const revoke = (gid: string): string =>
      `${JSON.stringify({ t: "revoke", gid, why: "operator", at: Math.floor(clock.now() / 1000) })}\n`;
    // Both lines are read in the same sync that triggers the compaction.
    await appendFile(path, revoke(grant.gid));
    await store.sync(true);
    await appendFile(path, revoke(other.gid));
    await store.sync(true);
    expect(store.get(grant.gid)?.status).toBe("revoked");
    expect(store.get(other.gid)?.status).toBe("revoked");
    const reopened = await openGrantStore({ stateDir: dir, role: "cli" });
    expect(reopened.list().map((record) => record.status)).toEqual(["revoked", "revoked"]);
    await reopened.close();
  });

  it("applies a complete last line without a newline at startup", async () => {
    const clock = fakeClock();
    const first = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
    const grant = await pending(first);
    await first.close();
    await appendFile(
      join(dir, GRANTS_FILE),
      JSON.stringify({ t: "revoke", gid: grant.gid, why: "operator", at: grant.createdAt }),
    );
    const second = await server({ stateDir: dir, now: clock.now });
    expect(second.get(grant.gid)?.status).toBe("revoked");
  });

  it("compacts once a day", async () => {
    const clock = fakeClock();
    const log = captureLog();
    const store = await server({ stateDir: dir, now: clock.now, log });
    await pending(store);
    await store.sync(true);
    expect(log.events()).not.toContain("grant_store_compacted");
    clock.advance(86_400_000);
    await store.sync(true);
    expect(log.events()).toContain("grant_store_compacted");
  });

  it("streams a large file of mostly dead lines at startup and compacts it", async () => {
    const clock = fakeClock();
    const now = Math.floor(clock.now() / 1000);
    const live = {
      t: "grant",
      gid: "live-grant-0000000000",
      acct: "4711",
      cid: CLIENT,
      host: "claude.ai",
      tiers: ["read"],
      at: now,
      exp: now + 86_400,
      st: "active",
      gen: 1,
    };
    const lines = [JSON.stringify(live)];
    for (let index = 0; index < 4000; index += 1) {
      lines.push(
        JSON.stringify({
          ...live,
          gid: `dead-grant-${String(index).padStart(10, "0")}`,
          exp: now - 1,
        }),
      );
      lines.push(JSON.stringify({ t: "rotate", gid: live.gid, gen: index + 2, at: now }));
    }
    await writeFile(join(dir, GRANTS_FILE), `${lines.join("\n")}\n`, { mode: 0o600 });
    expect((await stat(join(dir, GRANTS_FILE))).size).toBeGreaterThan(256 * 1024);
    const store = await server({ stateDir: dir, now: clock.now });
    expect(store.list()).toHaveLength(1);
    expect(store.get(live.gid)?.gen).toBe(4001);
    expect((await stat(join(dir, GRANTS_FILE))).size).toBeLessThan(1024);
  });

  it("refuses a line longer than 64 KiB", async () => {
    await writeFile(join(dir, GRANTS_FILE), `{"t":"store","v":1}\n${"x".repeat(70 * 1024)}`);
    await expect(openGrantStore({ stateDir: dir, heartbeatMs: 0 })).rejects.toThrow(
      /longer than 64 KiB/,
    );
  });
});

describe("state directory permissions", () => {
  it("tightens a state directory other users can access to 0700", async () => {
    const log = captureLog();
    await chmod(dir, 0o755);
    await server({ stateDir: dir, log });
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect(log.events()).toContain("state_dir_mode_tightened");
  });

  it("refuses a state directory path that is a file", async () => {
    await writeFile(join(dir, "file"), "");
    await expect(openGrantStore({ stateDir: join(dir, "file"), heartbeatMs: 0 })).rejects.toThrow(
      StateDirError,
    );
  });
});
