/**
 * Structured logs of the HTTP mode: one JSON object per line on stderr (stdout stays unused, as in
 * stdio mode). Lines carry an event name and a few scalar fields; request lines are written by the
 * router (route template, status, duration, client IP, an 8-character grant prefix), never
 * headers, bodies, cookies or query strings.
 *
 * Every string that reaches a line is redacted first: the configured secrets (sevDesk token,
 * bearer tokens, the server secret in its encodings), sealed tokens (`sdmcp_..`), and any run of
 * 32 or more hex digits, the shape of a sevDesk API token, because in OAuth mode the server does
 * not know its users' tokens in advance. Over-redaction is the safe failure mode.
 *
 * Remote file transfer logs `upload_received`, `upload_refused` (with a `reason`),
 * `download_served` and `download_refused` with the account, the reference code, the kind and
 * the size; never upload or link ids (they are 256-bit secrets in the URL) or file names.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";

import { grantOf } from "../accounts/types.js";
import { REDACTED, redactSecrets } from "../safety/redact.js";
import { redactSealed } from "./seal.js";
import type { HttpLog, LogFields } from "./types.js";

/** Longest string field written; longer values are cut so one line stays readable. */
export const MAX_LOG_FIELD_LENGTH = 500;

/** Hex runs of at least 32 digits: sevDesk API tokens, hex-encoded secrets. */
const HEX_SECRET_SHAPE = /[0-9a-f]{32,}/gi;

/** Field names the log writes itself; callers cannot overwrite them. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(["time", "level", "event"]);

export interface HttpLogOptions {
  /** Receives each finished line without the newline (default: stderr). */
  readonly write?: (line: string) => void;
  /** Secret values to redact from every line (see `secretsToRedact` in `config.ts`). */
  readonly secrets?: readonly (string | undefined)[];
  /** Epoch ms, for the `time` field (tests pass a fixed clock). */
  readonly now?: () => number;
}

/**
 * Creates the HTTP-mode logger. Never throws: a failing writer drops the line (logging must not
 * take a request down).
 */
export function createHttpLog(options: HttpLogOptions = {}): HttpLog {
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const secrets = (options.secrets ?? []).filter(
    (secret): secret is string => secret !== undefined && secret.length > 0,
  );
  const now = options.now ?? Date.now;

  const emit = (level: "info" | "warn", event: string, fields: LogFields | undefined): void => {
    const record: Record<string, string | number | boolean> = {
      time: new Date(now()).toISOString(),
      level,
      event: clip(redactLogText(event, secrets)),
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined || RESERVED_FIELDS.has(key)) continue;
      record[key] = typeof value === "string" ? clip(redactLogText(value, secrets)) : value;
    }
    try {
      write(JSON.stringify(record));
    } catch {
      // A closed stderr must not fail the request that tried to log.
    }
  };

  return {
    info: (event, fields) => {
      emit("info", event, fields);
    },
    warn: (event, fields) => {
      emit("warn", event, fields);
    },
  };
}

/**
 * Redacts `text` for a log line: the given secrets (with their URL-encoded forms), sealed tokens
 * and long hex runs.
 */
export function redactLogText(text: string, secrets: readonly (string | undefined)[]): string {
  return redactSealed(redactSecrets(text, secrets)).replace(HEX_SECRET_SHAPE, REDACTED);
}

/**
 * The log fields identifying who made an authenticated request: the first 8 characters of the
 * OAuth grant id (enough to find it in `grants list`, too short to be a credential), or `bearer`.
 */
export function principalLogFields(authInfo: AuthInfo | undefined): LogFields {
  const grant = grantOf(authInfo);
  if (grant !== undefined) return { grant: grant.grantId.slice(0, 8) };
  if (authInfo?.clientId === "bearer") return { grant: "bearer" };
  return {};
}

function clip(value: string): string {
  return value.length > MAX_LOG_FIELD_LENGTH
    ? `${value.slice(0, MAX_LOG_FIELD_LENGTH)}…[cut]`
    : value;
}
