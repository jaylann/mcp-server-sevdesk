/**
 * The grant store: OAuth grants and approval-inbox sessions, as non-secret metadata only (ids,
 * account, client, tiers, status, refresh generation, times). Tokens never reach it: the sevDesk
 * token travels sealed inside the grant's own tokens.
 *
 * Without a state directory everything lives in memory (a restart signs every client out). With
 * `SEVDESK_HTTP_STATE_DIR` it persists as an append-only `grants.jsonl` (mode 0600, never
 * through a symlink; the directory is kept at 0700):
 * - one JSON event per line: `grant` (create, also the compacted snapshot), `activate`, `rotate`,
 *   `revoke`, `session`, `session_revoke`; applying an event is idempotent and monotonic
 *   (status only advances, generations only grow, revocation is final), so the server can read
 *   its own appended lines back and two writers cannot undo each other;
 * - the server and the `grants revoke` command both append with `O_APPEND`; the server reads
 *   bytes appended by others before every `/token` request and at most once a second otherwise
 *   ({@link GrantStore.sync});
 * - the server compacts the file (one snapshot line per live record, expired and long revoked
 *   records pruned) at startup, and while running once 1 MiB was appended or a day passed. It
 *   writes a new file and renames it over the old one, then carries over whatever was appended to
 *   the old file meanwhile; a `grants` command that appended to the old file notices the replaced
 *   inode and appends again. The startup load streams, so a large file of mostly dead lines is
 *   compacted rather than refused;
 * - a lock file (`grants.lock`, created exclusively, its modification time refreshed every 10 s,
 *   stale after 30 s) refuses a second live server without blocking a restart after a crash. A
 *   stale lock is moved aside with an atomic rename, so of two racing starters only one wins. A
 *   server that finds its lock taken stops trusting its state: every further call throws
 *   {@link StateDirError} and `onFatal` asks the process to exit (the platform restarts it);
 * - a corrupt file refuses startup (only a torn last line, from a crash mid-write, is skipped).
 *
 * Caps: 500 grants (a new consent is refused beyond that until grants are revoked or expire), 20
 * live grants per account (a new consent revokes the account's oldest one, reason `superseded`)
 * and 1,000 sessions (the oldest session is ended).
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  constants,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { type Tier, TIERS } from "../../safety/tiers.js";
import type { GrantRecord, GrantStore, HttpLog, RotateResult, SessionRecord } from "../types.js";
import { ACCOUNT_ID_PATTERN } from "./tokens.js";

export const GRANTS_FILE = "grants.jsonl";
export const LOCK_FILE = "grants.lock";
/** How long the previous refresh generation stays usable after a rotation. */
const REFRESH_GRACE_SECONDS = 30;
const MAX_GRANTS = 500;
const MAX_GRANTS_PER_ACCOUNT = 20;
const MAX_SESSIONS = 1_000;
/** Browser sessions one account may hold; signing in again past it ends its oldest. */
const MAX_SESSIONS_PER_ACCOUNT = 50;
const SYNC_INTERVAL_MS = 1_000;
/** Compact while running once this much was appended since the last compaction … */
const COMPACT_BYTES = 1024 * 1024;
/** … or once this long has passed. */
const COMPACT_INTERVAL_MS = 86_400_000;
const HEARTBEAT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
/**
 * How long a starter that took part in a stale-lock takeover waits before it checks that the new
 * lock is still its own: a racing starter may briefly move it aside to judge it, and a third may
 * create its own lock in that moment. A clean start (no lock found) does not wait.
 */
const LOCK_SETTLE_MS = 100;
/** A pending grant whose code was never exchanged is dropped after this long. */
const PENDING_TTL_SECONDS = 600;
/** Revoked grants stay listed this long (for `grants list`), then are pruned. */
const REVOKED_RETENTION_SECONDS = 7 * 86_400;
const FORMAT_VERSION = 1;
/** Longest line accepted when loading (real events are a few hundred bytes). */
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW;

/**
 * The state directory cannot be used: startup is refused, or (after the lock was lost) every
 * further call of the store throws it. Trusted text.
 */
export class StateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDirError";
  }
}

/** The grant cap is reached; the consent page shows the message. Trusted text. */
export class GrantLimitError extends Error {
  /** How many connections the server holds at most. */
  readonly limit = MAX_GRANTS;

  constructor() {
    super(
      `This server already holds ${String(MAX_GRANTS)} connections. Its operator can revoke ` +
        "unused ones with `mcp-server-sevdesk grants revoke`; then try again.",
    );
    this.name = "GrantLimitError";
  }
}

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const seconds = z.number().int().nonnegative();
const accountId = z.string().regex(ACCOUNT_ID_PATTERN);
const reason = z.string().regex(/^[a-z0-9_]{1,40}$/);

const eventSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("store"), v: z.number().int() }),
  z.strictObject({
    t: z.literal("grant"),
    gid: id,
    acct: accountId,
    cid: z.string().min(1).max(512),
    host: z.string().min(1).max(253),
    tiers: z.array(z.enum(TIERS)).min(1).max(TIERS.length),
    at: seconds,
    exp: seconds,
    st: z.enum(["pending", "active", "revoked"]),
    gen: z.number().int().nonnegative(),
    rot: seconds.optional(),
    rev: seconds.optional(),
    why: reason.optional(),
  }),
  z.strictObject({ t: z.literal("activate"), gid: id, jti: id, at: seconds }),
  z.strictObject({
    t: z.literal("rotate"),
    gid: id,
    gen: z.number().int().positive(),
    at: seconds,
  }),
  z.strictObject({ t: z.literal("revoke"), gid: id, why: reason, at: seconds }),
  z.strictObject({
    t: z.literal("session"),
    sid: id,
    acct: accountId,
    gid: id.optional(),
    via: z.enum(["consent", "token"]),
    at: seconds,
    exp: seconds,
  }),
  z.strictObject({ t: z.literal("session_revoke"), sid: id, at: seconds }),
]);

type StoreEvent = z.infer<typeof eventSchema>;

interface GrantState {
  gid: string;
  accountId: string;
  clientId: string;
  clientHost: string;
  tiers: Tier[];
  createdAt: number;
  expiresAt: number;
  status: GrantRecord["status"];
  gen: number;
  rotatedAt: number | undefined;
  revokedAt: number | undefined;
  reason: string | undefined;
}

interface SessionState {
  sid: string;
  accountId: string;
  gid: string | undefined;
  via: SessionRecord["via"];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

const STATUS_RANK: Readonly<Record<GrantRecord["status"], number>> = {
  pending: 0,
  active: 1,
  revoked: 2,
};

export interface GrantStoreOptions {
  /** `SEVDESK_HTTP_STATE_DIR`; `undefined` keeps everything in memory. */
  readonly stateDir: string | undefined;
  /**
   * `server` (default) takes the lock and compacts the file; `cli` (the `grants` command) only
   * reads and appends, next to a running server.
   */
  readonly role?: "server" | "cli";
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly log?: HttpLog;
  /** Lock heartbeat interval; 0 turns the timer off (tests). */
  readonly heartbeatMs?: number;
  readonly maxGrants?: number;
  /**
   * Live (pending or active) grants one account may hold (default 20). A new consent beyond it
   * revokes the account's oldest grant (reason `superseded`), so one account cannot fill the
   * global cap.
   */
  readonly maxGrantsPerAccount?: number;
  readonly maxSessions?: number;
  readonly maxSessionsPerAccount?: number;
  /** Compact while running after this many appended bytes (default 1 MiB) … */
  readonly compactBytes?: number;
  /** … or after this long (default 24 h). */
  readonly compactIntervalMs?: number;
  /**
   * Called once when the store can no longer be trusted (another server took its state directory
   * lock). The store then refuses every call; the process should exit so it is restarted.
   */
  readonly onFatal?: (error: StateDirError) => void;
}

function newId(): string {
  return randomBytes(16).toString("base64url");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Opens the grant store. In the `server` role with a state directory this takes the directory's
 * lock and compacts the file; rejects with {@link StateDirError} when another live server holds
 * the lock, the file is corrupt, or a path is a symlink or not a regular file.
 */
export async function openGrantStore(options: GrantStoreOptions): Promise<GrantStore> {
  const store = new Store(options);
  await store.open();
  return store;
}

class Store implements GrantStore {
  readonly #now: () => number;
  readonly #log: HttpLog | undefined;
  readonly #dir: string | undefined;
  readonly #role: "server" | "cli";
  readonly #maxGrants: number;
  readonly #maxGrantsPerAccount: number;
  readonly #maxSessions: number;
  readonly #maxSessionsPerAccount: number;
  readonly #heartbeatMs: number;
  readonly #compactBytes: number;
  readonly #compactIntervalMs: number;
  readonly #onFatal: ((error: StateDirError) => void) | undefined;
  readonly #grants = new Map<string, GrantState>();
  readonly #sessions = new Map<string, SessionState>();
  #handle: FileHandle | undefined;
  #offset = 0;
  #partial: Buffer = Buffer.alloc(0);
  #compactedSize = 0;
  #compactedAt = 0;
  #lastSync = Number.NEGATIVE_INFINITY;
  #syncing: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #lock: Lock | undefined;
  #failed: StateDirError | undefined;
  #closed = false;

  constructor(options: GrantStoreOptions) {
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#dir = options.stateDir;
    this.#role = options.role ?? "server";
    this.#maxGrants = options.maxGrants ?? MAX_GRANTS;
    this.#maxGrantsPerAccount = options.maxGrantsPerAccount ?? MAX_GRANTS_PER_ACCOUNT;
    this.#maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.#maxSessionsPerAccount = options.maxSessionsPerAccount ?? MAX_SESSIONS_PER_ACCOUNT;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#compactBytes = options.compactBytes ?? COMPACT_BYTES;
    this.#compactIntervalMs = options.compactIntervalMs ?? COMPACT_INTERVAL_MS;
    this.#onFatal = options.onFatal;
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  /** Throws once the store can no longer be trusted (its lock was lost). */
  #usable(): void {
    if (this.#failed !== undefined) throw this.#failed;
  }

  /**
   * Checks the lock is still ours before state is read or compacted; when another server took it
   * over, the store fails at once. The heartbeat alone noticed only on its next beat: a server
   * that was paused past the stale-lock age could serve a request from its old file handle (which
   * misses revocations the new owner recorded) and, at its daily compaction, write that stale
   * state over the new owner's file (security review 2026-11, wave 2). True when still ours.
   */
  async #confirmOwnership(): Promise<boolean> {
    if (this.#role !== "server" || this.#lock === undefined) return this.#failed === undefined;
    return this.#lock.confirm((error) => {
      this.#fail(error);
    });
  }

  #fail(error: StateDirError): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    this.#log?.warn("state_lock_lost", {});
    try {
      this.#onFatal?.(error);
    } catch {
      // The callback's failure must not keep the store usable.
    }
  }

