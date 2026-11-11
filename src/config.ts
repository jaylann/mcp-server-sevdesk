import { readFileSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

import { SECRET_SETTINGS, secretFileSetting } from "./safety/redact.js";
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
  /**
   * The local profile this config was built from (`SEVDESK_PROFILE`, stdio only; see
   * `src/accounts/profiles.ts`), for the startup log. Not secret.
   */
  readonly profile?: string | undefined;
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

/** 32 hex characters standing alone: the shape of a sevDesk API token (see `looksLikeToken`). */
const TOKEN_SHAPED_RUN = /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi;

/**
 * `problem` with every sevDesk-token-shaped value replaced by `[redacted]`. Problems quote the
 * value they reject, and they reach stderr, the MCP instructions and `sevdesk_setup_problem` (so
 * the model): a token pasted into the wrong setting must not travel with them (security review
 * 2026-11, finding 8). Other secrets have no fixed shape; whoever shows problems also redacts the
 * configured secret values (`redactSecrets`, see src/index.ts).
 */
export function redactConfigProblem(problem: string): string {
  return problem.replace(TOKEN_SHAPED_RUN, "[redacted]");
}

/** All problems found in the environment, so users can fix them in one go. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const redacted = problems.map(redactConfigProblem);
    super(`Invalid configuration:\n${redacted.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = redacted;
  }
}

/**
 * The outcome of a keychain lookup made before {@link loadConfig}: the token, or a trusted problem
 * text without it.
 */
export type KeychainLookup = { readonly token: string } | { readonly problem: string };

export interface LoadConfigDeps {
  readFile?: (path: string) => string;
  /**
   * The token stored under the `SEVDESK_API_TOKEN_KEYCHAIN` label. The OS keychain is read
   * asynchronously, so `loadLocalConfig` (`src/accounts/local-config.ts`) looks it up first and
   * hands the result in here; without this, that variable is reported as a problem.
   */
  readKeychain?: (label: string) => KeychainLookup;
}

/** The process environment, or a test double. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The variables that name the sevDesk token over stdio; at most one may be set. */
export const TOKEN_VARIABLES = [
  "SEVDESK_API_TOKEN",
  "SEVDESK_API_TOKEN_FILE",
  "SEVDESK_API_TOKEN_KEYCHAIN",
] as const;

/** Which of {@link TOKEN_VARIABLES} are set (non-empty) in `env`. */
export function tokenVariablesIn(env: Env): (typeof TOKEN_VARIABLES)[number][] {
  return TOKEN_VARIABLES.filter((name) => nonEmpty(env[name]) !== undefined);
}

/**
 * Keychain labels and profile names: short, printable, safe in messages and in helper command
 * lines (a leading `-` could be read as an option).
 */
const LOCAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A sevDesk API token is 32 hex characters; a "name" of that shape was most likely pasted wrongly. */
const TOKEN_SHAPED = /^[0-9a-f]{32}$/i;

/** Whether `value` has the shape of a sevDesk API token (and must therefore not be echoed). */
export function looksLikeToken(value: string): boolean {
  return TOKEN_SHAPED.test(value);
}

/**
 * Checks a keychain label or profile name (`what`, e.g. "SEVDESK_API_TOKEN_KEYCHAIN"). Returns a
 * problem or `undefined`. The value itself is never part of the problem: a token pasted into the
 * wrong variable must not end up in a log.
 */
export function localNameProblem(value: string, what: string): string | undefined {
  if (looksLikeToken(value)) {
    return (
      `${what} looks like a sevDesk API token. It takes a name you choose (for example "work"), ` +
      "never the token itself."
    );
  }
  if (!LOCAL_NAME.test(value)) {
    return (
      `${what} must be a name of up to 64 letters, digits, '.', '_' or '-' that starts with a ` +
      'letter or digit (for example "work").'
    );
  }
  return undefined;
}

/**
 * Reads and validates configuration from environment variables. Throws {@link ConfigError}
 * listing every problem. See README "Configuration" for the variables.
 */
export function loadConfig(env: Env, deps: LoadConfigDeps = {}): Config {
  const readFile = deps.readFile ?? defaultReadFile;
  const problems: string[] = [];
  const token = readToken(env, readFile, deps.readKeychain, problems);
  const settings = readSettings(env, problems);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return { ...settings, token, deployment: { kind: "stdio" } };
}

/**
 * Every `SEVDESK_*` environment variable the server reads, in any mode (stdio, `--http`, the CLI
 * commands). The one list {@link checkSettingNames} judges the environment by; a test greps `src/`
 * for `SEVDESK_` names and fails when one is missing here. The secret settings and their `_FILE`
 * twins come from the list the redaction uses, so the two cannot drift either.
 */
export const KNOWN_SETTINGS: readonly string[] = [
  // Every mode.
  "SEVDESK_BASE_URL",
  "SEVDESK_READ_ONLY",
  "SEVDESK_ALLOW",
  "SEVDESK_DRY_RUN",
  "SEVDESK_CONFIRM",
  "SEVDESK_CONFIRM_OPEN",
  "SEVDESK_I_UNDERSTAND_NO_CONFIRM",
  "SEVDESK_TOOLSETS",
  "SEVDESK_STRUCTURED_OUTPUT",
  "SEVDESK_RATE_LIMIT",
  "SEVDESK_TIMEOUT_MS",
  "SEVDESK_AUDIT_LOG",
  "SEVDESK_OUTPUT_DIR",
  "SEVDESK_FILE_DIRS",
  // Secrets (`readSecret`): the value, or the file that holds it.
  ...SECRET_SETTINGS,
  ...SECRET_SETTINGS.map(secretFileSetting),
  // Local installs (stdio): keychain and profiles.
  "SEVDESK_API_TOKEN_KEYCHAIN",
  "SEVDESK_PROFILE",
  "SEVDESK_PROFILES_PATH",
  // `--http`.
  "SEVDESK_HTTP_AUTH",
  "SEVDESK_HTTP_HOST",
  "SEVDESK_HTTP_PORT",
  "SEVDESK_HTTP_PUBLIC_URL",
  "SEVDESK_HTTP_ALLOWED_HOSTS",
  "SEVDESK_HTTP_ALLOWED_ORIGINS",
  "SEVDESK_HTTP_TRUST_PROXY",
  "SEVDESK_HTTP_STATE_DIR",
  "SEVDESK_HTTP_FILES",
  "SEVDESK_HTTP_FILES_MAX_MB",
  "SEVDESK_HTTP_FILES_TTL",
  "SEVDESK_OAUTH_ACCOUNTS",
  "SEVDESK_OAUTH_CLIENTS",
  "SEVDESK_OAUTH_ACCESS_TTL",
  "SEVDESK_OAUTH_REFRESH_IDLE_TTL",
  "SEVDESK_OAUTH_GRANT_TTL",
];

/**
 * Names a profile may take its token from (`{"env": "SEVDESK_TOKEN_<NAME>"}`, see
 * `src/accounts/profiles.ts`): known by their shape, since the profile chooses the name.
 */
const PROFILE_TOKEN_VARIABLE = /^SEVDESK_TOKEN_[A-Z0-9_]{1,48}$/;

/** Whether the server reads a variable of this exact name. */
export function isKnownSetting(name: string): boolean {
  return KNOWN_SETTINGS.includes(name) || PROFILE_TOKEN_VARIABLE.test(name);
}

/** Most single-character edits between a misspelt name and the setting it is taken for. */
const NEAR_MISS_EDITS = 2;
/** Most ignored names one warning lists. */
const MAX_NAMES_IN_WARNING = 8;

/** What {@link checkSettingNames} found; trusted text that names variables, never their values. */
export interface SettingNameFindings {
  /** Misspelt settings: the configuration is refused. */
  readonly problems: readonly string[];
  /** Other unknown `SEVDESK_*` names: ignored, worth a line in the startup log. */
  readonly warnings: readonly string[];
}

/**
 * Judges the `SEVDESK_*` names in `env` that no part of the server reads. Such a variable used to
 * be ignored without a word, so `SEVDESK_READ_ONLY` or `SEVDESK_DRY_RUN` written without the inner
 * underscore left real writes on while the operator believed them off (review 2026-11, round 3).
 * (The misspellings are not written out here: the test that greps `src/` for setting names would
 * take them for settings.)
 *
 * - A near-miss of a known setting (the same name once case and separators are ignored, or at most
 *   {@link NEAR_MISS_EDITS} edits away) is a problem, so the server does not start with it: the
 *   setting the operator meant may be a safety switch.
 * - Any other unknown name is a warning only: shells carry `SEVDESK_*` variables of other tools
 *   (this repository's live tests use `SEVDESK_LIVE_…`).
 *
 * Variables without a value are skipped (they set nothing), and so is a differently-cased name
 * whose upper-case form reads as set: Windows environments ignore case.
 */
export function checkSettingNames(env: Env): SettingNameFindings {
  const problems: string[] = [];
  const ignored: string[] = [];
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith("SEVDESK_") || nonEmpty(env[name]) === undefined) continue;
    if (isKnownSetting(name)) continue;
    if (KNOWN_SETTINGS.includes(upper) && nonEmpty(env[upper]) !== undefined) continue;
    const meant = nearestSetting(upper);
    if (meant === undefined) {
      ignored.push(printableName(name));
    } else {
      problems.push(
        `${printableName(name)} is not a setting of this server. Did you mean ${meant}? ` +
          "Rename or remove it: a setting under an unknown name does not apply.",
      );
    }
  }
  if (ignored.length === 0) return { problems, warnings: [] };
  const listed = ignored.slice(0, MAX_NAMES_IN_WARNING).join(", ");
  const more = ignored.length - MAX_NAMES_IN_WARNING;
  return {
    problems,
    warnings: [
      redactConfigProblem(
        `ignoring ${listed}${more > 0 ? ` and ${String(more)} more` : ""}: no setting of this ` +
          "server has that name (see docs/configuration.md).",
      ),
    ],
  };
}

