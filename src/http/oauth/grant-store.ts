/**
 * The grant store: OAuth grants and approval-inbox sessions, as non-secret metadata only (ids,
 * account, client, tiers, status, refresh generation, times). Tokens never reach it: the sevDesk
 * token travels sealed inside the grant's own tokens.
 *
 * Without a state directory everything lives in memory (a restart signs every client out). With
 * `SEVDESK_HTTP_STATE_DIR` it persists as an append-only `grants.jsonl` (mode 0600, never
 * through a symlink):
 * - one JSON event per line: `grant` (create, also the compacted snapshot), `activate`, `rotate`,
 *   `revoke`, `session`, `session_revoke`; applying an event is idempotent and monotonic
 *   (status only advances, generations only grow, revocation is final), so the server can read
 *   its own appended lines back and two writers cannot undo each other;
 * - the server and the `grants revoke` command both append with `O_APPEND`; the server reads
 *   bytes appended by others before every `/token` request and at most once a second otherwise
 *   ({@link GrantStore.sync});
 * - at startup the server compacts the file (one snapshot line per live record, expired and long
 *   revoked records pruned) and replaces it atomically; a `grants` command that appended to the
 *   old file meanwhile notices the replaced inode and appends again;
 * - a heartbeat lock file (`grants.lock`, refreshed every 10 s, stale after 30 s) refuses a second
 *   live server on the same directory without blocking a restart after a crash;
 * - a corrupt file refuses startup (only a torn last line, from a crash mid-write, is skipped).
 *
 * Caps: 500 grants (a new consent is refused beyond that until grants are revoked or expire) and
 * 1,000 sessions (the oldest session is ended).
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { type Tier, TIERS } from "../../safety/tiers.js";
import type { GrantRecord, GrantStore, HttpLog, RotateResult, SessionRecord } from "../types.js";
import { ACCOUNT_ID_PATTERN } from "./tokens.js";

export const GRANTS_FILE = "grants.jsonl";
export const LOCK_FILE = "grants.lock";
/** How long the previous refresh generation stays usable after a rotation. */
const REFRESH_GRACE_SECONDS = 30;
const MAX_GRANTS = 500;
const MAX_SESSIONS = 1_000;
const SYNC_INTERVAL_MS = 1_000;
const HEARTBEAT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
/** A pending grant whose code was never exchanged is dropped after this long. */
const PENDING_TTL_SECONDS = 600;
/** Revoked grants stay listed this long (for `grants list`), then are pruned. */
const REVOKED_RETENTION_SECONDS = 7 * 86_400;
const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW;

/** The state directory cannot be used; startup is refused. Trusted text. */
export class StateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDirError";
  }
}

/** The grant cap is reached; the consent page shows the message. Trusted text. */
export class GrantLimitError extends Error {
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
  readonly maxSessions?: number;
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
  readonly #maxSessions: number;
  readonly #heartbeatMs: number;
  readonly #grants = new Map<string, GrantState>();
  readonly #sessions = new Map<string, SessionState>();
  #handle: FileHandle | undefined;
  #offset = 0;
  #partial: Buffer = Buffer.alloc(0);
  #lastSync = Number.NEGATIVE_INFINITY;
  #syncing: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #lock: Lock | undefined;
  #closed = false;

