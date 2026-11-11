/**
 * Contract of browser approvals (`SEVDESK_CONFIRM=browser`), independent of where the human sees
 * them:
 * - over stdio, a local page on 127.0.0.1 whose URL is a capability (`approval-local.ts`);
 * - over HTTP, the server's own approval inbox (`/approvals`), unlocked per browser by proving
 *   the account (`src/http/approval-routes.ts`).
 *
 * The {@link ApprovalStore} holds the records; an {@link ApprovalChannel} makes a new record
 * reachable for the human. Records are owned by a {@link RequestPrincipal}: a retry only takes an
 * approval created for its own grant, and the inbox lists and decides per account.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import type { ConfirmationPreview } from "../tools/types.js";
import type { WriteTier } from "./tiers.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** What an approval is bound to and shows. */
export interface ApprovalBinding {
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tier: WriteTier;
  readonly argsHash: string;
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
  /** Random 256-bit id (base64url). Secret for the local page (it is the URL); never shown to the model. */
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

/** A decision made on a page, reported for the audit log. */
export interface ApprovalDecision {
  readonly owner: RequestPrincipal;
  readonly binding: ApprovalBinding;
  readonly reference: string;
  readonly decision: "approved" | "rejected";
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
 * room only among its own records); 100 overall as a last resort, never dropping an approved
 * request that was not taken yet.
 */
export interface ApprovalStore {
  /** The unexpired approval of `owner.grantKey` for this tool and argument hash, if any. */
  current(owner: RequestPrincipal, toolName: string, argsHash: string): ApprovalTicket | undefined;
  /**
   * Creates a pending approval for `owner` (replacing the owner's other one for the same tool and
   * arguments) and presents it through the channel. Rejects with {@link ApprovalLimitError} at the
   * per-account pending limit, or with the channel's error when it cannot present the page.
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
  /** Decides a pending approval (once) and reports it through `onDecision`. */
  decide(id: string, decision: "approved" | "rejected"): DecideOutcome;
  /** Forgets every approval and closes the channel. */
  close(): Promise<void>;
}

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
  attach(store: Pick<ApprovalStore, "get" | "decide">): void;
  /**
   * Makes a new approval reachable. Resolves whether a page was opened in the user's browser;
   * rejects when it cannot be presented at all (for example, the local server cannot listen).
   */
  present(view: ApprovalView): Promise<{ readonly opened: boolean }>;
  close(): Promise<void>;
}
