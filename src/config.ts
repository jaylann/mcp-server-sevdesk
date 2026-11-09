import { readFileSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

import { isTier, type Tier, TIERS } from "./safety/tiers.js";
import { DEFAULT_TOOLSETS, isToolsetName, type ToolsetName, TOOLSETS } from "./tools/toolsets.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://my.sevdesk.de/api/v1";

export type ConfirmMode = "elicit" | "browser" | "off";
export type StructuredOutputMode = "auto" | "on" | "off";

/**
 * How the server is reached. Texts that tell the user what to change (tool errors, the
 * no-elicitation hint, approval results) depend on it, so stdio wording stays exactly as before.
 */
export type Deployment =
  | { readonly kind: "stdio" }
  | {
      readonly kind: "http";
      readonly auth: "bearer" | "oauth";
      /** Public origin, e.g. `https://mcp.example.com` (no trailing slash, no path). */
      readonly publicOrigin: string;
      /**
       * `SEVDESK_CONFIRM=browser` over HTTP: the approval inbox (`<origin>/approvals`), which the
       * model may name because approving needs a browser session that proves the account.
       */
      readonly approvalsUrl: string | undefined;
      /**
       * Remote file transfer (`SEVDESK_HTTP_FILES`, default on): upload pages and download
       * links that need a browser session of the account (`src/safety/file-access.ts`).
       * Undefined when switched off.
       */
      readonly files?: { readonly ttlSeconds: number } | undefined;
    };

/**
 * Validated runtime configuration for one sevDesk account. Built at startup from the environment
 * by {@link loadConfig} (stdio, bearer) or per account by the HTTP layer (OAuth); immutable.
 * Domain caches are keyed by the config object, so each account needs its own object.
 *
 * Invariant: `token` is a secret. It must never be logged, echoed or put into an error message.
 */
export interface Config extends Settings {
  /** The account's sevDesk API token. Secret. */
  readonly token: string;
  /**
   * The sevDesk account (`SevClient` id) this config serves, when known: always in OAuth mode,
   * in bearer mode once the startup lookup succeeded, never over stdio. Scopes approvals and
   * audit lines; never used for authorization on its own.
   */
  readonly account?: { readonly id: string } | undefined;
  readonly deployment: Deployment;
}

/**
 * Everything in {@link Config} except the account: what one process applies to every account it
 * serves. In OAuth mode the HTTP layer derives one frozen {@link Config} per account from it.
 */
export interface Settings {
  /** sevDesk API base URL, https only, without trailing slash. */
  readonly baseUrl: string;
  /** Effective tiers after applying `SEVDESK_READ_ONLY` (which wins over everything). */
  readonly allowedTiers: ReadonlySet<Tier>;
  readonly readOnly: boolean;
  /** Global dry-run: write tools return what they would send instead of sending it. */
  readonly dryRun: boolean;
  /** How `commit`/`external` tools get human confirmation. */
  readonly confirm: ConfirmMode;
  /**
   * `SEVDESK_CONFIRM=browser`: open each approval page in the user's browser with the OS opener
   * (`SEVDESK_CONFIRM_OPEN`, default on). Off: the link is only written to the server log.
   */
  readonly confirmOpen: boolean;
  readonly toolsets: ReadonlySet<ToolsetName>;
  /** `auto`: outputSchema/structuredContent only for clients on protocol ≥ 2026-07-28. */
  readonly structuredOutput: StructuredOutputMode;
  /** Client-side pacing; sevDesk publishes no rate limit. */
  readonly requestsPerSecond: number;
  readonly timeoutMs: number;
  /** Append-only JSONL log of every mutating call (redacted). */
  readonly auditLogPath: string | undefined;
  /** Where PDFs/exports may be written to disk. */
  readonly outputDir: string | undefined;
  /**
   * Directories local files (receipts, e-invoices) may be read from: absolute paths. Each is
   * resolved to its real path when used; a file must resolve inside one of them
   * (`readConfinedFile`, `src/safety/local-files.ts`). Empty: no tool reads local files.
   */
  readonly fileDirs: readonly string[];
  readonly userAgent: string;
}

/** All problems found in the environment, so users can fix them in one go. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadConfigDeps {
  readFile?: (path: string) => string;
}

/** The process environment, or a test double. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads and validates configuration from environment variables. Throws {@link ConfigError}
 * listing every problem. See README "Configuration" for the variables.
 */
export function loadConfig(env: Env, deps: LoadConfigDeps = {}): Config {
  const readFile = deps.readFile ?? defaultReadFile;
  const problems: string[] = [];
  const token = readToken(env, readFile, problems);
  const settings = readSettings(env, problems);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return { ...settings, token, deployment: { kind: "stdio" } };
}

/**
 * Reads every setting except the token, appending problems instead of throwing, so callers that
 * add their own variables (the HTTP mode) can report everything in one {@link ConfigError}.
 */
export function readSettings(env: Env, problems: string[]): Settings {
  // Read in the order problems were always reported: base URL, then the safety switches.
  const baseUrl = readBaseUrl(env, problems);
  const readOnly = readFlag(env, "SEVDESK_READ_ONLY", problems);
  const requestedTiers = readTiers(env, problems);
  const allowedTiers: ReadonlySet<Tier> = readOnly ? new Set<Tier>(["read"]) : requestedTiers;
  const confirm = readConfirm(env, problems);
  return {
    baseUrl,
    allowedTiers,
    readOnly,
    dryRun: readFlag(env, "SEVDESK_DRY_RUN", problems),
    confirm,
    confirmOpen: readFlag(env, "SEVDESK_CONFIRM_OPEN", problems, true),
    toolsets: readToolsets(env, problems),
    structuredOutput: readEnum(
      env,
      "SEVDESK_STRUCTURED_OUTPUT",
      ["auto", "on", "off"],
      "auto",
      problems,
    ),
    requestsPerSecond: readNumber(env, "SEVDESK_RATE_LIMIT", 4, { min: 0.1, max: 50 }, problems),
    timeoutMs: readNumber(
      env,
      "SEVDESK_TIMEOUT_MS",
      30_000,
      { min: 1_000, max: 300_000 },
      problems,
    ),
    auditLogPath: nonEmpty(env["SEVDESK_AUDIT_LOG"]),
    outputDir: nonEmpty(env["SEVDESK_OUTPUT_DIR"]),
    fileDirs: readAbsolutePaths(env, "SEVDESK_FILE_DIRS", problems),
    userAgent: `${PACKAGE_NAME}/${VERSION} (+https://github.com/jaylann/mcp-server-sevdesk)`,
  };
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** Options of {@link readSecret}. */
export interface ReadSecretOptions {
  /** Report a problem when neither `NAME` nor `NAME_FILE` is set. */
  readonly required: boolean;
  /** Message for a missing required secret (default: "NAME is not set."). */
  readonly missing?: string;
  /**
   * Further checks on the trimmed value; returns a problem (which must not contain the value) or
   * `undefined` when the value is fine.
   */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * Reads a secret from `NAME` or the file named by `NAME_FILE` (not both; Docker and Kubernetes
 * secrets). Problems never contain the value. Returns `undefined` when unset or invalid.
 */
export function readSecret(
  env: Env,
  name: string,
  readFile: (path: string) => string,
  problems: string[],
  options: ReadSecretOptions,
): string | undefined {
  const direct = nonEmpty(env[name]);
  const file = nonEmpty(env[`${name}_FILE`]);
  if (direct && file) {
    problems.push(`Set either ${name} or ${name}_FILE, not both.`);
    return undefined;
  }
  let value: string | undefined = direct;
  if (file) {
    try {
      value = readFile(file).trim();
    } catch {
      problems.push(`${name}_FILE: cannot read ${file}.`);
      return undefined;
    }
  }
  if (!value) {
    if (options.required) problems.push(options.missing ?? `${name} is not set.`);
    return undefined;
  }
  const problem = options.validate?.(value);
  if (problem !== undefined) {
    problems.push(problem);
    return undefined;
  }
  return value;
}

/** The checks every sevDesk API token must pass; a problem, or `undefined` when fine. */
export function sevdeskTokenProblem(token: string, name = "SEVDESK_API_TOKEN"): string | undefined {
  if (/^bearer\s/i.test(token)) {
    return `${name} must be the raw token, without a 'Bearer ' prefix.`;
  }
  if (/\s/.test(token)) {
    return `${name} contains whitespace; paste only the token itself.`;
  }
  return undefined;
}

function readToken(env: Env, readFile: (path: string) => string, problems: string[]): string {
  return (
    readSecret(env, "SEVDESK_API_TOKEN", readFile, problems, {
      required: true,
      missing:
        "SEVDESK_API_TOKEN is not set. Create a token in sevDesk under Settings → Users → API " +
        "token (ideally for a dedicated user) and pass it via your MCP client's env config.",
      validate: (value) => sevdeskTokenProblem(value),
    }) ?? ""
  );
}

function readBaseUrl(env: Env, problems: string[]): string {
  const raw = nonEmpty(env["SEVDESK_BASE_URL"]) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not echoed: a malformed URL may still contain credentials.
    problems.push("SEVDESK_BASE_URL is not a valid URL.");
    return DEFAULT_BASE_URL;
  }
  if (url.protocol !== "https:") {
    problems.push(
      "SEVDESK_BASE_URL must use https (the API token would otherwise travel in clear text).",
    );
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("SEVDESK_BASE_URL must not contain a username or password.");
  }
  if (url.search !== "" || url.hash !== "") {
    // The client appends paths and its own query; a base query or fragment would swallow them.
    problems.push("SEVDESK_BASE_URL must not contain a query string (?…) or fragment (#…).");
  }
  return url.toString().replace(/\/+$/, "");
}

function readTiers(env: Env, problems: string[]): ReadonlySet<Tier> {
  const raw = readList(env["SEVDESK_ALLOW"]);
  if (raw.length === 0) {
    return new Set<Tier>(["read"]);
  }
  const tiers = new Set<Tier>(["read"]);
  for (const value of raw) {
    if (value === "all") {
      TIERS.forEach((tier) => tiers.add(tier));
    } else if (isTier(value)) {
      tiers.add(value);
    } else {
      problems.push(
        `SEVDESK_ALLOW: unknown tier "${value}" (expected ${TIERS.join(", ")} or all).`,
      );
    }
  }
  return tiers;
}

function readToolsets(env: Env, problems: string[]): ReadonlySet<ToolsetName> {
  const raw = readList(env["SEVDESK_TOOLSETS"]);
  if (raw.length === 0) {
    return new Set(DEFAULT_TOOLSETS);
  }
  const toolsets = new Set<ToolsetName>(["meta"]);
  for (const value of raw) {
    if (value === "all") {
      TOOLSETS.forEach((toolset) => toolsets.add(toolset));
    } else if (value === "default") {
      DEFAULT_TOOLSETS.forEach((toolset) => toolsets.add(toolset));
    } else if (isToolsetName(value)) {
      toolsets.add(value);
    } else {
      problems.push(
        `SEVDESK_TOOLSETS: unknown toolset "${value}" (expected ${TOOLSETS.join(", ")}, default or all).`,
      );
    }
  }
  return toolsets;
}

function readConfirm(env: Env, problems: string[]): ConfirmMode {
  const mode = readEnum<ConfirmMode>(
    env,
    "SEVDESK_CONFIRM",
    ["elicit", "browser", "off"],
    "elicit",
    problems,
  );
  if (mode === "off" && !readFlag(env, "SEVDESK_I_UNDERSTAND_NO_CONFIRM", problems)) {
    problems.push(
      "SEVDESK_CONFIRM=off disables human confirmation for legally binding actions. " +
        "Also set SEVDESK_I_UNDERSTAND_NO_CONFIRM=1 if you really want that.",
    );
  }
  return mode;
}

function readFlag(env: Env, name: string, problems: string[], fallback = false): boolean {
  const raw = nonEmpty(env[name])?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  problems.push(`${name}: expected 1/0 or true/false, got "${raw}".`);
  return fallback;
}

export function readEnum<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const raw = nonEmpty(env[name])?.toLowerCase();
  if (raw === undefined) return fallback;
  const match = allowed.find((value) => value === raw);
  if (match === undefined) {
    problems.push(`${name}: expected one of ${allowed.join(", ")}, got "${raw}".`);
    return fallback;
  }
  return match;
}

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  range: { min: number; max: number },
  problems: string[],
): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    problems.push(
      `${name}: expected a number between ${range.min} and ${range.max}, got "${raw}".`,
    );
    return fallback;
  }
  return value;
}

/** Comma-separated keyword list, case-insensitive. */
export function readList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/** Path list separated like PATH (`:` on POSIX, `;` on Windows); case is preserved. */
function readPathList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A {@link readPathList} whose entries must be absolute: a relative entry would depend on the
 * client's working directory, which the user rarely knows.
 */
function readAbsolutePaths(env: Env, name: string, problems: string[]): string[] {
  const paths = readPathList(env[name]);
  const relative = paths.filter((path) => !isAbsolute(path));
  if (relative.length > 0) {
    problems.push(
      `${name}: every directory must be an absolute path (got ${relative.map((p) => JSON.stringify(p)).join(", ")}).`,
    );
    return [];
  }
  return paths;
}

export function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