/** The known setting `upper` (an upper-cased unknown name) is a near-miss of, if any. */
function nearestSetting(upper: string): string | undefined {
  const squashed = withoutSeparators(upper);
  const sameLetters = KNOWN_SETTINGS.find((known) => withoutSeparators(known) === squashed);
  if (sameLetters !== undefined) return sameLetters;
  let nearest: string | undefined;
  let fewest = NEAR_MISS_EDITS + 1;
  for (const known of KNOWN_SETTINGS) {
    const edits = editDistance(upper, known);
    if (edits < fewest) {
      nearest = known;
      fewest = edits;
    }
  }
  return nearest;
}

/** A name without `_`, `-` and other separators, so a setting spelt without them compares equal. */
function withoutSeparators(name: string): string {
  return name.replace(/[^A-Z0-9]/g, "");
}

/** Levenshtein distance (insert, delete, replace). Names are short, so the full table is fine. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const replace = (previous[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      current.push(Math.min(replace, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** A variable name as shown in a message: at most 64 characters, anything unusual as `?`. */
function printableName(name: string): string {
  return name.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, "?");
}

/**
 * Reads every setting except the token, appending problems instead of throwing, so callers that
 * add their own variables (the HTTP mode) can report everything in one {@link ConfigError}.
 * Misspelt setting names ({@link checkSettingNames}) are among the problems; the caller logs the
 * warnings about other unknown names.
 */
