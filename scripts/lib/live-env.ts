/**
 * Environment gating shared by everything that talks to a real sevDesk account: the live E2E
 * tests (`pnpm test:live`), the fixture recorder (`pnpm fixtures:record`) and the API probe
 * (`pnpm probe`).
 *
 * sevDesk has no sandbox: every write is real. So these tools never take tier switches from the
 * user's shell. They build their own environment from a short whitelist (token, base URL, pacing,
 * timeout) and add either read-only mode or, behind two explicit opt-ins, the `write` and
 * `commit` tiers. The `external` tier (e-mails) is enabled only together with an address the
 * operator owns ({@link probeEmailAddress}), and e-mails go only to that address.
 */

import type { SevdeskClient } from "../../src/sevdesk/types.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Variables passed through from the caller's environment; everything else is ignored. */
const PASSTHROUGH_VARIABLES = [
  "SEVDESK_API_TOKEN",
  "SEVDESK_API_TOKEN_FILE",
  "SEVDESK_BASE_URL",
  "SEVDESK_RATE_LIMIT",
  "SEVDESK_TIMEOUT_MS",
] as const;

/** Opt-in for the write scenario of `pnpm test:live` (also needs {@link WRITES_ACK_VARIABLE}). */
const LIFECYCLE_VARIABLE = "SEVDESK_LIVE_LIFECYCLE";
/** The second, explicit acknowledgement that writes go to a real (trial) account. */
const WRITES_ACK_VARIABLE = "SEVDESK_LIVE_I_UNDERSTAND_WRITES";
/**
 * Most invoices plus contacts an account may already hold before a write run starts (default
 * {@link DEFAULT_MAX_EXISTING_RECORDS}). A heuristic against running writes on a production
 * account by mistake; a fresh trial has none.
 */
const MAX_EXISTING_VARIABLE = "SEVDESK_LIVE_MAX_EXISTING_RECORDS";
export const DEFAULT_MAX_EXISTING_RECORDS = 60;

/** Prefix of every name and text this tooling writes, so test data is easy to find. */
export const RUN_TAG_PREFIX = "MCP-E2E";

/** Printed before any write run. */
export const WRITE_WARNING = [
  "WARNING: this run WRITES to the sevDesk account behind SEVDESK_API_TOKEN.",
  "sevDesk has no sandbox. Finalized documents cannot be deleted, only cancelled or left alone.",
  "Use a free 14-day trial account only, never a production account.",
  `Everything created is named "${RUN_TAG_PREFIX} <run id>" and listed for cleanup at the end.`,
].join("\n");

/**
 * Why live access is impossible, or `undefined` when a token is configured. Used as the skip
 * reason of live tests and as the error of the scripts.
 */
export function tokenMissingReason(env: Env): string | undefined {
  if (nonEmpty(env["SEVDESK_API_TOKEN"]) || nonEmpty(env["SEVDESK_API_TOKEN_FILE"])) {
    return undefined;
  }
  return (
    "SEVDESK_API_TOKEN is not set: live checks talk to a real sevDesk account and are skipped. " +
    "See docs/recording-session.md."
  );
}

/** Only the whitelisted variables of `env`. */
export function passthrough(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PASSTHROUGH_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") result[name] = value;
  }
  return result;
}

/**
 * Environment for read-only access: every toolset, read tier only, and `SEVDESK_READ_ONLY=1`, so
 * the HTTP client refuses every request that would change data before it is sent.
 */
export function readOnlyEnv(env: Env): Record<string, string> {
  return {
    ...passthrough(env),
    SEVDESK_READ_ONLY: "1",
    SEVDESK_ALLOW: "read",
    SEVDESK_TOOLSETS: "all",
    SEVDESK_STRUCTURED_OUTPUT: "on",
  };
}

/** The live lifecycle's optional e-mail step sends only to this address (one you own). */
const EMAIL_VARIABLE = "SEVDESK_LIVE_EMAIL_TO";

/**
 * Environment for a write run (trial accounts only): `write` and `commit` tiers, no human
 * confirmation (the run is unattended). `external` (e-mails) only with `options.external`, which
 * callers set only when the operator gave an address of their own. Call only after
 * {@link writeGate} or {@link lifecycleGate}.
 */
export function writeEnv(
  env: Env,
  options: { readonly external?: boolean } = {},
): Record<string, string> {
  return {
    ...passthrough(env),
    SEVDESK_ALLOW: options.external === true ? "write,commit,external" : "write,commit",
    SEVDESK_CONFIRM: "off",
    SEVDESK_I_UNDERSTAND_NO_CONFIRM: "1",
    SEVDESK_TOOLSETS: "all",
    SEVDESK_STRUCTURED_OUTPUT: "on",
  };
}

export type Gate = { readonly open: true } | { readonly open: false; readonly reason: string };

/**
 * Whether the lifecycle scenario of `pnpm test:live` may run: a token plus both
 * {@link LIFECYCLE_VARIABLE} and {@link WRITES_ACK_VARIABLE} set to `1`.
 */
