/**
 * Contract of browser approvals (`SEVDESK_CONFIRM=browser`), independent of where the human sees
 * them:
 * - over stdio, a local page on 127.0.0.1, reached through a single-use launch link
 *   (`approval-local.ts`);
 * - over HTTP, the server's own approval inbox (`/approvals`), unlocked per browser by proving
 *   the account (`src/http/approval-routes.ts`).
 *
 * The {@link ApprovalStore} holds the records; an {@link ApprovalChannel} makes a new record
 * reachable for the human. Records are owned by a {@link RequestPrincipal}: a retry only takes an
 * approval created for its own grant, and the inbox lists and decides per account.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import type { WriteTier } from "./tiers.js";
import type { ConfirmationPreview } from "./write-types.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** What an approval is bound to and shows. */
export interface ApprovalBinding {
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tier: WriteTier;
  readonly argsHash: string;
  /**
   * The `argsHash` the call's audit lines carry, when it differs from `argsHash` (a tool that
   * logs masked arguments, `WriteToolDefinition.auditArgs`): the decision's audit line uses it,
   * so no line holds the hash of the full arguments.
   */
  readonly auditArgsHash?: string;
  readonly previewHash: string;
  /** Already sanitized with `displayPreview`. */
  readonly preview: ConfirmationPreview;
  /**
   * The preview in German (sanitized as well), shown instead of `preview` to a reader whose
   * browser asks for German. `previewHash` covers it.
   */
  readonly previewDe?: ConfirmationPreview;
  /** The call that asked; carried into the audit lines of the decision and the execution. */
  readonly callId: string;
  /**
   * The record changed after the human was first asked, so this is a new request: the page says
   * so above the preview.
   */
  readonly recordChanged?: boolean;
}

/** A pending or decided approval, as the write flow sees it. */
export interface ApprovalTicket {
  /** Random 256-bit id (base64url), part of the local page's address; never shown to the model. */
  readonly id: string;
  /** Short, non-secret code shown in the tool result and on the page, so the user can match them. */
  readonly reference: string;
  /** Whether the channel opened a page in the user's browser when the approval was created. */
  readonly opened: boolean;
  /** ISO 8601 (UTC). */
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly previewHash: string;
  readonly callId: string;
}

/** A record as a page shows it (the inbox, the local page). */
export interface ApprovalView {
  readonly id: string;
  readonly reference: string;
  readonly owner: RequestPrincipal;
  readonly binding: ApprovalBinding;
  readonly status: ApprovalStatus;
  /** ISO 8601 (UTC). */
  readonly createdAt: string;
  /** ISO 8601 (UTC). */
  readonly expiresAt: string;
}

/** How a record left the store. */
export type ApprovalEnd =
  /** A retry took it: an approved one ran, a rejected one was declined. */
  | "taken"
  /** Its 10 minutes ran out. */
  | "expired"
  /** The same call asked again with a different preview (the record changed): a new request. */
  | "replaced"
  /** It made room for newer records (see the limits on {@link ApprovalStore}). */
  | "evicted";

/**
 * A record that left the store, kept for a while (30 minutes, at most 10 per account scope and 100
 * in all), so a page that still shows it can say what became of it. It holds the action line, not
 * the preview.
 */
export interface ApprovalTrace {
  readonly id: string;
  readonly reference: string;
  readonly owner: RequestPrincipal;
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tier: WriteTier;
  /** The preview's one-line action, in English and (when the tool wrote one) German. */
  readonly action: { readonly en: string; readonly de?: string };
  /** Its status when it left. */
  readonly status: ApprovalStatus;
  readonly end: ApprovalEnd;
  /** `replaced`: the reference code of the request that replaced it. */
  readonly replacedBy?: string;
  /** ISO 8601 (UTC). */
  readonly endedAt: string;
}

/**
 * One decision that covered several requests (ADR 0011): every audit line of it carries the id
 * and the number of requests decided together, so a line that is missing shows.
 */
interface DecisionBatch {
  readonly id: string;
  readonly size: number;
}

/** Why a channel withdrew an approval: its launch link reached a second browser. */
type WithdrawReason = "link_used_twice";

/** A decision made on a page, reported for the audit log. */
export interface ApprovalDecision {
  readonly owner: RequestPrincipal;
  readonly binding: ApprovalBinding;
  readonly reference: string;
  readonly decision: "approved" | "rejected";
  /** Set when the decision covered several requests. */
  readonly batch?: DecisionBatch;
  /** Set when a channel withdrew the approval rather than a human deciding it. */
  readonly reason?: WithdrawReason;
}

