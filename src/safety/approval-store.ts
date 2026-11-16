/**
 * The records of browser approvals (`SEVDESK_CONFIRM=browser`), independent of where the human
 * decides them: the {@link ApprovalChannel} (the local 127.0.0.1 page over stdio, the server's
 * approvals inbox over HTTP) makes a new record reachable and decides through {@link
 * ApprovalStore.decide}.
 *
 * Scoping (see {@link RequestPrincipal}): `current` and `take` match only approvals created for
 * the same grant and account, so a retry from another connection, even of the same account, never
 * takes or sees someone else's approval; `list` and the pending limit work per account scope, as
 * the inbox shows them.
 *
 * Each record has a random 256-bit id (a capability for the local page; never shown to the
 * model), a short reference code for humans, expires after 10 minutes and is decided once and
 * taken once.
 *
 * Limits, so that no account can push another account's approvals out (ADR 0007):
 * - 5 pending per account scope (a looping model cannot flood the user; more are refused);
 * - 20 records per account scope, pending and decided: a scope at its cap makes room among its own
 *   records only (oldest rejected first, then oldest approved, then oldest pending);
 * - 100 records overall, a last resort once many scopes are active. Room comes only from scopes
 *   that hold more records than the creating one: the largest of them that has a rejected (else
 *   pending) record gives up its oldest; when they hold only approved, not yet taken records, the
 *   largest gives up its oldest approved one. A scope that holds the most itself makes room among
 *   its own records. So no scope ever loses a record to one that holds as many or more, and a few
 *   accounts that leave approvals unused cannot lock every other account out (review 2026-11,
 *   round 3: five accounts with 20 approved records each used to fill the store, and everyone
 *   else was refused). The owner of a dropped approved record is asked again when the call is
 *   retried, as after an expiry.
 *
 * A record that leaves (taken, expired, replaced, evicted) leaves an {@link ApprovalTrace} for 30
 * minutes, so the approvals workspace can still say what became of a request it showed (ADR
 * 0011), and every change is announced to subscribers per account scope. One timer, set to the
 * next expiry and `unref`ed, makes expiry an event too.
 */
import { randomInt } from "node:crypto";

import type { RequestPrincipal } from "../accounts/types.js";
import {
  type ApprovalBinding,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalEnd,
  ApprovalLimitError,
  type ApprovalStatus,
  type ApprovalStore,
  type ApprovalTicket,
  type ApprovalTrace,
  type ApprovalView,
  type DecideOutcome,
} from "./approval-types.js";
import { randomId } from "./web.js";