export function lifecycleGate(env: Env): Gate {
  const missingToken = tokenMissingReason(env);
  if (missingToken !== undefined) return { open: false, reason: missingToken };
  const lifecycle = isOn(env[LIFECYCLE_VARIABLE]);
  const acknowledged = isOn(env[WRITES_ACK_VARIABLE]);
  if (!lifecycle && !acknowledged) {
    return {
      open: false,
      reason:
        `Lifecycle scenario off (it writes to the account): set ${LIFECYCLE_VARIABLE}=1 and ` +
        `${WRITES_ACK_VARIABLE}=1 on a trial account to run it.`,
    };
  }
  if (!acknowledged) {
    return {
      open: false,
      reason: `${LIFECYCLE_VARIABLE}=1 is set, but writes also need ${WRITES_ACK_VARIABLE}=1.`,
    };
  }
  if (!lifecycle) {
    return {
      open: false,
      reason: `${WRITES_ACK_VARIABLE}=1 is set, but the scenario also needs ${LIFECYCLE_VARIABLE}=1.`,
    };
  }
  return { open: true };
}

/** Whether a script's write mode (`--allow-writes`) may run: the flag plus {@link WRITES_ACK_VARIABLE}. */
export function writeGate(env: Env, allowWritesFlag: boolean): Gate {
  const missingToken = tokenMissingReason(env);
  if (missingToken !== undefined) return { open: false, reason: missingToken };
  if (!allowWritesFlag) return { open: false, reason: "write probes need --allow-writes" };
  if (!isOn(env[WRITES_ACK_VARIABLE])) {
    return {
      open: false,
      reason: `--allow-writes also needs ${WRITES_ACK_VARIABLE}=1 (trial accounts only).`,
    };
  }
  return { open: true };
}

/**
 * A single plain e-mail address the operator owns, for e-mail probes (`--probe-email`) and the
 * lifecycle's optional e-mail step ({@link EMAIL_VARIABLE}); `undefined` when none was given.
 * Throws for anything that is not exactly one address.
 */
export function probeEmailAddress(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/.test(value)) {
    throw new Error("The probe e-mail address must be exactly one plain address you own.");
  }
  return value;
}

/** {@link EMAIL_VARIABLE} from `env`, validated. */
export function lifecycleEmail(env: Env): string | undefined {
  return probeEmailAddress(env[EMAIL_VARIABLE]);
}

/** The record limit for {@link trialCheck}: {@link MAX_EXISTING_VARIABLE} or the default. */
export function maxExistingRecords(env: Env): number {
  const raw = nonEmpty(env[MAX_EXISTING_VARIABLE]);
  if (raw === undefined) return DEFAULT_MAX_EXISTING_RECORDS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${MAX_EXISTING_VARIABLE} must be a whole number of 0 or more.`);
  }
  return value;
}

/**
 * Heuristic before writing: a fresh trial account holds (almost) no invoices and contacts, a
 * production account many. Returns why the run is refused, or `undefined`. Pass the counts of
 * {@link foreignRecordCounts}, which leaves out records this tooling created itself.
 */
export function trialCheck(
  counts: { readonly invoices: number; readonly contacts: number },
  limit: number,
): string | undefined {
  const total = counts.invoices + counts.contacts;
  if (total <= limit) return undefined;
  return (
    `Refusing to write: the account already holds ${counts.invoices} invoices and ` +
    `${counts.contacts} contacts (limit ${limit}), which does not look like a fresh trial ` +
    `account. If it really is a trial account, raise ${MAX_EXISTING_VARIABLE}.`
  );
}

/**
 * Invoices and contacts in the account that this tooling did not create (their header or name
 * does not start with {@link RUN_TAG_PREFIX}), for {@link trialCheck}. Reads at most 1,000 rows
 * of each; rows beyond that count as foreign.
 */
export async function foreignRecordCounts(
  client: SevdeskClient,
): Promise<{ readonly invoices: number; readonly contacts: number }> {
  const count = async (path: string, query: Record<string, string | number>, field: string) => {
    const page = await client.list(path, query, { limit: 1000 });
    const foreign = page.items.filter((item) => {
      const value = (item as Record<string, unknown> | null)?.[field];
      return !(typeof value === "string" && value.startsWith(RUN_TAG_PREFIX));
    }).length;
    return foreign + Math.max(0, (page.total ?? page.items.length) - page.items.length);
  };
  return {
    invoices: await count("/Invoice", {}, "header"),
    contacts: await count("/Contact", { depth: 1 }, "name"),
  };
}

/**
 * `MCP-E2E 20261107-2130-k3f9`: a run id from the Berlin wall clock plus four random
 * characters, so parallel or repeated runs never collide.
 */
export function runTag(now: Date = new Date(), random: () => number = Math.random): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let index = 0; index < 4; index += 1) {
    suffix += alphabet[Math.floor(random() * alphabet.length)] ?? "x";
  }
  return (
    `${RUN_TAG_PREFIX} ${part("year")}${part("month")}${part("day")}-` +
    `${part("hour")}${part("minute")}-${suffix}`
  );
}

/** Today in Berlin as `YYYY-MM-DD`. */
export function berlinToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isOn(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
