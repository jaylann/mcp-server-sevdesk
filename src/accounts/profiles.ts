/**
 * Local profiles (stdio only): named setups in one JSON file, picked with `SEVDESK_PROFILE`, for
 * people who keep more than one sevDesk account, or a read-only and a bookkeeping setup, in one
 * MCP client.
 *
 * Location: `SEVDESK_PROFILES_PATH` (absolute), else
 * `$XDG_CONFIG_HOME/mcp-server-sevdesk/profiles.json` or `~/.config/mcp-server-sevdesk/…` (also on
 * macOS), on Windows `%APPDATA%\mcp-server-sevdesk\profiles.json`. The server reads it only when
 * `SEVDESK_PROFILE` is set; `profiles list` reads it on demand.
 *
 * Format: strict JSON of at most 64 KiB, unknown keys refused:
 *
 *     {"version": 1, "profiles": {"work": {"token": {"keychain": "work"}, "allow": ["write"]}}}
 *
 * `token` names where the token is kept, `{"keychain": "<label>"}`, `{"file": "/absolute/path"}`
 * or `{"env": "SEVDESK_TOKEN_<NAME>"}`, never the token itself. Without `token` the usual token
 * variables apply.
 *
 * A profile is an overlay of the same `SEVDESK_*` variables the environment sets
 * ({@link PROFILE_KEYS}), applied by {@link applyProfile} and then validated by the unchanged
 * `loadConfig`: a profile can express nothing the environment cannot. A variable set both in the
 * environment and by the profile is an error naming both, except that the environment may always
 * tighten: `SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` win silently.
 *
 * Trust: a profile can widen tiers and folders, so on POSIX systems the file and its folder must
 * belong to the user (or root) and must not be writable by group or others; otherwise the file is
 * refused. Windows is not checked (documented). Messages never echo values from the file other
 * than profile names, labels, paths and variable names, and never anything token-shaped.
 */
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { delimiter, dirname, posix, win32 } from "node:path";

import { z } from "zod";

import {
  ConfigError,
  type Env,
  localNameProblem,
  looksLikeToken,
  nonEmpty,
  tokenVariablesIn,
} from "../config.js";

/** Largest profiles file read. */
const MAX_FILE_BYTES = 64 * 1024;

/** U+FEFF, the byte order mark (spelled as a code so no invisible character sits in the source). */
const BOM = String.fromCharCode(0xfeff);

/** `O_NONBLOCK` where the platform has it: a FIFO at the path must not block the open. */
const NON_BLOCK: number = (constants as Partial<typeof constants>).O_NONBLOCK ?? 0;

/** Variables a profile may read its token from (`{"env": …}`): only these, never any variable. */
const ENV_TOKEN_NAME = /^SEVDESK_TOKEN_[A-Z0-9_]{1,48}$/;

/** Profile keys other than `token`, and the variable each one sets. */
const PROFILE_KEYS = {
  allow: "SEVDESK_ALLOW",
  readOnly: "SEVDESK_READ_ONLY",
  dryRun: "SEVDESK_DRY_RUN",
  confirm: "SEVDESK_CONFIRM",
  toolsets: "SEVDESK_TOOLSETS",
  fileDirs: "SEVDESK_FILE_DIRS",
  outputDir: "SEVDESK_OUTPUT_DIR",
  auditLog: "SEVDESK_AUDIT_LOG",
  baseUrl: "SEVDESK_BASE_URL",
  rateLimit: "SEVDESK_RATE_LIMIT",
  timeoutMs: "SEVDESK_TIMEOUT_MS",
} as const;

type ProfileKey = keyof typeof PROFILE_KEYS;

/** Variables the environment may set to `1` even when the profile sets them too. */
const TIGHTENING: ReadonlySet<string> = new Set(["SEVDESK_READ_ONLY", "SEVDESK_DRY_RUN"]);
const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** Where a profile's token is kept. */
export type ProfileToken =
  | { readonly kind: "keychain"; readonly label: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "env"; readonly name: string };

/** One validated profile. */
export interface Profile {
  readonly name: string;
  /** Undefined: the token comes from the usual variables. */
  readonly token: ProfileToken | undefined;
  /** Each setting the profile makes, already in the form of its variable's value. */
  readonly values: Readonly<Partial<Record<ProfileKey, string>>>;
}

/** A validated profiles file. */
export interface ProfilesFile {
  readonly path: string;
  /** In file order. */
  readonly profiles: ReadonlyMap<string, Profile>;
}

export interface ProfilesFileDeps {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The current user id (default `process.getuid`); POSIX ownership checks compare against it. */
  readonly getuid?: () => number;
}