  async open(): Promise<void> {
    const dir = this.#dir;
    if (dir === undefined) return;
    if (this.#role === "cli") {
      let handle: FileHandle;
      try {
        handle = await open(join(dir, GRANTS_FILE), constants.O_RDONLY | NO_FOLLOW);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw new StateDirError(
          `Cannot read ${join(dir, GRANTS_FILE)} (it must be a regular file, not a symlink).`,
        );
      }
      try {
        await this.#loadFile(handle, true);
      } finally {
        await handle.close();
      }
      return;
    }
    await prepareDirectory(dir, this.#log);
    this.#lock = await acquireLock(dir, this.#now, this.#log);
    try {
      await this.#compactAtStart(dir);
    } catch (error) {
      await this.#lock.release();
      this.#lock = undefined;
      throw error;
    }
    this.#lock.startHeartbeat(this.#heartbeatMs, (error) => {
      this.#fail(error);
    });
  }

  /** Streams the file in, then swaps in a compacted copy. */
  async #compactAtStart(dir: string): Promise<void> {
    const path = join(dir, GRANTS_FILE);
    await checkRegularFile(path);
    let previous: FileHandle | undefined;
    try {
      previous = await open(path, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot read ${path}.`);
      }
    }
    try {
      const end = previous === undefined ? 0 : await this.#loadFile(previous, true);
      await this.#swap(dir, previous, end);
    } finally {
      await previous?.close();
    }
  }

  /**
   * Writes the live records to a new file and renames it over `grants.jsonl`, then carries over
   * what was appended to the old file (`previous`) after `readEnd` (a `grants` command). Runs
   * inside the write chain at runtime, so the server's own appends wait for it.
   */
  async #swap(dir: string, previous: FileHandle | undefined, readEnd: number): Promise<void> {
    const path = join(dir, GRANTS_FILE);
    this.#prune(this.#seconds(), false);
    const snapshot = this.#snapshot();
    const temporary = `${path}.${newId()}.tmp`;
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await output.writeFile(snapshot);
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, path);
    const tail = previous === undefined ? Buffer.alloc(0) : await readFrom(previous, readEnd);
    // Only complete lines move over: a writer still in the middle of a line appended it to the
    // old file and appends it again to the new one when it sees the replaced inode.
    const complete = tail.subarray(0, tail.lastIndexOf(0x0a) + 1);
    const handle = await open(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    if (complete.length > 0) await handle.write(complete);
    this.#handle = handle;
    // Everything after the snapshot (the carried lines, and whatever `grants` appended to the
    // new file meanwhile) is read back like any other appended bytes.
    this.#offset = Buffer.byteLength(snapshot);
    this.#partial = Buffer.alloc(0);
    await this.#readAppended();
    this.#compactedSize = this.#offset;
    this.#compactedAt = this.#now();
  }

  /** Compacts while running when enough was appended or a day passed (under the lock). */
  async #maybeCompact(): Promise<void> {
    const dir = this.#dir;
    if (dir === undefined || this.#role !== "server" || this.#handle === undefined) return;
    const grown = this.#offset - this.#compactedSize;
    if (grown < this.#compactBytes && this.#now() - this.#compactedAt < this.#compactIntervalMs) {
      return;
    }
    const run = this.#writes.then(async () => {
      const old = this.#handle;
      if (old === undefined || this.#closed || this.#failed !== undefined) return;
      if (!(await this.#confirmOwnership())) return;
      await this.#readAppended();
      await this.#swap(dir, old, this.#offset - this.#partial.length);
      await old.close();
      this.#log?.info("grant_store_compacted", { bytes: this.#offset });
    });
    this.#writes = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      this.#log?.warn("grant_store_compaction_failed", { code: errorCode(error) });
    }
  }

  #snapshot(): string {
    const lines: StoreEvent[] = [{ t: "store", v: FORMAT_VERSION }];
    for (const grant of this.#grants.values()) lines.push(grantEvent(grant));
    for (const session of this.#sessions.values()) {
      lines.push({
        t: "session",
        sid: session.sid,
        acct: session.accountId,
        ...(session.gid === undefined ? {} : { gid: session.gid }),
        via: session.via,
        at: session.createdAt,
        exp: session.expiresAt,
      });
    }
    return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  }

  /**
   * Applies a whole file, streaming it in chunks; returns the number of bytes read. `strict`: a
   * malformed line (other than a torn last one) throws.
   */
  async #loadFile(handle: FileHandle, strict: boolean): Promise<number> {
    let position = 0;
    let lineNumber = 0;
    let carry = Buffer.alloc(0);
    for (;;) {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data =
        carry.length === 0
          ? buffer.subarray(0, bytesRead)
          : Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a, start)) {
        lineNumber += 1;
        this.#applyLine(
          data.subarray(start, end).toString("utf8"),
          strict ? lineNumber : undefined,
        );
        start = end + 1;
      }
      carry = Buffer.from(data.subarray(start));
      if (carry.length > MAX_LINE_BYTES) {
        throw new StateDirError(
          `${GRANTS_FILE} line ${String(lineNumber + 1)} is longer than 64 KiB; the file is not ` +
            "a grant store. Restore it from a backup, or move it away to start without grants.",
        );
      }
    }
    if (carry.toString("utf8").trim() !== "") {
      const event = parseEvent(carry.toString("utf8"));
      if (event === undefined) {
        this.#log?.warn("grant_store_torn_line", { line: lineNumber + 1 });
      } else {
        this.#apply(event);
      }
    }
    return position;
  }

  /** Applies complete lines of `chunk` (after any partial line kept from before). */
  #applyText(chunk: Buffer, keepPartial: boolean): void {
    const buffer = Buffer.concat([this.#partial, chunk]);
    const end = buffer.lastIndexOf(0x0a);
    const complete = end === -1 ? Buffer.alloc(0) : buffer.subarray(0, end);
    this.#partial = keepPartial ? Buffer.from(buffer.subarray(end + 1)) : Buffer.alloc(0);
    for (const line of complete.toString("utf8").split("\n")) this.#applyLine(line, undefined);
  }

  #applyLine(line: string, strictLine: number | undefined): void {
    if (line.trim() === "") return;
    const event = parseEvent(line);
    if (event === undefined) {
      if (strictLine !== undefined) {
        throw new StateDirError(
          `${GRANTS_FILE} line ${String(strictLine)} is not a valid grant store event. The file ` +
            "is corrupt: restore it from a backup, or move it away to start without grants.",
        );
      }
      this.#log?.warn("grant_store_invalid_line", {});
      return;
    }
    if (event.t === "store" && event.v !== FORMAT_VERSION && strictLine !== undefined) {
      throw new StateDirError(
        `${GRANTS_FILE} was written by a newer version (format ${String(event.v)}); update ` +
          "mcp-server-sevdesk.",
      );
    }
    this.#apply(event);
  }

  #apply(event: StoreEvent): void {
    switch (event.t) {
      case "store":
        return;
      case "grant": {
        const existing = this.#grants.get(event.gid);
        if (existing === undefined) {
          this.#grants.set(event.gid, {
            gid: event.gid,
            accountId: event.acct,
            clientId: event.cid,
            clientHost: event.host,
            tiers: [...event.tiers],
            createdAt: event.at,
            expiresAt: event.exp,
            status: event.st,
            gen: event.gen,
            rotatedAt: event.rot,
            revokedAt: event.st === "revoked" ? (event.rev ?? event.at) : undefined,
            reason: event.st === "revoked" ? event.why : undefined,
          });
          return;
        }
        if (event.gen > existing.gen) {
          existing.gen = event.gen;
          existing.rotatedAt = event.rot;
        }
        if (STATUS_RANK[event.st] > STATUS_RANK[existing.status]) {
          existing.status = event.st;
          if (event.st === "revoked") {
            existing.revokedAt = event.rev ?? event.at;
            existing.reason = event.why;
          }
        }
        return;
      }
      case "activate": {
        const grant = this.#grants.get(event.gid);
        if (grant?.status === "pending") {
          grant.status = "active";
          grant.gen = Math.max(grant.gen, 1);
        }
        return;
      }
      case "rotate": {
        const grant = this.#grants.get(event.gid);
        if (grant !== undefined && event.gen > grant.gen) {
          grant.gen = event.gen;
          grant.rotatedAt = event.at;
          if (grant.status === "pending") grant.status = "active";
        }
        return;
      }
      case "revoke": {
        const grant = this.#grants.get(event.gid);
        if (grant !== undefined && grant.status !== "revoked") {
          grant.status = "revoked";
          grant.revokedAt = event.at;
          grant.reason = event.why;
        }
        return;
      }
      case "session":
        if (!this.#sessions.has(event.sid)) {
          this.#sessions.set(event.sid, {
            sid: event.sid,
            accountId: event.acct,
            gid: event.gid,
            via: event.via,
            createdAt: event.at,
            expiresAt: event.exp,
            revoked: false,
          });
        }
        return;
      case "session_revoke": {
        const session = this.#sessions.get(event.sid);
        if (session !== undefined) session.revoked = true;
        return;
      }
    }
  }

  /**
   * Drops expired records, pending grants whose code can no longer be exchanged and (after the
   * retention, or all of them when `aggressive`) revoked grants; and dead sessions.
   */
  #prune(now: number, aggressive: boolean): void {
    for (const [gid, grant] of this.#grants) {
      const stalePending =
        grant.status === "pending" && grant.createdAt + PENDING_TTL_SECONDS <= now;
      const oldRevoked =
        grant.status === "revoked" &&
        (aggressive || (grant.revokedAt ?? 0) + REVOKED_RETENTION_SECONDS <= now);
      if (grant.expiresAt <= now || stalePending || oldRevoked) this.#grants.delete(gid);
    }
    for (const [sid, session] of this.#sessions) {
      const grant = session.gid === undefined ? undefined : this.#grants.get(session.gid);
      const grantGone =
        session.gid !== undefined && (grant === undefined || grant.status === "revoked");
      if (session.revoked || session.expiresAt <= now || grantGone) this.#sessions.delete(sid);
    }
  }

  async #append(event: StoreEvent): Promise<void> {
    const dir = this.#dir;
    if (dir === undefined) return;
    if (this.#closed) throw new Error("The grant store is closed.");
    const line = `${JSON.stringify(event)}\n`;
    const write =
      this.#role === "server"
        ? this.#writes.then(async () => {
            this.#usable();
            await this.#handle?.write(line);
          })
        : this.#writes.then(() => appendFromCli(join(dir, GRANTS_FILE), line));
    this.#writes = write.catch(() => undefined);
    await write;
  }

  async createPending(input: {
    readonly accountId: string;
    readonly clientId: string;
    readonly clientHost: string;
    readonly tiers: readonly Tier[];
    readonly ttlSeconds: number;
  }): Promise<GrantRecord> {
    this.#usable();
    const now = this.#seconds();
    const live = [...this.#grants.values()]
      .filter(
        (grant) =>
          grant.accountId === input.accountId &&
          grant.status !== "revoked" &&
          grant.expiresAt > now,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const oldest of live.slice(0, Math.max(0, live.length - this.#maxGrantsPerAccount + 1))) {
      await this.#revokeGrant(oldest, "superseded", now);
      this.#log?.warn("grant_superseded", {
        grant: oldest.gid.slice(0, 8),
        account: oldest.accountId,
      });
    }
    if (this.#grants.size >= this.#maxGrants) this.#prune(now, true);
    if (this.#grants.size >= this.#maxGrants) throw new GrantLimitError();
    const grant: GrantState = {
      gid: newId(),
      accountId: input.accountId,
      clientId: input.clientId,
      clientHost: input.clientHost,
      tiers: TIERS.filter((tier) => input.tiers.includes(tier)),
      createdAt: now,
      expiresAt: now + input.ttlSeconds,
      status: "pending",
      gen: 0,
      rotatedAt: undefined,
      revokedAt: undefined,
      reason: undefined,
    };
    this.#grants.set(grant.gid, grant);
    await this.#append(grantEvent(grant));
    return snapshotGrant(grant);
  }

  async activate(gid: string, codeJti: string): Promise<"activated" | "replay" | "unknown"> {
    this.#usable();
    const now = this.#seconds();
    const grant = this.#grants.get(gid);
    if (grant === undefined || grant.expiresAt <= now) return "unknown";
    if (grant.status === "pending") {
      grant.status = "active";
      grant.gen = 1;
      await this.#append({ t: "activate", gid, jti: codeJti, at: now });
      return "activated";
    }
    if (grant.status === "active") await this.#revokeGrant(grant, "code_replay", now);
    return "replay";
  }

  async rotate(gid: string, presentedGen: number): Promise<RotateResult> {
    this.#usable();
    const now = this.#seconds();
    const grant = this.#grants.get(gid);
    if (grant === undefined || grant.status === "pending") return { ok: false, reason: "unknown" };
    if (grant.status === "revoked") return { ok: false, reason: "revoked" };
    if (grant.expiresAt <= now) return { ok: false, reason: "expired" };
    if (presentedGen === grant.gen) {
      grant.gen += 1;
      grant.rotatedAt = now;
      await this.#append({ t: "rotate", gid, gen: grant.gen, at: now });
      return { ok: true, gen: grant.gen };
    }
    if (
      presentedGen === grant.gen - 1 &&
      grant.rotatedAt !== undefined &&
      now - grant.rotatedAt <= REFRESH_GRACE_SECONDS
    ) {
      return { ok: true, gen: grant.gen };
    }
    await this.#revokeGrant(grant, "refresh_replay", now);
    return { ok: false, reason: "replay" };
  }

  get(gid: string): GrantRecord | undefined {
    this.#usable();
    const grant = this.#grants.get(gid);
    return grant === undefined ? undefined : snapshotGrant(grant);
  }

  async #revokeGrant(grant: GrantState, why: string, now: number): Promise<void> {
    if (grant.status === "revoked") return;
    grant.status = "revoked";
    grant.revokedAt = now;
    grant.reason = why;
    await this.#append({ t: "revoke", gid: grant.gid, why, at: now });
  }

  async revoke(gid: string, why: string): Promise<boolean> {
    this.#usable();
    const grant = this.#grants.get(gid);
    if (grant === undefined) return false;
    await this.#revokeGrant(grant, why, this.#seconds());
    return true;
  }

  async revokeAccount(accountIdToRevoke: string, why: string): Promise<number> {
    this.#usable();
    const now = this.#seconds();
    let active = 0;
    for (const grant of [...this.#grants.values()]) {
      if (grant.accountId !== accountIdToRevoke || grant.status === "revoked") continue;
      if (grant.status === "active") active += 1;
      await this.#revokeGrant(grant, why, now);
    }
    for (const session of [...this.#sessions.values()]) {
      if (session.accountId === accountIdToRevoke && !session.revoked) {
        await this.#revokeSession(session, now);
      }
    }
    return active;
  }

  async revokeAll(why: string): Promise<number> {
    this.#usable();
    const now = this.#seconds();
    let active = 0;
    for (const grant of [...this.#grants.values()]) {
      if (grant.status === "revoked") continue;
      if (grant.status === "active") active += 1;
      await this.#revokeGrant(grant, why, now);
    }
    // Sessions without a grant too: a bearer-mode sign-in with the sevDesk token has none, and an
    // account whose grants were all pruned can still have one (security review 2026-11,
    // finding 6).
    for (const session of [...this.#sessions.values()]) {
      if (!session.revoked) await this.#revokeSession(session, now);
    }
    return active;
  }

  list(): readonly GrantRecord[] {
    this.#usable();
    return [...this.#grants.values()]
      .sort((a, b) => b.createdAt - a.createdAt || a.gid.localeCompare(b.gid))
      .map(snapshotGrant);
  }

  async sync(force = false): Promise<void> {
    this.#usable();
    if (this.#handle === undefined || this.#closed) return;
    // A caller arriving while a read runs waits for it: answering from the state before that
    // read let a concurrent request pass on a grant the read was about to revoke (security
    // review 2026-11, finding 9). A forced sync must also see bytes appended after the running
    // read started, so it reads again.
    if (this.#syncing !== undefined) {
      await this.#syncing;
      if (!force) return;
    }
    if (!force && this.#now() - this.#lastSync < SYNC_INTERVAL_MS) return;
    this.#syncing ??= this.#confirmOwnership()
      .then(() => this.#readAppended())
      .then(() => this.#maybeCompact())
      .finally(() => {
        // The interval counts from the last completed read, not from one still running.
        this.#lastSync = this.#now();
        this.#syncing = undefined;
      });
    await this.#syncing;
    this.#usable();
  }

  async #readAppended(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) return;
    try {
      const { size } = await handle.stat();
      if (size < this.#offset) {
        // Truncated by someone else: re-read everything (applying is idempotent).
        this.#offset = 0;
        this.#partial = Buffer.alloc(0);
      }
      if (size === this.#offset) return;
      const chunk = await readFrom(handle, this.#offset, size);
      this.#offset += chunk.length;
      this.#applyText(chunk, true);
    } catch (error) {
      this.#log?.warn("grant_store_sync_failed", { code: errorCode(error) });
    }
  }

  async createSession(input: {
    readonly accountId: string;
    readonly gid?: string | undefined;
    readonly via: "consent" | "token";
    readonly ttlSeconds: number;
  }): Promise<SessionRecord> {
    this.#usable();
    const now = this.#seconds();
    // Room is made at the expense of whoever holds the most sessions: first within the signing-in
    // account (its own cap), then, at the global cap, the account with the most sessions. Evicting
    // the globally oldest let one account, signing in again and again, sign every other account
    // out (security review 2026-11, wave 2).
    const live = (): SessionState[] =>
      [...this.#sessions.values()].filter((s) => !s.revoked && s.expiresAt > now);
    const evictOldestOf = async (accountId: string): Promise<void> => {
      const oldest = live()
        .filter((s) => s.accountId === accountId)
        .reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
      await this.#revokeSession(oldest, now);
      this.#sessions.delete(oldest.sid);
    };
    while (
      live().filter((s) => s.accountId === input.accountId).length >= this.#maxSessionsPerAccount
    ) {
      await evictOldestOf(input.accountId);
    }
    if (this.#sessions.size >= this.#maxSessions) this.#prune(now, false);
    while (this.#sessions.size >= this.#maxSessions) {
      const counts = new Map<string, number>();
      for (const s of live()) counts.set(s.accountId, (counts.get(s.accountId) ?? 0) + 1);
      if (counts.size === 0) break;
      const busiest = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      await evictOldestOf(busiest);
    }
    const session: SessionState = {
      sid: newId(),
      accountId: input.accountId,
      gid: input.gid,
      via: input.via,
      createdAt: now,
      expiresAt: now + input.ttlSeconds,
      revoked: false,
    };
    this.#sessions.set(session.sid, session);
    await this.#append({
      t: "session",
      sid: session.sid,
      acct: session.accountId,
      ...(session.gid === undefined ? {} : { gid: session.gid }),
      via: session.via,
      at: session.createdAt,
      exp: session.expiresAt,
    });
    return snapshotSession(session);
  }

  getSession(sid: string): SessionRecord | undefined {
    this.#usable();
    // Picks up a `grants revoke` from another process for the next request.
    this.sync().catch(() => undefined);
    const now = this.#seconds();
    const session = this.#sessions.get(sid);
    if (session === undefined || session.revoked || session.expiresAt <= now) return undefined;
    if (session.gid !== undefined) {
      const grant = this.#grants.get(session.gid);
      if (grant === undefined || grant.status === "revoked" || grant.expiresAt <= now) {
        return undefined;
      }
    }
    return snapshotSession(session);
  }

  async #revokeSession(session: SessionState, now: number): Promise<void> {
    if (session.revoked) return;
    session.revoked = true;
    await this.#append({ t: "session_revoke", sid: session.sid, at: now });
  }

  async revokeSession(sid: string): Promise<void> {
    this.#usable();
    const session = this.#sessions.get(sid);
    if (session !== undefined) await this.#revokeSession(session, this.#seconds());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#syncing?.catch(() => undefined);
    await this.#writes;
    await this.#handle?.close();
    this.#handle = undefined;
    await this.#lock?.release();
    this.#lock = undefined;
  }
}

function parseEvent(line: string): StoreEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = eventSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function grantEvent(grant: GrantState): StoreEvent {
  return {
    t: "grant",
    gid: grant.gid,
    acct: grant.accountId,
    cid: grant.clientId,
    host: grant.clientHost,
    tiers: [...grant.tiers],
    at: grant.createdAt,
    exp: grant.expiresAt,
    st: grant.status,
    gen: grant.gen,
    ...(grant.rotatedAt === undefined ? {} : { rot: grant.rotatedAt }),
    ...(grant.revokedAt === undefined ? {} : { rev: grant.revokedAt }),
    ...(grant.reason === undefined ? {} : { why: grant.reason }),
  };
}

function snapshotGrant(grant: GrantState): GrantRecord {
  return Object.freeze({
    gid: grant.gid,
    accountId: grant.accountId,
    clientId: grant.clientId,
    clientHost: grant.clientHost,
    tiers: Object.freeze([...grant.tiers]),
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    status: grant.status,
    gen: grant.gen,
    rotatedAt: grant.rotatedAt,
    revokedAt: grant.revokedAt,
    reason: grant.reason,
  });
}

function snapshotSession(session: SessionState): SessionRecord {
  return Object.freeze({
    sid: session.sid,
    accountId: session.accountId,
    gid: session.gid,
    via: session.via,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
}

/**
 * Creates the state directory (0700) or tightens an existing one: group or other access to the
 * directory would let other local users replace `grants.jsonl` between restarts.
 */
async function prepareDirectory(dir: string, log: HttpLog | undefined): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot create ${dir}.`);
  }
  const info = await stat(dir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: ${dir} is not a directory.`);
  }
  if ((info.mode & 0o077) === 0) return;
  try {
    await chmod(dir, 0o700);
  } catch {
    throw new StateDirError(
      `SEVDESK_HTTP_STATE_DIR: other users can access ${dir}, and its mode could not be ` +
        `changed. Run \`chmod 700 ${dir}\` as its owner, or point the variable to a directory ` +
        "owned by the user the server runs as.",
    );
  }
  log?.warn("state_dir_mode_tightened", {});
}