/** Outcome of {@link ApprovalStore.decide}. */
export type DecideOutcome = "decided" | "unknown" | "expired" | "already_decided";

/** Thrown by {@link ApprovalStore.create} when too many approvals wait for a decision. */
export class ApprovalLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`${String(limit)} approval requests are already waiting for a decision.`);
    this.name = "ApprovalLimitError";
    this.limit = limit;
  }
}

/**
 * Pending and decided approvals, in memory. Each record expires after 10 minutes (default) and is
 * decided once and taken once. Limits: 5 pending and 20 records per account scope (a scope makes
 * room only among its own records); 100 overall as a last resort. At the overall cap a scope that
 * holds more records than the creating one gives one up (rejected or pending first, an approved,
 * untaken one only when nothing else is left); a scope never loses a record to one that holds as
 * many or more (review 2026-11, round 3).
 */
export interface ApprovalStore {
  /** The unexpired approval of `owner.grantKey` for this tool and argument hash, if any. */
  current(owner: RequestPrincipal, toolName: string, argsHash: string): ApprovalTicket | undefined;
  /**
   * Creates a pending approval for `owner` (replacing the owner's other one for the same tool and
   * arguments) and presents it through the channel. Rejects with {@link ApprovalLimitError} at the
   * per-account pending limit (its subclass `ApprovalStoreFullError` when the whole store is full
   * and nothing can make room), or with the channel's error when it cannot present the page.
   */
  create(owner: RequestPrincipal, binding: ApprovalBinding): Promise<ApprovalTicket>;
  /**
   * Removes the approval and returns its final state; `undefined` when unknown, expired, or not
   * owned by `owner.grantKey`.
   */
  take(owner: RequestPrincipal, id: string): ApprovalTicket | undefined;
  /** Unexpired approvals of one account scope (pending and decided), newest first. */
  list(accountScope: string): readonly ApprovalView[];
  /** One unexpired approval by id (the caller checks the owner before showing it). */
  get(id: string): ApprovalView | undefined;
  /** Records of one account scope that left the store recently, newest first. */
  ended(accountScope: string): readonly ApprovalTrace[];
  /** What became of a record that left the store (the caller checks the owner). */
  trace(id: string): ApprovalTrace | undefined;
  /**
   * Decides a pending approval (once) and reports it through `onDecision`, with `batch` when the
   * human decided several requests together.
   */
  decide(id: string, decision: "approved" | "rejected", batch?: DecisionBatch): DecideOutcome;
  /**
   * Turns an approval that was not taken yet into a rejected one, whatever was decided before,
   * and reports that through `onDecision` (with `reason`). For a channel that learns its page
   * reached someone else: an approval given there must not run. `false` when the approval is
   * unknown, expired or taken already (then the action ran, or will not).
   */
  withdraw(id: string, reason?: WithdrawReason): boolean;
  /**
   * Calls `listener` with the account scope whenever that scope's records change: created,
   * decided, withdrawn, taken, replaced, evicted or expired (expiry is noticed by a timer that
   * never keeps the process alive). Returns the function that stops it. What a listener throws
   * is ignored.
   */
  subscribe(listener: (accountScope: string) => void): () => void;
  /** Most approvals of one account scope that may wait at once. */
  readonly pendingLimit: number;
  /** Forgets every approval and listener and closes the channel. */
  close(): Promise<void>;
}

/** What a channel's pages may do with the store: show, decide and follow it, never create. */
export type ApprovalDesk = Pick<
  ApprovalStore,
  "get" | "list" | "ended" | "trace" | "decide" | "withdraw" | "subscribe" | "pendingLimit"
>;

/** How new approvals reach the human. */
export interface ApprovalChannel {
  /**
   * `local`: a 127.0.0.1 page per approval, logged to stderr and opened with the OS opener.
   * `remote`: the HTTP server's inbox, which lists the account's approvals.
   */
  readonly kind: "local" | "remote";
  /** `remote` only: the inbox URL the model may name (approving needs a browser session). */
  readonly inboxUrl: string | undefined;
  /**
   * Called once by the store factory with the store the channel serves, so a page the channel
   * runs (the local one) can show and decide records.
   */
  attach(desk: ApprovalDesk): void;
  /**
   * Makes a new approval reachable. Resolves whether a page was opened in the user's browser;
   * rejects when it cannot be presented at all (for example, the local server cannot listen).
   */
  present(view: ApprovalView): Promise<{ readonly opened: boolean }>;
  close(): Promise<void>;
}