export interface ProfilesPathDeps {
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir`. */
  readonly homedir?: () => string;
}

/** Where the profiles file is: `{path}`, or a problem when `SEVDESK_PROFILES_PATH` is unusable. */
export function profilesFilePath(
  env: Env,
  deps: ProfilesPathDeps = {},
): { readonly path: string } | { readonly problem: string } {
  const platform = deps.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const configured = nonEmpty(env["SEVDESK_PROFILES_PATH"]);
  if (configured !== undefined) {
    return paths.isAbsolute(configured)
      ? { path: configured }
      : { problem: "SEVDESK_PROFILES_PATH must be an absolute path to the profiles file." };
  }
  const home = (deps.homedir ?? osHomedir)();
  if (platform === "win32") {
    const appData = nonEmpty(env["APPDATA"]);
    const base =
      appData !== undefined && win32.isAbsolute(appData)
        ? appData
        : win32.join(home, "AppData", "Roaming");
    return { path: win32.join(base, "mcp-server-sevdesk", "profiles.json") };
  }
  const xdg = nonEmpty(env["XDG_CONFIG_HOME"]);
  const base = xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".config");
  return { path: posix.join(base, "mcp-server-sevdesk", "profiles.json") };
}

/**
 * Reads and validates the profiles file at `path`. Resolves `undefined` when there is none;
 * rejects with {@link ConfigError} when it cannot be read, is not trusted (POSIX ownership and
 * mode, see the module comment) or is invalid.
 */
export async function readProfilesFile(
  path: string,
  deps: ProfilesFileDeps = {},
): Promise<ProfilesFile | undefined> {
  const platform = deps.platform ?? process.platform;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NON_BLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new ConfigError([`Cannot read the profiles file ${path}.`]);
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ConfigError([`The profiles file ${path} is not a regular file.`]);
    const uid = platform === "win32" ? undefined : deps.getuid ? deps.getuid() : process.getuid?.();
    if (uid !== undefined) {
      const problems = await trustProblems(path, info, uid);
      if (problems.length > 0) throw new ConfigError(problems);
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (info.size > MAX_FILE_BYTES || bytesRead > MAX_FILE_BYTES) {
      throw new ConfigError([`The profiles file ${path} is larger than 64 KiB.`]);
    }
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([`Cannot read the profiles file ${path}.`]);
  } finally {
    await handle.close();
  }
  return parseProfiles(text, path);
}

/**
 * POSIX: the file and its folder (as written and as resolved through symlinks, e.g. a dotfiles
 * checkout) must belong to `uid` or root and must not be writable by group or others.
 */
async function trustProblems(
  path: string,
  file: { readonly uid: number; readonly mode: number },
  uid: number,
): Promise<string[]> {
  const ownedBy = (owner: number): boolean => owner === uid || owner === 0;
  const problems: string[] = [];
  if (!ownedBy(file.uid)) {
    problems.push(
      `The profiles file ${path} belongs to another user. A profile can widen tiers and folders, ` +
        "so only a file you own is read: create your own.",
    );
  } else if ((file.mode & 0o022) !== 0) {
    problems.push(
      `Other users can change the profiles file ${path}, and a profile can widen tiers and ` +
        `folders. Run \`chmod go-w ${path}\`.`,
    );
  }
  let folders: Set<string>;
  try {
    folders = new Set([await realpath(dirname(path)), dirname(await realpath(path))]);
  } catch {
    return [...problems, `Cannot check the folder of the profiles file ${path}.`];
  }
  for (const folder of folders) {
    const info = await stat(folder);
    if (!ownedBy(info.uid)) {
      problems.push(
        `The folder ${folder} of the profiles file belongs to another user, who could replace ` +
          "the file. Keep the profiles file in a folder you own.",
      );
    } else if ((info.mode & 0o022) !== 0) {
      problems.push(
        `Other users can write the folder ${folder} of the profiles file and replace the file. ` +
          `Run \`chmod go-w ${folder}\`, or move the file into a folder only you can write.`,
      );
    }
  }
  return problems;
}

const text = z.string({ error: "expected a string" }).max(4096, { error: "is too long" });
const list = z.union([text, z.array(text).max(64)], {
  error: "expected a string or an array of strings",
});
const flag = z.boolean({ error: "expected true or false" });
const num = z.number({ error: "expected a number" });

