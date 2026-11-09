/**
 * Configuration of the local server (stdio) and of the CLI commands that act for it
 * (`account-id`): the environment, optionally overlaid with a profile (`SEVDESK_PROFILE`, see
 * `profiles.ts`), with the token taken from `SEVDESK_API_TOKEN`, a file, or the OS keychain
 * (`SEVDESK_API_TOKEN_KEYCHAIN`, `src/safety/keychain.ts`).
 *
 * The keychain is read asynchronously, so this runs before the synchronous `loadConfig`, which
 * still validates everything and keeps the "exactly one token source" rule. Without the new
 * variables the result equals `loadConfig(env)`. The HTTP mode never comes here: it refuses these
 * variables (`src/http/config.ts`).
 */
import { stat } from "node:fs/promises";

import {
  type Config,
  ConfigError,
  type Env,
  type KeychainLookup,
  loadConfig,
  localNameProblem,
  nonEmpty,
  tokenVariablesIn,
} from "../config.js";
import { createKeychain, type Keychain, KeychainError } from "../safety/keychain.js";
import {
  applyProfile,
  type Profile,
  type ProfilesFileDeps,
  profilesFilePath,
  type ProfilesPathDeps,
  readProfilesFile,
} from "./profiles.js";

export interface LocalConfigDeps extends ProfilesFileDeps, ProfilesPathDeps {
  /** Reads a token file (default: `fs.readFileSync`, as in `loadConfig`). */
  readonly readFile?: (path: string) => string;
  /** Defaults to the OS keychain of `platform`. */
  readonly keychain?: Pick<Keychain, "read">;
}

/** A validated local configuration. */
export interface LocalConfig {
  /** `profile` is set when `SEVDESK_PROFILE` chose one. */
  readonly config: Config;
  /** Non-fatal findings for the startup log; trusted text without secrets. */
  readonly warnings: readonly string[];
}

/**
 * Builds the stdio {@link Config} from `env`. Rejects with {@link ConfigError} listing the problems
 * (never the token).
 */
export async function loadLocalConfig(env: Env, deps: LocalConfigDeps = {}): Promise<LocalConfig> {
  const platform = deps.platform ?? process.platform;
  const warnings: string[] = [];
  let effective: Env = env;
  let profile: Profile | undefined;
  let origins: ReadonlyMap<string, string> = new Map();

  const profileName = nonEmpty(env["SEVDESK_PROFILE"]);
  if (profileName !== undefined) {
    profile = await selectProfile(env, profileName, deps);
    const overlay = applyProfile(env, profile);
    if (overlay.problems.length > 0) throw new ConfigError(overlay.problems);
    effective = overlay.env;
    origins = overlay.origins;
    const warning = await tokenFileWarning(profile, platform);
    if (warning !== undefined) warnings.push(warning);
  }

  const lookup = await lookupKeychainToken(effective, deps.keychain, platform);
  let config: Config;
  try {
    config = loadConfig(effective, {
      ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }),
      ...(lookup === undefined ? {} : { readKeychain: () => lookup }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError) || profile === undefined) throw error;
    const name = profile.name;
    throw new ConfigError(error.problems.map((problem) => attribute(problem, origins, name)));
  }
  return {
    config: profile === undefined ? config : { ...config, profile: profile.name },
    warnings,
  };
}

/** Reads the profiles file and picks `name` from it; rejects with {@link ConfigError}. */
async function selectProfile(env: Env, name: string, deps: LocalConfigDeps): Promise<Profile> {
  const nameProblem = localNameProblem(name, "SEVDESK_PROFILE");
  if (nameProblem !== undefined) throw new ConfigError([nameProblem]);
  const location = profilesFilePath(env, deps);
  if ("problem" in location) throw new ConfigError([location.problem]);
  const file = await readProfilesFile(location.path, deps);
  if (file === undefined) {
    throw new ConfigError([
      `SEVDESK_PROFILE is set to "${name}", but there is no profiles file at ${location.path}. ` +
        "Create it (see the README, Profiles), or set SEVDESK_PROFILES_PATH to yours.",
    ]);
  }
  const profile = file.profiles.get(name);
  if (profile === undefined) {
    const available = [...file.profiles.keys()];
    throw new ConfigError([
      `SEVDESK_PROFILE: there is no profile "${name}" in ${file.path}. ` +
        (available.length === 0
          ? "The file defines no profiles."
          : `Available: ${available.join(", ")}.`),
    ]);
  }
  return profile;
}

/**
 * Looks the token up when `SEVDESK_API_TOKEN_KEYCHAIN` is the only, well-formed token source;
 * otherwise `loadConfig` reports the problem and nothing is read.
 */
async function lookupKeychainToken(
  env: Env,
  keychain: Pick<Keychain, "read"> | undefined,
  platform: NodeJS.Platform,
): Promise<KeychainLookup | undefined> {
  const label = nonEmpty(env["SEVDESK_API_TOKEN_KEYCHAIN"]);
  if (label === undefined || tokenVariablesIn(env).length !== 1) return undefined;
  if (localNameProblem(label, "SEVDESK_API_TOKEN_KEYCHAIN") !== undefined) return undefined;
  try {
    return { token: await (keychain ?? createKeychain({ platform })).read(label) };
  } catch (error) {
    return {
      problem:
        error instanceof KeychainError
          ? `SEVDESK_API_TOKEN_KEYCHAIN: ${error.message}`
          : "SEVDESK_API_TOKEN_KEYCHAIN: the OS keychain could not be read.",
    };
  }
}

/** POSIX: a profile's token file that group or others can read is worth a warning, not a refusal. */
async function tokenFileWarning(
  profile: Profile,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform === "win32" || profile.token?.kind !== "file") return undefined;
  const path = profile.token.path;
  try {
    if (((await stat(path)).mode & 0o044) === 0) return undefined;
  } catch {
    return undefined; // loadConfig reports a file it cannot read.
  }
  return (
    `the token file of profile "${profile.name}" (${path}) can be read by other users of this ` +
    `computer. Run \`chmod 600 ${path}\`.`
  );
}

/**
 * Appends where a problem's variable came from when the profile set it, e.g.
 * `SEVDESK_ALLOW: unknown tier "x" … (set by profile "work", allow)`.
 */
function attribute(problem: string, origins: ReadonlyMap<string, string>, name: string): string {
  let match: string | undefined;
  for (const variable of origins.keys()) {
    const boundary = problem.charAt(variable.length);
    if (
      problem.startsWith(variable) &&
      !/[A-Z0-9_]/.test(boundary) &&
      (match === undefined || variable.length > match.length)
    ) {
      match = variable;
    }
  }
  return match === undefined
    ? problem
    : `${problem} (set by profile "${name}", ${origins.get(match) ?? ""})`;
}