export function readSettings(env: Env, problems: string[]): Settings {
  // Read in the order problems were always reported: base URL, then the safety switches.
  const baseUrl = readBaseUrl(env, problems);
  const readOnly = readFlag(env, "SEVDESK_READ_ONLY", problems);
  const requestedTiers = readTiers(env, problems);
  const allowedTiers: ReadonlySet<Tier> = readOnly ? new Set<Tier>(["read"]) : requestedTiers;
  const confirm = readConfirm(env, problems);
  const settings: Settings = {
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
  problems.push(...checkSettingNames(env).problems);
  return settings;
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
      // Only an absolute path is quoted. Anything else is more likely the secret itself, pasted
      // into the variable that wants the path, and this text reaches stderr and the model
      // (review 2026-11, round 3).
      problems.push(
        isAbsolute(file)
          ? `${name}_FILE: cannot read ${file}.`
          : `${name}_FILE: cannot read the file it names. It takes the absolute path of a file ` +
              "that holds the value, never the value itself (what it is set to is not shown here).",
      );
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

/**
 * The token from `SEVDESK_API_TOKEN`, `SEVDESK_API_TOKEN_FILE` or the OS keychain label in
 * `SEVDESK_API_TOKEN_KEYCHAIN`: exactly one of them.
 */
function readToken(
  env: Env,
  readFile: (path: string) => string,
  readKeychain: LoadConfigDeps["readKeychain"],
  problems: string[],
): string {
  const label = nonEmpty(env["SEVDESK_API_TOKEN_KEYCHAIN"]);
  if (label === undefined) return readEnvToken(env, readFile, problems);
  if (tokenVariablesIn(env).length > 1) {
    problems.push(
      "Set only one of SEVDESK_API_TOKEN, SEVDESK_API_TOKEN_FILE and SEVDESK_API_TOKEN_KEYCHAIN.",
    );
    return "";
  }
  const labelProblem = localNameProblem(label, "SEVDESK_API_TOKEN_KEYCHAIN");
  if (labelProblem !== undefined) {
    problems.push(labelProblem);
    return "";
  }
  const lookup: KeychainLookup = readKeychain?.(label) ?? {
    problem:
      "SEVDESK_API_TOKEN_KEYCHAIN is read only by the stdio server, which looks the token up in " +
      "the OS keychain at startup.",
  };
  if ("problem" in lookup) {
    problems.push(lookup.problem);
    return "";
  }
  const problem = sevdeskTokenProblem(
    lookup.token,
    `The token stored under keychain label "${label}"`,
  );
  if (problem !== undefined) {
    problems.push(problem);
    return "";
  }
  return lookup.token;
}

function readEnvToken(env: Env, readFile: (path: string) => string, problems: string[]): string {
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

/**
 * An on/off variable: `1`, `true`, `yes`, `on` or `0`, `false`, `no`, `off` (any case); `fallback`
 * when unset; anything else is a problem.
 */
export function readFlag(env: Env, name: string, problems: string[], fallback = false): boolean {
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
