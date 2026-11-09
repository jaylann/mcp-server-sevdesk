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
 * taken once. Limits: 5 pending per account scope (a looping model cannot flood the user), 100
 * records overall (the oldest is dropped).
 */
import { randomInt } from "node:crypto";

import type { RequestPrincipal } from "../accounts/types.js";
import {
  type ApprovalBinding,
  type ApprovalChannel,
  type ApprovalDecision,
  ApprovalLimitError,
  type ApprovalStatus,
  type ApprovalStore,
  type ApprovalTicket,
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
  /** Most approvals kept at once; the oldest is dropped beyond it (default 100). */
  readonly maxApprovals?: number;
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
const DEFAULT_MAX_PENDING = 5;
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
  /** By id, in creation order. */
  const records = new Map<string, ApprovalRecord>();

  function prune(): void {
    const at = now();
    for (const [id, record] of records) {
      if (record.expiresAtMs <= at) records.delete(id);
    }
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
      for (const [id, record] of records) {
        if (record.key === key) records.delete(id);
      }
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
      records.set(record.id, record);
      while (records.size > maxApprovals) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      try {
        record.opened = (await channel.present(view(record))).opened;
      } catch (error) {
        // Unreachable for the human: forget it, so it neither blocks a retry nor counts as pending.
        if (records.get(record.id) === record) records.delete(record.id);
        throw error;
      }
      return ticket(record);
    },
    take(owner, id) {
      prune();
      const record = records.get(id);
      if (record === undefined || !sameOwner(record.owner, owner)) return undefined;
      records.delete(id);
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
    decide(id, decision): DecideOutcome {
      const record = records.get(id);
      if (record === undefined) return "unknown";
      if (record.expiresAtMs <= now()) {
        records.delete(id);
        return "expired";
      }
      if (record.status !== "pending") return "already_decided";
      record.status = decision;
      try {
        options.onDecision?.({
          owner: record.owner,
          binding: record.binding,
          reference: record.reference,
          decision,
        });
      } catch {
        // Reporting must never undo or hide the decision.
      }
      return "decided";
    },
    async close() {
      records.clear();
      await channel.close();
    },
  };
  channel.attach({
    get: (id) => store.get(id),
    decide: (id, decision) => store.decide(id, decision),
  });
  return store;
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