/** Refuses a grants file that is a symlink or not a regular file; tightens its mode to 0600. */
async function checkRegularFile(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot read ${path}.`);
  }
  if (!info.isFile()) {
    throw new StateDirError(`${path} is not a regular file (a symlink or directory is refused).`);
  }
  if ((info.mode & 0o077) === 0) return;
  try {
    await chmod(path, 0o600);
  } catch {
    throw new StateDirError(
      `Other users can read ${path}, and its mode could not be changed. Run ` +
        `\`chmod 600 ${path}\` as its owner.`,
    );
  }
}

/** The bytes of `handle` from `position` to `end` (default: its end). */
async function readFrom(handle: FileHandle, position: number, end?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let at = position;
  for (;;) {
    const length = end === undefined ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, end - at);
    if (length <= 0) break;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, at);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    at += bytesRead;
  }
  return Buffer.concat(chunks);
}

/**
 * Appends `line` as a `grants` command does: if the server replaced the file (compaction) while
 * the line was being written to the old one, the line is appended to the new file too (applying
 * an event twice changes nothing).
 */
async function appendFromCli(path: string, line: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    let written;
    try {
      await handle.write(line);
      written = await handle.stat();
    } finally {
      await handle.close();
    }
    const current = await stat(path);
    if (current.ino === written.ino && current.dev === written.dev) return;
  }
}