  constructor(options: GrantStoreOptions) {
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#dir = options.stateDir;
    this.#role = options.role ?? "server";
    this.#maxGrants = options.maxGrants ?? MAX_GRANTS;
    this.#maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  #seconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  async open(): Promise<void> {
    const dir = this.#dir;
    if (dir === undefined) return;
    if (this.#role === "cli") {
      const data = await readIfExists(join(dir, GRANTS_FILE));
      if (data !== undefined) this.#load(data, true);
      return;
    }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot create ${dir}.`);
    }
    this.#lock = await acquireLock(dir, this.#now, this.#log);
    try {
      await this.#compact(dir);
    } catch (error) {
      await this.#lock.release();
      this.#lock = undefined;
      throw error;
    }
    this.#lock.startHeartbeat(this.#heartbeatMs);
  }

  /** Replays the file, writes the live records to a new file and swaps it in. */
  async #compact(dir: string): Promise<void> {
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
      const data = previous === undefined ? Buffer.alloc(0) : await previous.readFile();
      if (data.length > MAX_FILE_BYTES) {
        throw new StateDirError(`${path} is larger than 64 MiB; it is not a grant store.`);
      }
      this.#load(data, true);
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
      // A `grants` command may have appended to the old file after it was read: carry it over.
      const tail = previous === undefined ? Buffer.alloc(0) : await readFrom(previous, data.length);
      this.#handle = await open(
        path,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
        0o600,
      );
      if (tail.length > 0) {
        this.#applyText(tail, false);
        await this.#handle.write(tail);
      }
      this.#offset = (await this.#handle.stat()).size;
    } finally {
      await previous?.close();
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

  /** Applies a whole file. `strict`: a malformed line (other than a torn last one) throws. */
  #load(data: Buffer, strict: boolean): void {
    const text = data.toString("utf8");
    const lines = text.split("\n");
    const last = lines.pop() ?? "";
    lines.forEach((line, index) => {
      this.#applyLine(line, strict ? index + 1 : undefined);
    });
    if (last.trim() !== "") {
      const event = parseEvent(last);
      if (event === undefined) {
        this.#log?.warn("grant_store_torn_line", { line: lines.length + 1 });
      } else {
        this.#apply(event);
      }
    }
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
    const now = this.#seconds();
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
    const grant = this.#grants.get(gid);
    if (grant === undefined) return false;
    await this.#revokeGrant(grant, why, this.#seconds());
    return true;
  }

  async revokeAccount(accountIdToRevoke: string, why: string): Promise<number> {
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

  list(): readonly GrantRecord[] {
    return [...this.#grants.values()]
      .sort((a, b) => b.createdAt - a.createdAt || a.gid.localeCompare(b.gid))
      .map(snapshotGrant);
  }

  async sync(force = false): Promise<void> {
    if (this.#handle === undefined || this.#closed) return;
    const now = this.#now();
    if (!force && now - this.#lastSync < SYNC_INTERVAL_MS) return;
    this.#lastSync = now;
    if (this.#syncing !== undefined) {
      // A forced sync must see bytes appended after the running read started.
      await this.#syncing;
      if (!force) return;
    }
    this.#syncing ??= this.#readAppended().finally(() => {
      this.#syncing = undefined;
    });
    await this.#syncing;
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
    const now = this.#seconds();
    if (this.#sessions.size >= this.#maxSessions) this.#prune(now, false);
    while (this.#sessions.size >= this.#maxSessions) {
      const oldest = [...this.#sessions.values()].reduce((a, b) =>
        b.createdAt < a.createdAt ? b : a,
      );
      await this.#revokeSession(oldest, now);
      this.#sessions.delete(oldest.sid);
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
    // Picks up a `grants revoke` from another process for the next request.
    void this.sync();
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
    const session = this.#sessions.get(sid);
    if (session !== undefined) await this.#revokeSession(session, this.#seconds());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#syncing;
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
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
}

/** The bytes of `handle` from `position` to `end` (default: its end). */
async function readFrom(handle: FileHandle, position: number, end?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let at = position;
  for (;;) {
    const length = end === undefined ? 64 * 1024 : Math.min(64 * 1024, end - at);
    if (length <= 0) break;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, at);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    at += bytesRead;
  }
  return Buffer.concat(chunks);
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new StateDirError(`Cannot read ${path} (it must be a regular file, not a symlink).`);
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
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
  startHeartbeat(intervalMs: number): void;
  release(): Promise<void>;
}

const lockSchema = z.object({ pid: z.number(), token: z.string(), beat: z.number() });

async function readLock(path: string): Promise<z.infer<typeof lockSchema> | undefined> {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${newId()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

/** Takes the state directory's lock, or refuses when another live server holds it. */
async function acquireLock(
  dir: string,
  now: () => number,
  log: HttpLog | undefined,
): Promise<Lock> {
  const path = join(dir, LOCK_FILE);
  const token = newId();
  const body = (): string => JSON.stringify({ pid: process.pid, token, beat: now() });
  try {
    await writeFile(path, body(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new StateDirError(`SEVDESK_HTTP_STATE_DIR: cannot write ${dir} (lock file).`);
    }
    const held = await readLock(path);
    let beat = held?.beat;
    if (beat === undefined) {
      try {
        beat = (await stat(path)).mtimeMs;
      } catch {
        beat = 0;
      }
    }
    const age = now() - beat;
    if (age < STALE_LOCK_MS) {
      throw new StateDirError(
        `Another mcp-server-sevdesk server uses ${dir} (its lock was refreshed ` +
          `${String(Math.max(0, Math.round(age / 1000)))} s ago). Only one server may run per ` +
          "state directory: stop the other one, or wait 30 s if it crashed.",
      );
    }
    await writeAtomic(path, body());
    log?.warn("state_lock_taken_over", { ageSeconds: Math.round(age / 1000) });
  }

  let timer: NodeJS.Timeout | undefined;
  let lost = false;
  const ours = async (): Promise<boolean> => (await readLock(path))?.token === token;
  const beat = async (): Promise<void> => {
    if (lost) return;
    if (!(await ours())) {
      lost = true;
      clearInterval(timer);
      log?.warn("state_lock_lost", {});
      return;
    }
    await writeAtomic(path, body());
  };
  return {
    startHeartbeat(intervalMs) {
      if (intervalMs <= 0) return;
      timer = setInterval(() => {
        beat().catch(() => {
          log?.warn("state_lock_heartbeat_failed", {});
        });
      }, intervalMs);
      timer.unref();
    },
    async release() {
      clearInterval(timer);
      if (!lost && (await ours())) await unlink(path).catch(() => undefined);
    },
  };
}
