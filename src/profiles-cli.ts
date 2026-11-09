/**
 * The `profiles list` command: shows the profiles of the profiles file (`src/accounts/profiles.ts`)
 * with where each one's token is kept and what it allows. It never prints a token: profiles hold
 * none, and a `token.env` variable is named, not read. The file goes through the same trust
 * checks as at server startup.
 */
import {
  describeProfileToken,
  type Profile,
  type ProfilesFileDeps,
  profilesFilePath,
  type ProfilesPathDeps,
  readProfilesFile,
} from "./accounts/profiles.js";
import { ConfigError, type Env, localNameProblem, nonEmpty } from "./config.js";

/** Where the command writes; the defaults are stdout and stderr. */
export interface ProfilesCommandIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIo: ProfilesCommandIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Runs `profiles list`; resolves to the process exit code. */
export async function runProfilesCommand(
  env: Env,
  io: ProfilesCommandIo = defaultIo,
  deps: ProfilesFileDeps & ProfilesPathDeps = {},
): Promise<number> {
  const location = profilesFilePath(env, deps);
  if ("problem" in location) {
    io.err(`profiles: ${location.problem}\n`);
    return 1;
  }
  let file;
  try {
    file = await readProfilesFile(location.path, deps);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.err(`profiles: ${error.message}\n`);
    return 1;
  }
  if (file === undefined) {
    io.out(
      `No profiles file at ${location.path}. Create one (see Profiles in docs/configuration.md), or set ` +
        "SEVDESK_PROFILES_PATH to yours.\n",
    );
    return 0;
  }
  if (file.profiles.size === 0) {
    io.out(`${file.path} defines no profiles.\n`);
    return 0;
  }
  const active = nonEmpty(env["SEVDESK_PROFILE"]);
  const header = ["", "PROFILE", "TOKEN", "TIERS", "TOOLSETS"];
  const rows = [...file.profiles.values()].map((profile) => [
    profile.name === active ? "*" : "",
    profile.name,
    describeProfileToken(profile.token),
    access(profile),
    profile.values.toolsets ?? "-",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  io.out(`Profiles in ${file.path}:\n${[line(header), ...rows.map(line)].join("\n")}\n`);
  if (active !== undefined && !file.profiles.has(active)) {
    const problem = localNameProblem(active, "SEVDESK_PROFILE");
    io.err(
      `profiles: ${problem ?? `SEVDESK_PROFILE names "${active}", which is not in this file.`}\n`,
    );
  }
  return 0;
}

/** The tiers a profile asks for; `-` when it leaves them to the environment. */
function access(profile: Profile): string {
  const { allow, readOnly, dryRun } = profile.values;
  const parts = [readOnly === "1" ? "read-only" : (allow ?? "-")];
  if (dryRun === "1") parts.push("dry-run");
  return parts.join(", ");
}