interface Lock {
  /** Refreshes the lock every `intervalMs`; calls `onLost` once when another server took it. */
  startHeartbeat(intervalMs: number, onLost: (error: StateDirError) => void): void;
  /**
   * Refreshes and checks the lock now (one heartbeat); calls `onLost` and resolves `false` when
   * another server took it.
   */
  confirm(onLost: (error: StateDirError) => void): Promise<boolean>;
  release(): Promise<void>;
}

interface SeenLock {
  readonly raw: string;
  readonly mtimeMs: number;
}

async function inspectLock(path: string): Promise<SeenLock | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { raw, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function lockHeld(dir: string, ageMs: number): StateDirError {
  return new StateDirError(
    `Another mcp-server-sevdesk server uses ${dir} (its lock was refreshed ` +
      `${String(Math.max(0, Math.round(ageMs / 1000)))} s ago). Only one server may run per ` +
      "state directory: stop the other one, or wait 30 s if it crashed.",
  );
}

/** Creates the lock file exclusively (`O_EXCL`); false when it exists. */
async function createLock(path: string, content: string, now: () => number): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot write ${path}.`);
  }
  // Align the time with the injected clock. A racing starter may have just moved the new lock
  // aside to judge it and is putting it back; the heartbeat sets the time again either way.
  const seconds = now() / 1000;
  await utimes(path, seconds, seconds).catch(() => undefined);
  return true;
}

/**
 * Takes the state directory's lock, or refuses when another live server holds it. The lock's
 * content never changes (the heartbeat only refreshes its modification time), so a starter that
 * moved a stale lock aside can tell whether it moved exactly the file it judged stale; if not,
 * it puts the file back and refuses. Of two starters racing for a stale lock, only one wins.
 */
async function acquireLock(
  dir: string,
  now: () => number,
  log: HttpLog | undefined,
): Promise<Lock> {
  const path = join(dir, LOCK_FILE);
  const content = JSON.stringify({ pid: process.pid, token: newId(), started: now() });
  let acquired = await createLock(path, content, now);
  const raced = !acquired;
  for (let attempt = 0; !acquired && attempt < 3; attempt += 1) {
    const seen = await inspectLock(path);
    if (seen === undefined) {
      acquired = await createLock(path, content, now);
      continue;
    }
    const age = now() - seen.mtimeMs;
    if (age < STALE_LOCK_MS) throw lockHeld(dir, age);
    const aside = `${path}.${newId()}.stale`;
    try {
      await rename(path, aside);
    } catch {
      continue;
    }
    const moved = await inspectLock(aside);
    if (moved?.raw !== seen.raw || now() - moved.mtimeMs < STALE_LOCK_MS) {
      // Another starter (or the owner, awake again) got there first: give its lock back.
      await link(aside, path).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
      throw lockHeld(dir, 0);
    }
    await unlink(aside).catch(() => undefined);
    log?.warn("state_lock_taken_over", { ageSeconds: Math.round(age / 1000) });
    acquired = await createLock(path, content, now);
    if (!acquired) throw lockHeld(dir, 0);
  }
  if (!acquired) throw lockHeld(dir, 0);

  let timer: NodeJS.Timeout | undefined;
  let lost = false;
  const ours = async (): Promise<boolean> => (await inspectLock(path))?.raw === content;
  if (raced) {
    await delay(LOCK_SETTLE_MS);
    if (!(await ours())) throw lockHeld(dir, 0);
  }
  const beat = async (onLost: (error: StateDirError) => void): Promise<void> => {
    if (lost) return;
    const seconds = now() / 1000;
    await utimes(path, seconds, seconds).catch(() => undefined);
    if (await ours()) return;
    lost = true;
    clearInterval(timer);
    onLost(
      new StateDirError(
        `Another server took the lock of ${dir}; this server stopped using its grants. ` +
          "Restart it after the other server stopped.",
      ),
    );
  };
  return {
    startHeartbeat(intervalMs, onLost) {
      if (intervalMs <= 0) return;
      timer = setInterval(() => {
        beat(onLost).catch(() => {
          log?.warn("state_lock_heartbeat_failed", {});
        });
      }, intervalMs);
      timer.unref();
    },
    async confirm(onLost) {
      await beat(onLost);
      return !lost;
    },
    async release() {
      clearInterval(timer);
      if (!lost && (await ours())) await unlink(path).catch(() => undefined);
    },
  };
}
