/**
 * The `grants list` and `grants revoke` commands: manage the OAuth grants of a server's state
 * directory (`SEVDESK_HTTP_STATE_DIR`), also while the server runs. Revocations are appended to
 * the grant store file; the running server reads them before its next token request and within
 * a second on `/mcp`, so a revoked client is signed out on its next call. `revoke` reads the file
 * back before it reports success.
 *
 * Grants of a server without a state directory live only in that process and cannot be managed
 * from here.
 */
import { isAbsolute } from "node:path";

import type { Command } from "./cli.js";
import { type Env, nonEmpty } from "./config.js";
import { openGrantStore, StateDirError, unconfirmedRevocations } from "./http/oauth/grant-store.js";
import type { GrantRecord, GrantStore } from "./http/types.js";

export type GrantsCommand = Extract<Command, { kind: "grants-list" | "grants-revoke" }>;

/** Where the command writes; the defaults are stdout and stderr. */
export interface GrantsCommandIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
}

const defaultIo: GrantsCommandIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Runs a `grants` command; resolves to the process exit code. */
export async function runGrantsCommand(
  command: GrantsCommand,
  env: Env,
  io: GrantsCommandIo = defaultIo,
): Promise<number> {
  const now = io.now ?? Date.now;
  const dir = nonEmpty(env["SEVDESK_HTTP_STATE_DIR"]);
  if (dir === undefined || !isAbsolute(dir)) {
    io.err(
      "grants: set SEVDESK_HTTP_STATE_DIR to the server's state directory (an absolute path). " +
        "A server without one keeps its grants in memory; restarting it signs every client out.\n",
    );
    return 1;
  }
  let store: GrantStore;
  try {
    store = await openGrantStore({ stateDir: dir, role: "cli", now });
  } catch (error) {
    if (error instanceof StateDirError) {
      io.err(`grants: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  try {
    return command.kind === "grants-list"
      ? list(store, command.json, now(), io)
      : await revoke(store, command.target, io);
  } catch (error) {
    // A revocation that could not be written, or a file that cannot be read back.
    if (!(error instanceof StateDirError)) throw error;
    io.err(`grants: ${error.message}\n`);
    return 1;
  } finally {
    await store.close();
  }
}

/**
 * Reads the store back after the revocations were appended and says whether they are all in it.
 * "Revoked" is printed only after this: a line the volume cut short is skipped by the server as
 * a torn last line, so the client would have stayed signed in (review 2026-11, round 3).
 */
async function confirmed(store: GrantStore, io: GrantsCommandIo): Promise<boolean> {
  const missing = await unconfirmedRevocations(store);
  if (missing === 0) return true;
  io.err(
    `grants: ${String(missing)} revocation${missing === 1 ? " is" : "s are"} not in the grant ` +
      "store when it is read back, so the server will not apply " +
      `${missing === 1 ? "it" : "them"}. Check the free space of the state directory and run ` +
      "the command again.\n",
  );
  return false;
}

function time(seconds: number | undefined): string {
  return seconds === undefined
    ? "-"
    : new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function statusOf(grant: GrantRecord, nowSeconds: number): string {
  if (grant.status === "revoked") return `revoked (${grant.reason ?? "unknown"})`;
  if (grant.expiresAt <= nowSeconds) return "expired";
  return grant.status;
}

function list(store: GrantStore, json: boolean, nowMs: number, io: GrantsCommandIo): number {
  const grants = store.list();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (json) {
    const rows = grants.map((grant) => ({
      id: grant.gid,
      account: grant.accountId,
      client: grant.clientId,
      clientHost: grant.clientHost,
      tiers: grant.tiers,
      status: grant.status === "active" && grant.expiresAt <= nowSeconds ? "expired" : grant.status,
      reason: grant.reason ?? null,
      createdAt: new Date(grant.createdAt * 1000).toISOString(),
      expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
      lastRefreshAt:
        grant.rotatedAt === undefined ? null : new Date(grant.rotatedAt * 1000).toISOString(),
      revokedAt:
        grant.revokedAt === undefined ? null : new Date(grant.revokedAt * 1000).toISOString(),
    }));
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (grants.length === 0) {
    io.out("No grants.\n");
    return 0;
  }
  const header = [
    "GRANT",
    "ACCOUNT",
    "CLIENT",
    "TIERS",
    "STATUS",
    "CREATED",
    "EXPIRES",
    "LAST REFRESH",
  ];
  const rows = grants.map((grant) => [
    grant.gid,
    grant.accountId,
    clientLabel(grant),
    grant.tiers.join(","),
    statusOf(grant, nowSeconds),
    time(grant.createdAt),
    time(grant.expiresAt),
    time(grant.rotatedAt),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  io.out(`${[line(header), ...rows.map(line)].join("\n")}\n`);
  return 0;
}

async function revoke(
  store: GrantStore,
  target: Extract<GrantsCommand, { kind: "grants-revoke" }>["target"],
  io: GrantsCommandIo,
): Promise<number> {
  if ("grantId" in target) {
    const before = store.get(target.grantId);
    if (before === undefined) {
      io.err(`grants: no grant ${target.grantId}. \`grants list\` shows the ids.\n`);
      return 1;
    }
    if (before.status === "revoked") {
      io.out(`Grant ${target.grantId} was already revoked.\n`);
      return 0;
    }
    await store.revoke(target.grantId, "operator");
    if (!(await confirmed(store, io))) return 1;
    io.out(`Revoked grant ${target.grantId}. Its client is signed out on its next request.\n`);
    return 0;
  }
  const all = !("accountId" in target);
  const count = all
    ? await store.revokeAll("operator")
    : await store.revokeAccount(target.accountId, "operator");
  if (!(await confirmed(store, io))) return 1;
  const scope = all ? "" : ` of account ${target.accountId}`;
  io.out(
    (count === 0
      ? `No active grants${scope}.`
      : `Revoked ${String(count)} active grant${count === 1 ? "" : "s"}${scope}. Their clients are ` +
        "signed out on their next request.") +
      (all ? " Every browser session was signed out as well.\n" : "\n"),
  );
  return 0;
}

/**
 * The client as `host/path` of its CIMD `client_id` (claude.ai and Claude Code share the host
 * `claude.ai` and differ only in the path), or the host when the id is not a URL.
 */
function clientLabel(grant: GrantRecord): string {
  try {
    const url = new URL(grant.clientId);
    return `${url.host}${url.pathname}`;
  } catch {
    return grant.clientHost;
  }
}