export interface ApprovalStoreOptions {
  /** Presents new approvals to the human; attached to the store here, closed with it. */
  readonly channel: ApprovalChannel;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
  /** Lifetime of an approval (default 10 minutes). */
  readonly ttlMs?: number;
  /**
   * Most approvals kept at once, all scopes together (default 100, at least 1); see the module
   * comment for which record makes room.
   */
  readonly maxApprovals?: number;
  /**
   * Most approvals of one account scope kept at once, pending and decided (default 20); the
   * scope's own oldest record (rejected, then approved, then pending) makes room.
   */
  readonly maxPerScope?: number;
  /**
   * Most approvals of one account scope waiting for a decision at once (default 5). Creating
   * another one is refused with {@link ApprovalLimitError}.
   */
  readonly maxPending?: number;
  /** Called once per decision (for the audit log); what it throws is ignored. */
  readonly onDecision?: (decision: ApprovalDecision) => void;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_APPROVALS = 100;
const DEFAULT_MAX_PER_SCOPE = 20;
const DEFAULT_MAX_PENDING = 5;
/** How long, and how many, traces of records that left are kept. */
const TRACE_TTL_MS = 30 * 60 * 1000;
const MAX_TRACES = 100;
const MAX_TRACES_PER_SCOPE = 10;
/** What a scope at its own cap drops first. */
const OWN_EVICTION_ORDER: readonly ApprovalStatus[] = ["rejected", "approved", "pending"];
/** What the overall cap takes from a larger scope first: not an approved, untaken request. */
const SHARED_EVICTION_ORDER: readonly ApprovalStatus[] = ["rejected", "pending"];
/** What it takes from the largest scope when nothing else is left. */
const APPROVED_ONLY: readonly ApprovalStatus[] = ["approved"];

/**
 * Thrown by `create` when the overall cap is reached and no record can make room. With the
 * eviction rules of the module comment this needs a cap below 1; it stays as the answer of last
 * resort. The write flow tells it from the per-account limit (it must not send a user to an
 * inbox that may be empty).
 */
export class ApprovalStoreFullError extends ApprovalLimitError {
  constructor(limit: number) {
    super(limit);
    this.name = "ApprovalStoreFullError";
  }
}
/** Reference codes: no 0/O, 1/I, so they can be read out and compared easily. */
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERENCE_LENGTH = 6;

interface ApprovalRecord {
  readonly id: string;
  readonly owner: RequestPrincipal;
  /** Owner, tool and argument hash: what `current` matches. */
  readonly key: string;
  readonly binding: ApprovalBinding;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly reference: string;
  status: ApprovalStatus;
  opened: boolean;
}

export function createApprovalStore(options: ApprovalStoreOptions): ApprovalStore {
  const { channel } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxApprovals = options.maxApprovals ?? DEFAULT_MAX_APPROVALS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const maxPerScope = options.maxPerScope ?? DEFAULT_MAX_PER_SCOPE;
  /** By id, in creation order. */
  const records = new Map<string, ApprovalRecord>();
  /** Records that left, by id, in the order they left. */
  const traces = new Map<string, { readonly trace: ApprovalTrace; readonly atMs: number }>();
  const listeners = new Set<(accountScope: string) => void>();
  let expiryTimer: NodeJS.Timeout | undefined;

  /** Tells the subscribers which scopes changed; a listener's error never reaches the caller. */
  function notify(scopes: Iterable<string>): void {
    for (const scope of new Set(scopes)) {
      for (const listener of [...listeners]) {
        try {
          listener(scope);
        } catch {
          // A listener (a page's live connection) must never break the store.
        }
      }
    }
  }

  /** Removes `record` and keeps its trace; returns its scope, for {@link notify}. */
  function end(record: ApprovalRecord, how: ApprovalEnd, replacedBy?: string): string {
    records.delete(record.id);
    const scope = record.owner.accountScope;
    const { binding } = record;
    const atMs = now();
    traces.set(record.id, {
      atMs,
      trace: {
        id: record.id,
        reference: record.reference,
        owner: record.owner,
        toolName: binding.toolName,
        toolTitle: binding.toolTitle,
        tier: binding.tier,
        action: {
          en: binding.preview.action,
          ...(binding.previewDe === undefined ? {} : { de: binding.previewDe.action }),
        },
        status: record.status,
        end: how,
        ...(replacedBy === undefined ? {} : { replacedBy }),
        endedAt: new Date(atMs).toISOString(),
      },
    });
    const ofScope = [...traces.values()].filter(({ trace }) => trace.owner.accountScope === scope);
    for (const { trace } of ofScope.slice(0, Math.max(0, ofScope.length - MAX_TRACES_PER_SCOPE))) {
      traces.delete(trace.id);
    }
    for (const id of [...traces.keys()].slice(0, Math.max(0, traces.size - MAX_TRACES))) {
      traces.delete(id);
    }
    return scope;
  }

  function pruneTraces(): void {
    const at = now();
    for (const [id, { atMs }] of traces) {
      if (atMs + TRACE_TTL_MS <= at) traces.delete(id);
    }
  }

  /** Sets the one timer to the next expiry, so expiring is announced without a request. */
  function scheduleExpiry(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    let next = Infinity;
    for (const record of records.values()) next = Math.min(next, record.expiresAtMs);
    if (next === Infinity) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        prune();
      },
      Math.max(0, next - now()),
    );
    // Never keeps the process alive: over stdio it ends when the client leaves.
    expiryTimer.unref();
  }

  /**
   * The ids `create` drops to make room for a new record of `scope` that replaces `key`, or
   * `undefined` when the overall cap cannot be met (nothing is left to drop).
   */
  function evictionsFor(scope: string, key: string): Set<string> | undefined {
    const dropped = new Set<string>();
    for (const record of records.values()) {
      if (record.key === key) dropped.add(record.id);
    }
    const live = (): ApprovalRecord[] =>
      [...records.values()].filter((record) => !dropped.has(record.id));
    // A scope at its own cap makes room among its own records only.
    while (live().filter((record) => record.owner.accountScope === scope).length >= maxPerScope) {
      const victim = oldestOf(live(), scope, OWN_EVICTION_ORDER);
      if (victim === undefined) break;
      dropped.add(victim.id);
    }
    // Last resort: a scope that holds more than the creating one gives a record up.
    while (live().length >= maxApprovals) {
      const current = live();
      const counts = new Map<string, number>();
      for (const record of current) {
        const owner = record.owner.accountScope;
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      const own = counts.get(scope) ?? 0;
      // Only scopes that hold more than the creating one, largest first (scopes of one size in
      // the order of their oldest record): holding more gives no power over a scope that holds
      // as many or fewer.
      const larger = [...counts.entries()]
        .filter(([, count]) => count > own)
        .sort((a, b) => b[1] - a[1])
        .map(([candidate]) => candidate);
      const victim =
        // The largest of them that has a rejected (else pending) record gives up its oldest;
        larger
          .map((candidate) => oldestOf(current, candidate, SHARED_EVICTION_ORDER))
          .find((record) => record !== undefined) ??
        // with only approved, untaken requests left, the largest gives up its oldest one;
        (larger[0] === undefined ? undefined : oldestOf(current, larger[0], APPROVED_ONLY)) ??
        // and a scope that holds the most itself makes room among its own records.
        oldestOf(current, scope, OWN_EVICTION_ORDER);
      if (victim === undefined) return undefined;
      dropped.add(victim.id);
    }
    return dropped;
  }

  /** Ends expired records and announces their scopes; sets the timer to the next expiry. */
  function prune(): void {
    const at = now();
    const changed: string[] = [];
    for (const record of [...records.values()]) {
      if (record.expiresAtMs <= at) changed.push(end(record, "expired"));
    }
    scheduleExpiry();
    notify(changed);
  }

  function ticket(record: ApprovalRecord): ApprovalTicket {
    return {
      id: record.id,
      reference: record.reference,
      opened: record.opened,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      status: record.status,
      previewHash: record.binding.previewHash,
      callId: record.binding.callId,
    };
  }

  function view(record: ApprovalRecord): ApprovalView {
    return {
      id: record.id,
      reference: record.reference,
      owner: record.owner,
      binding: record.binding,
      status: record.status,
      createdAt: new Date(record.createdAtMs).toISOString(),
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  /** A reference code no live record uses (collisions are rare, but the inbox lists by it). */
  function uniqueReference(): string {
    const used = new Set([...records.values()].map((record) => record.reference));
    for (;;) {
      const reference = referenceCode();
      if (!used.has(reference)) return reference;
    }
  }

  const store: ApprovalStore = {
    current(owner, toolName, argsHash) {
      prune();
      const key = recordKey(owner, toolName, argsHash);
      for (const record of records.values()) {
        if (record.key === key) return ticket(record);
      }
      return undefined;
    },
    async create(owner, binding) {
      prune();
      const key = recordKey(owner, binding.toolName, binding.argsHash);
      // The approval this one replaces (same owner, tool and arguments) does not count.
      const waiting = [...records.values()].filter(
        (record) =>
          record.status === "pending" &&
          record.owner.accountScope === owner.accountScope &&
          record.key !== key,
      ).length;
      if (waiting >= maxPending) throw new ApprovalLimitError(maxPending);
      const dropped = evictionsFor(owner.accountScope, key);
      if (dropped === undefined) throw new ApprovalStoreFullError(maxApprovals);
      const createdAtMs = now();
      const record: ApprovalRecord = {
        id: randomId(),
        owner: { grantKey: owner.grantKey, accountScope: owner.accountScope },
        key,
        binding,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
        reference: uniqueReference(),
        status: "pending",
        opened: false,
      };
      // The record this one replaces (same owner, tool and arguments) says by which one.
      const changed = [owner.accountScope];
      for (const id of dropped) {
        const old = records.get(id);
        if (old === undefined) continue;
        changed.push(
          old.key === key ? end(old, "replaced", record.reference) : end(old, "evicted"),
        );
      }
      records.set(record.id, record);
      scheduleExpiry();
      try {
        record.opened = (await channel.present(view(record))).opened;
      } catch (error) {
        // Unreachable for the human: forget it, so it neither blocks a retry nor counts as pending.
        if (records.get(record.id) === record) records.delete(record.id);
        notify(changed);
        throw error;
      }
      notify(changed);
      return ticket(record);
    },
    take(owner, id) {
      prune();
      const record = records.get(id);
      if (record === undefined || !sameOwner(record.owner, owner)) return undefined;
      notify([end(record, "taken")]);
      scheduleExpiry();
      return ticket(record);
    },
    list(accountScope) {
      prune();
      return [...records.values()]
        .filter((record) => record.owner.accountScope === accountScope)
        .reverse()
        .map(view);
    },
    get(id) {
      prune();
      const record = records.get(id);
      return record === undefined ? undefined : view(record);
    },
    ended(accountScope) {
      prune();
      pruneTraces();
      return [...traces.values()]
        .map(({ trace }) => trace)
        .filter((trace) => trace.owner.accountScope === accountScope)
        .reverse();
    },
    trace(id) {
      prune();
      pruneTraces();
      return traces.get(id)?.trace;
    },
    decide(id, decision, batch): DecideOutcome {
      const record = records.get(id);
      if (record === undefined) return "unknown";
      if (record.expiresAtMs <= now()) {
        notify([end(record, "expired")]);
        scheduleExpiry();
        return "expired";
      }
      if (record.status !== "pending") return "already_decided";
      record.status = decision;
      report({
        owner: record.owner,
        binding: record.binding,
        reference: record.reference,
        decision,
        ...(batch === undefined ? {} : { batch }),
      });
      notify([record.owner.accountScope]);
      return "decided";
    },
    withdraw(id, reason): boolean {
      const record = records.get(id);
      if (record === undefined) return false;
      if (record.expiresAtMs <= now()) {
        notify([end(record, "expired")]);
        scheduleExpiry();
        return false;
      }
      // Rejected already: nothing will run, and it was reported when it was decided.
      if (record.status === "rejected") return true;
      record.status = "rejected";
      report({
        owner: record.owner,
        binding: record.binding,
        reference: record.reference,
        decision: "rejected",
        ...(reason === undefined ? {} : { reason }),
      });
      notify([record.owner.accountScope]);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pendingLimit: maxPending,
    async close() {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      records.clear();
      traces.clear();
      listeners.clear();
      await channel.close();
    },
  };

  /** Reports a decision for the audit log; reporting must never undo or hide it. */
  function report(decision: ApprovalDecision): void {
    try {
      options.onDecision?.(decision);
    } catch {
      // Ignored, see above.
    }
  }

  channel.attach({
    get: (id) => store.get(id),
    list: (accountScope) => store.list(accountScope),
    ended: (accountScope) => store.ended(accountScope),
    trace: (id) => store.trace(id),
    decide: (id, decision, batch) => store.decide(id, decision, batch),
    withdraw: (id, reason) => store.withdraw(id, reason),
    subscribe: (listener) => store.subscribe(listener),
    pendingLimit: maxPending,
  });
  return store;
}

/** The oldest record of `scope` with the first status of `order` that has one. */
function oldestOf(
  records: readonly ApprovalRecord[],
  scope: string,
  order: readonly ApprovalStatus[],
): ApprovalRecord | undefined {
  for (const status of order) {
    const found = records.find(
      (record) => record.owner.accountScope === scope && record.status === status,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

function sameOwner(a: RequestPrincipal, b: RequestPrincipal): boolean {
  return a.grantKey === b.grantKey && a.accountScope === b.accountScope;
}

function recordKey(owner: RequestPrincipal, toolName: string, argsHash: string): string {
  return JSON.stringify([owner.grantKey, owner.accountScope, toolName, argsHash]);
}

/** A short code for humans to match prompt and page; `randomInt` keeps every letter equally likely. */
function referenceCode(): string {
  return Array.from(
    { length: REFERENCE_LENGTH },
    () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)] ?? "A",
  ).join("");
}
