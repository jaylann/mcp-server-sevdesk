/**
 * The local audit log (`SEVDESK_AUDIT_LOG`): an append-only JSON Lines file with one line per
 * event of a write call. It records what was asked, what a human decided and what was changed,
 * so a user can reconstruct afterwards what the assistant did in their books.
 *
 * Contract:
 * - unset path → no file, every write is a no-op;
 * - the file is created with mode 0600 (tightened to 0600 if it exists with broader rights) and
 *   opened with `O_APPEND` (and `O_NOFOLLOW` where the platform has it, so a symlink planted at
 *   the path is refused); lines are written one at a time, in call order;
 * - the sevDesk token never reaches the file: every string is redacted, and the whole line again;
 * - `record` rejects when a line could not be written. The write flow treats a failed
 *   `executing` line as fatal (fail closed: nothing is sent), other events as best effort.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { ConfirmationPreview, SevdeskObjectRef } from "../tools/types.js";
import { escapeHiddenCharacters } from "./fence.js";
import { redactSecrets } from "./redact.js";
import type { WriteTier } from "./tiers.js";

/**
 * What happened, roughly in the order a call can produce them. `confirmation_refused`: a retried
 * call presented a confirmation that was replayed, expired or made for other arguments;
 * `approval_decided`: the human pressed Approve or Reject on the local approval page.
 */
type AuditEventName =
  | "dry_run"
  | "confirmation_requested"
  | "confirmation_refused"
  | "approval_decided"
  | "declined"
  | "executing"
  | "executed"
  | "failed";

/** How an executed action was approved. */
export type AuditApproval = "not_required" | "elicit" | "browser" | "confirmation_off";

export interface AuditEvent {
  readonly event: AuditEventName;
  /**
   * Links the lines of one action: minted when the call starts and carried through the
   * confirmation, so the request, the decision and the execution share it.
   */
  readonly callId: string;
  readonly tool: string;
  readonly tier: WriteTier;
  /** `argumentsHash` of the call (tool + arguments without `dryRun`). */
  readonly argsHash: string;
  /**
   * The validated arguments; redacted, hidden characters escaped (`\\u{…}`), long strings capped
   * with a marker. Left out on `approval_decided` (the request line with the same call id has them).
   */
  readonly args?: unknown;
  /** `previewHash` of what was shown or approved (`dry_run`, `confirmation_requested`, `executing`). */
  readonly previewHash?: string;
  /** `confirmation_refused`: why (`replayed_or_expired`, `mismatch`). */
  readonly reason?: string;
  /** `approval_decided`: the decision. */
  readonly decision?: "approved" | "rejected";
  /** `approval_decided`, browser `confirmation_requested`: the approval's non-secret reference code. */
  readonly reference?: string;
  /** `executing`: how the action was approved. */
  readonly approval?: AuditApproval;
  /** `dry_run`, `confirmation_requested`: what was (or would be) shown. */
  readonly preview?: ConfirmationPreview;
  /** `executed`: records changed; `failed`: records an earlier step already changed. */
  readonly affected?: readonly SevdeskObjectRef[];
  /** `failed`: the error kind (a `SevdeskError` kind, `internal` or `output_invalid`). */
  readonly error?: string;
}

export interface AuditLog {
  /** Whether a path is configured. */
  readonly enabled: boolean;
  /** Appends one line for `event`; rejects when it could not be written. */
  record(event: AuditEvent): Promise<void>;
}

export interface AuditLogOptions {
  /** `SEVDESK_AUDIT_LOG`; `undefined` disables the log. */
  readonly path: string | undefined;
  /** Values that must never appear in the file (the API token). */
  readonly secrets: readonly string[];
  /** Wall clock for the `ts` field; injectable for tests. */
  readonly now?: () => Date;
}

const FILE_MODE = 0o600;
/**
 * Cap for one string inside the logged arguments (code points), above the 12,000 characters a
 * preview shows, so an email text is logged whole.
 */
const MAX_ARG_STRING_LENGTH = 20_000;
/** `O_NOFOLLOW` is POSIX-only; elsewhere it is 0 and adds nothing. */
const OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0);

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const { path, secrets } = options;
  const now = options.now ?? (() => new Date());
  if (path === undefined) {
    return { enabled: false, record: () => Promise.resolve() };
  }

  // Lines are appended strictly one after another, in call order.
  let queue: Promise<void> = Promise.resolve();

  async function append(line: string): Promise<void> {
    const handle = await open(path as string, OPEN_FLAGS, FILE_MODE);
    try {
      const { mode } = await handle.stat();
      if ((mode & 0o077) !== 0) {
        await handle.chmod(FILE_MODE);
      }
      await handle.write(line);
    } finally {
      await handle.close();
    }
  }

  return {
    enabled: true,
    record(event) {
      const line = `${redactSecrets(JSON.stringify(toLine(event, now(), secrets)), secrets)}\n`;
      const written = queue.then(() => append(line));
      queue = written.catch(() => undefined);
      return written;
    },
  };
}

function toLine(event: AuditEvent, at: Date, secrets: readonly string[]): Record<string, unknown> {
  return {
    ts: at.toISOString(),
    event: event.event,
    callId: event.callId,
    tool: event.tool,
    tier: event.tier,
    argsHash: event.argsHash,
    ...(event.args === undefined ? {} : { args: cleanValue(event.args, secrets) }),
    ...(event.previewHash === undefined ? {} : { previewHash: event.previewHash }),
    ...(event.approval === undefined ? {} : { approval: event.approval }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.decision === undefined ? {} : { decision: event.decision }),
    ...(event.reference === undefined ? {} : { reference: event.reference }),
    ...(event.preview === undefined ? {} : { preview: event.preview }),
    ...(event.affected === undefined
      ? {}
      : { affected: event.affected.map(({ objectName, id }) => ({ objectName, id })) }),
    ...(event.error === undefined ? {} : { error: event.error }),
  };
}

/**
 * Deep copy with every string redacted, its hidden characters escaped (kept visible instead of
 * stripped, so the log shows what was sent) and capped with an explicit marker; non-JSON values
 * become their type name.
 */
function cleanValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return capped(escapeHiddenCharacters(redactSecrets(value, secrets), { allowNewlines: true }));
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => cleanValue(item, secrets));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[redactSecrets(key, secrets)] = cleanValue(item, secrets);
      }
    }
    return result;
  }
  return `[${typeof value}]`;
}

function capped(text: string): string {
  if (text.length <= MAX_ARG_STRING_LENGTH) return text;
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_ARG_STRING_LENGTH) return text;
  const omitted = codePoints.length - MAX_ARG_STRING_LENGTH;
  return `${codePoints.slice(0, MAX_ARG_STRING_LENGTH).join("")}… [${omitted} more characters not logged]`;
}