const profileSchema = z.strictObject({
  token: z.unknown().optional(),
  allow: list.optional(),
  readOnly: flag.optional(),
  dryRun: flag.optional(),
  confirm: text.optional(),
  toolsets: list.optional(),
  fileDirs: z.array(text, { error: "expected an array of absolute paths" }).max(64).optional(),
  outputDir: text.optional(),
  auditLog: text.optional(),
  baseUrl: text.optional(),
  rateLimit: num.optional(),
  timeoutMs: num.optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(1, { error: "expected 1 (the only version this server reads)" }),
  profiles: z.record(z.string(), profileSchema, { error: "expected an object of profiles" }),
});

const KNOWN_KEYS: Readonly<Record<number, readonly string[]>> = {
  0: Object.keys(fileSchema.shape),
  2: Object.keys(profileSchema.shape),
};

/**
 * Parses and validates the text of a profiles file read from `path` (named in problems). Throws
 * {@link ConfigError}.
 */
export function parseProfiles(content: string, path: string): ProfilesFile {
  const prefix = `Profiles file ${path}`;
  // Editors on Windows may start the file with a byte order mark.
  const json = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    // JSON.parse messages quote the text around the error, which may be a token: never echo them.
    throw new ConfigError([`${prefix} is not valid JSON${jsonPosition(json, error)}.`]);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.slice(0, 10).map((i) => `${prefix}: ${issue(i)}`));
  }
  const problems: string[] = [];
  const profiles = new Map<string, Profile>();
  for (const [name, entry] of Object.entries(parsed.data.profiles)) {
    const nameProblem = localNameProblem(name, `The profile name "${shown(name)}"`);
    if (nameProblem !== undefined) {
      problems.push(nameProblem);
      continue;
    }
    const where = `profile "${name}"`;
    const token = profileToken(entry.token, where, problems);
    profiles.set(name, { name, token, values: profileValues(entry, where, problems) });
  }
  if (problems.length > 0) throw new ConfigError(problems.map((p) => `${prefix}: ${p}`));
  return { path, profiles };
}

const TOKEN_HINT =
  'Use {"keychain": "<label>"}, {"file": "/absolute/path"} or {"env": "SEVDESK_TOKEN_<NAME>"}: ' +
  "the profiles file never holds the token itself.";

function profileToken(raw: unknown, where: string, problems: string[]): ProfileToken | undefined {
  if (raw === undefined) return undefined;
  const entries =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : [];
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || typeof entry[1] !== "string") {
    problems.push(`${where}: token must name where the token is kept. ${TOKEN_HINT}`);
    return undefined;
  }
  const [kind, value] = entry as [string, string];
  switch (kind) {
    case "keychain": {
      const problem = localNameProblem(value, `${where}: token.keychain`);
      if (problem !== undefined) problems.push(problem);
      return { kind, label: value };
    }
    case "file":
      if (!posix.isAbsolute(value) && !win32.isAbsolute(value)) {
        problems.push(`${where}: token.file must be an absolute path.`);
      }
      return { kind, path: value };
    case "env":
      if (!ENV_TOKEN_NAME.test(value)) {
        problems.push(
          `${where}: token.env must name a variable SEVDESK_TOKEN_<NAME> (capital letters, ` +
            "digits and '_') that holds the token.",
        );
      }
      return { kind, name: value };
    default:
      problems.push(`${where}: token must name where the token is kept. ${TOKEN_HINT}`);
      return undefined;
  }
}

function profileValues(
  entry: z.infer<typeof profileSchema>,
  where: string,
  problems: string[],
): Partial<Record<ProfileKey, string>> {
  const values: Partial<Record<ProfileKey, string>> = {};
  const joined = (value: string | readonly string[]): string =>
    typeof value === "string" ? value : value.join(",");
  if (entry.allow !== undefined) values.allow = joined(entry.allow);
  if (entry.readOnly !== undefined) values.readOnly = entry.readOnly ? "1" : "0";
  if (entry.dryRun !== undefined) values.dryRun = entry.dryRun ? "1" : "0";
  if (entry.confirm !== undefined) values.confirm = entry.confirm;
  if (entry.toolsets !== undefined) values.toolsets = joined(entry.toolsets);
  if (entry.fileDirs !== undefined) {
    if (entry.fileDirs.some((dir) => dir.includes(delimiter))) {
      problems.push(`${where}: fileDirs entries must not contain '${delimiter}'.`);
    }
    values.fileDirs = entry.fileDirs.join(delimiter);
  }
  if (entry.outputDir !== undefined) values.outputDir = entry.outputDir;
  if (entry.auditLog !== undefined) values.auditLog = entry.auditLog;
  if (entry.baseUrl !== undefined) values.baseUrl = entry.baseUrl;
  if (entry.rateLimit !== undefined) values.rateLimit = String(entry.rateLimit);
  if (entry.timeoutMs !== undefined) values.timeoutMs = String(entry.timeoutMs);
  return values;
}

/** The result of {@link applyProfile}. */
export interface ProfileOverlay {
  /** The environment with the profile's variables added. */
  readonly env: Env;
  /** Each variable the profile set, mapped to its profile key (`allow`, `token.keychain`, …). */
  readonly origins: ReadonlyMap<string, string>;
  /** Conflicts with the environment, and a `token.env` variable that is not set. */
  readonly problems: readonly string[];
}

/**
 * Overlays `profile` onto `env` (see the module comment for the conflict rules). The result goes
 * through `loadConfig` like any environment.
 */
export function applyProfile(env: Env, profile: Profile): ProfileOverlay {
  const merged: Record<string, string | undefined> = { ...env };
  const origins = new Map<string, string>();
  const problems: string[] = [];
  const where = `profile "${profile.name}"`;
  for (const key of Object.keys(PROFILE_KEYS) as ProfileKey[]) {
    const value = profile.values[key];
    if (value === undefined) continue;
    const variable = PROFILE_KEYS[key];
    const current = nonEmpty(env[variable])?.toLowerCase();
    if (current !== undefined) {
      if (TIGHTENING.has(variable) && TRUE_VALUES.has(current)) continue;
      problems.push(
        `${variable} is set in the environment and by ${where} (${key}). Remove one of them.`,
      );
      continue;
    }
    merged[variable] = value;
    origins.set(variable, key);
  }
  const token = profile.token;
  if (token !== undefined) {
    const key = `token.${token.kind}`;
    const inEnv = tokenVariablesIn(env);
    if (inEnv.length > 0) {
      problems.push(
        `${inEnv.join(" and ")} ${inEnv.length === 1 ? "is" : "are"} set in the environment, and ` +
          `${where} names its own token (${key}). Remove one of them.`,
      );
    } else if (token.kind === "keychain") {
      merged["SEVDESK_API_TOKEN_KEYCHAIN"] = token.label;
      origins.set("SEVDESK_API_TOKEN_KEYCHAIN", key);
    } else if (token.kind === "file") {
      merged["SEVDESK_API_TOKEN_FILE"] = token.path;
      origins.set("SEVDESK_API_TOKEN_FILE", key);
    } else {
      const value = nonEmpty(env[token.name]);
      if (value === undefined) {
        problems.push(`${where} reads its token from ${token.name} (${key}), which is not set.`);
      } else {
        merged["SEVDESK_API_TOKEN"] = value;
        origins.set("SEVDESK_API_TOKEN", key);
      }
    }
  }
  return { env: merged, origins, problems };
}

/** Where a profile's token comes from, for display (never the token): `keychain:work`, … */
export function describeProfileToken(token: ProfileToken | undefined): string {
  if (token === undefined) return "-";
  switch (token.kind) {
    case "keychain":
      return `keychain:${token.label}`;
    case "file":
      return `file:${token.path}`;
    case "env":
      return `env:${token.name}`;
  }
}

/** A key from the file, safe to show: never token-shaped, only plain characters, short. */
function shown(key: string): string {
  if (looksLikeToken(key)) return "(value)";
  const plain = key.slice(0, 40).replace(/[^A-Za-z0-9_.-]/g, "?");
  return key.length > 40 ? `${plain}…` : plain;
}

function issue(problem: z.core.$ZodIssue): string {
  const where =
    problem.path.length === 0
      ? "the file"
      : problem.path
          .map((part) => (typeof part === "number" ? `[${part}]` : shown(String(part))))
          .join(".");
  if (problem.code === "unrecognized_keys") {
    const keys = problem.keys.map((key) => `"${shown(key)}"`).join(", ");
    const known = KNOWN_KEYS[problem.path.length];
    return (
      `${where}: unknown key${problem.keys.length === 1 ? "" : "s"} ${keys}` +
      (known === undefined ? "." : ` (known: ${known.join(", ")}).`)
    );
  }
  return `${where}: ${problem.message}.`;
}

/** ` (line L, column C)` from a JSON.parse error's position, or nothing. */
function jsonPosition(content: string, error: unknown): string {
  const match = error instanceof SyntaxError ? /position (\d+)/.exec(error.message) : null;
  if (match === null) return "";
  const position = Number(match[1]);
  const before = content.slice(0, position);
  const line = before.split("\n").length;
  const column = position - before.lastIndexOf("\n");
  return ` (line ${line}, column ${column})`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}
