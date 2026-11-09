import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyProfile,
  describeProfileToken,
  parseProfiles,
  type Profile,
  profilesFilePath,
  readProfilesFile,
} from "../../../src/accounts/profiles.js";
import { ConfigError } from "../../../src/config.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PATH = "/home/me/.config/mcp-server-sevdesk/profiles.json";
const posixOnly = it.skipIf(process.platform === "win32");

function problemsOf(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

async function asyncProblemsOf(action: () => Promise<unknown>): Promise<string[]> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

const parse = (value: unknown): ReturnType<typeof parseProfiles> =>
  parseProfiles(JSON.stringify(value), PATH);

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  name: "work",
  token: undefined,
  values: {},
  ...overrides,
});

describe("profilesFilePath", () => {
  const home = () => "/home/me";

  it("uses SEVDESK_PROFILES_PATH when it is absolute", () => {
    expect(profilesFilePath({ SEVDESK_PROFILES_PATH: "/etc/p.json" }, { homedir: home })).toEqual({
      path: "/etc/p.json",
    });
    expect(
      profilesFilePath({ SEVDESK_PROFILES_PATH: "p.json" }, { platform: "linux", homedir: home }),
    ).toEqual({ problem: "SEVDESK_PROFILES_PATH must be an absolute path to the profiles file." });
  });

  it("follows XDG_CONFIG_HOME, else ~/.config (also on macOS)", () => {
    expect(profilesFilePath({}, { platform: "darwin", homedir: home })).toEqual({ path: PATH });
    expect(
      profilesFilePath({ XDG_CONFIG_HOME: "/xdg" }, { platform: "linux", homedir: home }),
    ).toEqual({ path: "/xdg/mcp-server-sevdesk/profiles.json" });
    expect(
      profilesFilePath({ XDG_CONFIG_HOME: "relative" }, { platform: "linux", homedir: home }),
    ).toEqual({ path: PATH });
  });

  it("uses %APPDATA% on Windows", () => {
    expect(
      profilesFilePath(
        { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        { platform: "win32", homedir: () => "C:\\Users\\me" },
      ),
    ).toEqual({ path: "C:\\Users\\me\\AppData\\Roaming\\mcp-server-sevdesk\\profiles.json" });
    expect(profilesFilePath({}, { platform: "win32", homedir: () => "C:\\Users\\me" })).toEqual({
      path: "C:\\Users\\me\\AppData\\Roaming\\mcp-server-sevdesk\\profiles.json",
    });
    expect(
      profilesFilePath({ SEVDESK_PROFILES_PATH: "D:\\p.json" }, { platform: "win32" }),
    ).toEqual({ path: "D:\\p.json" });
  });
});

describe("parseProfiles", () => {
  it("turns every key into the value of its variable", () => {
    const file = parse({
      version: 1,
      profiles: {
        work: {
          token: { keychain: "work" },
          allow: ["write", "commit"],
          readOnly: false,
          dryRun: true,
          confirm: "browser",
          toolsets: "default,advanced",
          fileDirs: ["/a", "/b"],
          outputDir: "/out",
          auditLog: "/audit.jsonl",
          baseUrl: "https://example.test/api/v1",
          rateLimit: 2.5,
          timeoutMs: 60000,
        },
        demo: { token: { file: "/run/demo.token" } },
        shared: { token: { env: "SEVDESK_TOKEN_SHARED" }, readOnly: true },
        plain: {},
      },
    });

    expect([...file.profiles.keys()]).toEqual(["work", "demo", "shared", "plain"]);
    expect(file.profiles.get("work")).toEqual({
      name: "work",
      token: { kind: "keychain", label: "work" },
      values: {
        allow: "write,commit",
        readOnly: "0",
        dryRun: "1",
        confirm: "browser",
        toolsets: "default,advanced",
        fileDirs: ["/a", "/b"].join(delimiter),
        outputDir: "/out",
        auditLog: "/audit.jsonl",
        baseUrl: "https://example.test/api/v1",
        rateLimit: "2.5",
        timeoutMs: "60000",
      },
    });
    expect(file.profiles.get("demo")?.token).toEqual({ kind: "file", path: "/run/demo.token" });
    expect(file.profiles.get("shared")?.token).toEqual({
      kind: "env",
      name: "SEVDESK_TOKEN_SHARED",
    });
    expect(file.profiles.get("plain")).toEqual({ name: "plain", token: undefined, values: {} });
  });

  it("accepts a byte order mark", () => {
    expect(parseProfiles(`\uFEFF{"version":1,"profiles":{}}`, PATH).profiles.size).toBe(0);
  });

  it("reports invalid JSON by position only, never quoting the text", () => {
    const content = `{\n  "version": 1,\n  "profiles": { "work": { "token": ${TOKEN} } }\n}`;
    const problems = problemsOf(() => parseProfiles(content, PATH));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^Profiles file \/home\/me\/.+ is not valid JSON \(line 3, column \d+\)\.$/,
    );
    expect(problems.join()).not.toContain(TOKEN);
    expect(problemsOf(() => parseProfiles("", PATH))).toEqual([
      `Profiles file ${PATH} is not valid JSON.`,
    ]);
  });

  it("requires version 1 and an object of profiles", () => {
    expect(problemsOf(() => parse({ version: 2, profiles: {} }))).toEqual([
      `Profiles file ${PATH}: version: expected 1 (the only version this server reads).`,
    ]);
    expect(problemsOf(() => parse({ version: 1 }))).toEqual([
      `Profiles file ${PATH}: profiles: expected an object of profiles.`,
    ]);
    expect(problemsOf(() => parse([]))[0]).toMatch(/: the file: /);
  });

  it("refuses unknown keys and names the known ones", () => {
    expect(problemsOf(() => parse({ version: 1, profiles: {}, extra: 1 }))).toEqual([
      `Profiles file ${PATH}: the file: unknown key "extra" (known: version, profiles).`,
    ]);
    const problems = problemsOf(() =>
      parse({ version: 1, profiles: { work: { allow: "write", alow: "x", "b a d": 1 } } }),
    );
    expect(problems).toEqual([
      `Profiles file ${PATH}: profiles.work: unknown keys "alow", "b?a?d" (known: token, allow, ` +
        "readOnly, dryRun, confirm, toolsets, fileDirs, outputDir, auditLog, baseUrl, rateLimit, " +
        "timeoutMs).",
    ]);
    expect(
      problemsOf(() => parse({ version: 1, profiles: { work: { [TOKEN]: true } } })).join(),
    ).not.toContain(TOKEN);
  });

  it("checks the type of every key", () => {
    const problems = problemsOf(() =>
      parse({
        version: 1,
        profiles: {
          work: {
            allow: 3,
            readOnly: "yes",
            rateLimit: "4",
            fileDirs: "/a",
            confirm: ["elicit"],
            toolsets: ["contacts", 1],
          },
        },
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        `Profiles file ${PATH}: profiles.work.allow: expected a string or an array of strings.`,
        `Profiles file ${PATH}: profiles.work.readOnly: expected true or false.`,
        `Profiles file ${PATH}: profiles.work.rateLimit: expected a number.`,
        `Profiles file ${PATH}: profiles.work.fileDirs: expected an array of absolute paths.`,
        `Profiles file ${PATH}: profiles.work.confirm: expected a string.`,
      ]),
    );
  });

  it("never accepts the token itself, and never echoes it", () => {
    for (const token of [TOKEN, { value: TOKEN }, { keychain: "a", file: "/b" }, { keychain: 1 }]) {
      const problems = problemsOf(() => parse({ version: 1, profiles: { work: { token } } }));
      expect(problems).toEqual([
        `Profiles file ${PATH}: profile "work": token must name where the token is kept. Use ` +
          '{"keychain": "<label>"}, {"file": "/absolute/path"} or {"env": ' +
          '"SEVDESK_TOKEN_<NAME>"}: the profiles file never holds the token itself.',
      ]);
    }
    const asLabel = problemsOf(() =>
      parse({ version: 1, profiles: { work: { token: { keychain: TOKEN } } } }),
    );
    expect(asLabel[0]).toMatch(/token\.keychain looks like a sevDesk API token/);
    expect(asLabel.join()).not.toContain(TOKEN);
  });

  it("checks token sources: label, absolute file, SEVDESK_TOKEN_ variable", () => {
    const problems = problemsOf(() =>
      parse({
        version: 1,
        profiles: {
          a: { token: { keychain: "-x" } },
          b: { token: { file: "relative.token" } },
          c: { token: { env: "AWS_SECRET_ACCESS_KEY" } },
          d: { token: { env: "SEVDESK_HTTP_SECRET" } },
        },
      }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/profile "a": token\.keychain must be a name of up to 64/),
      `Profiles file ${PATH}: profile "b": token.file must be an absolute path.`,
      expect.stringMatching(/profile "c": token\.env must name a variable SEVDESK_TOKEN_<NAME>/),
      expect.stringMatching(/profile "d": token\.env must name a variable SEVDESK_TOKEN_<NAME>/),
    ]);
  });

  it("checks profile names without echoing token-shaped ones", () => {
    const problems = problemsOf(() =>
      parse({ version: 1, profiles: { "my work": {}, [TOKEN]: {}, ok: {} } }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/The profile name "my\?work" must be a name of up to 64/),
      expect.stringMatching(/The profile name "\(value\)" looks like a sevDesk API token/),
    ]);
    expect(problems.join()).not.toContain(TOKEN);
  });

  it("refuses folders that contain the path list separator", () => {
    expect(
      problemsOf(() =>
        parse({ version: 1, profiles: { work: { fileDirs: [`/a${delimiter}/b`] } } }),
      ),
    ).toEqual([
      `Profiles file ${PATH}: profile "work": fileDirs entries must not contain '${delimiter}'.`,
    ]);
  });

  it("reports at most ten schema problems", () => {
    const profiles = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`p${i}`, { readOnly: "x" }]),
    );
    expect(problemsOf(() => parse({ version: 1, profiles }))).toHaveLength(10);
  });
});

describe("readProfilesFile", () => {
  let dir: string;
  let file: string;
  const valid = JSON.stringify({ version: 1, profiles: { work: { allow: "write" } } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sevdesk-profiles-"));
    file = join(dir, "profiles.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a valid file and resolves undefined when there is none", async () => {
    await writeFile(file, valid, { mode: 0o600 });

    expect((await readProfilesFile(file))?.profiles.get("work")?.values).toEqual({
      allow: "write",
    });
    expect(await readProfilesFile(join(dir, "missing.json"))).toBeUndefined();
  });

  it("refuses a directory and a file over 64 KiB", async () => {
    expect(await asyncProblemsOf(() => readProfilesFile(dir))).toEqual([
      `The profiles file ${dir} is not a regular file.`,
    ]);
    await writeFile(file, `{"version":1,"profiles":{}}${" ".repeat(64 * 1024)}`, { mode: 0o600 });
    expect(await asyncProblemsOf(() => readProfilesFile(file))).toEqual([
      `The profiles file ${file} is larger than 64 KiB.`,
    ]);
  });

  posixOnly("refuses a file or folder that others can write", async () => {
    await writeFile(file, valid);
    await chmod(file, 0o620);
    expect(await asyncProblemsOf(() => readProfilesFile(file))).toEqual([
      `Other users can change the profiles file ${file}, and a profile can widen tiers and ` +
        `folders. Run \`chmod go-w ${file}\`.`,
    ]);

    await chmod(file, 0o644);
    await chmod(dir, 0o777);
    const problems = await asyncProblemsOf(() => readProfilesFile(file));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Other users can write the folder .+ Run `chmod go-w /);
    await chmod(dir, 0o700);
  });

  posixOnly("refuses a file or folder owned by another user", async () => {
    await writeFile(file, valid, { mode: 0o600 });
    const someoneElse = () => 4242;
    const problems = await asyncProblemsOf(() => readProfilesFile(file, { getuid: someoneElse }));
    expect(problems).toEqual([
      `The profiles file ${file} belongs to another user. A profile can widen tiers and folders, ` +
        "so only a file you own is read: create your own.",
      expect.stringMatching(/^The folder .+ belongs to another user, who could replace the file/),
    ]);
  });

  posixOnly("checks the folder of a symlink and of its target", async () => {
    const target = join(dir, "dotfiles");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "profiles.json"), valid, { mode: 0o600 });
    const linkDir = join(dir, "config");
    await mkdir(linkDir, { mode: 0o700 });
    const link = join(linkDir, "profiles.json");
    await symlink(join(target, "profiles.json"), link);

    expect((await readProfilesFile(link))?.profiles.has("work")).toBe(true);

    await chmod(target, 0o777);
    const problems = await asyncProblemsOf(() => readProfilesFile(link));
    expect(problems).toEqual([expect.stringMatching(/folder .*dotfiles of the profiles file/)]);
    await chmod(target, 0o700);
  });

  it("does not check ownership on Windows", async () => {
    await writeFile(file, valid, { mode: 0o666 });
    await chmod(file, 0o666);

    const read = await readProfilesFile(file, { platform: "win32", getuid: () => 4242 });

    expect(read?.profiles.has("work")).toBe(true);
  });
});

describe("applyProfile", () => {
  it("adds the profile's variables to the environment and records their keys", () => {
    const overlay = applyProfile(
      { SEVDESK_CONFIRM_OPEN: "0" },
      profile({
        token: { kind: "keychain", label: "work" },
        values: { allow: "write", dryRun: "1", fileDirs: "/a" },
      }),
    );

    expect(overlay.problems).toEqual([]);
    expect(overlay.env).toEqual({
      SEVDESK_CONFIRM_OPEN: "0",
      SEVDESK_ALLOW: "write",
      SEVDESK_DRY_RUN: "1",
      SEVDESK_FILE_DIRS: "/a",
      SEVDESK_API_TOKEN_KEYCHAIN: "work",
    });
    expect(Object.fromEntries(overlay.origins)).toEqual({
      SEVDESK_ALLOW: "allow",
      SEVDESK_DRY_RUN: "dryRun",
      SEVDESK_FILE_DIRS: "fileDirs",
      SEVDESK_API_TOKEN_KEYCHAIN: "token.keychain",
    });
  });

  it("refuses a variable set in both places, naming both", () => {
    const overlay = applyProfile(
      { SEVDESK_ALLOW: "read", SEVDESK_BASE_URL: "https://x.test" },
      profile({ values: { allow: "write", baseUrl: "https://y.test", toolsets: "all" } }),
    );

    expect(overlay.problems).toEqual([
      'SEVDESK_ALLOW is set in the environment and by profile "work" (allow). Remove one of them.',
      'SEVDESK_BASE_URL is set in the environment and by profile "work" (baseUrl). Remove one of ' +
        "them.",
    ]);
  });

  it("lets the environment tighten read-only and dry-run, but never loosen them", () => {
    const tightened = applyProfile(
      { SEVDESK_READ_ONLY: "1", SEVDESK_DRY_RUN: "TRUE" },
      profile({ values: { readOnly: "0", dryRun: "0" } }),
    );
    expect(tightened.problems).toEqual([]);
    expect(tightened.env).toMatchObject({ SEVDESK_READ_ONLY: "1", SEVDESK_DRY_RUN: "TRUE" });

    const loosened = applyProfile(
      { SEVDESK_READ_ONLY: "0" },
      profile({ values: { readOnly: "1" } }),
    );
    expect(loosened.problems).toEqual([
      expect.stringMatching(/^SEVDESK_READ_ONLY is set in the environment and by profile/),
    ]);
  });

  it("refuses a profile token next to a token in the environment", () => {
    const overlay = applyProfile(
      { SEVDESK_API_TOKEN: TOKEN, SEVDESK_API_TOKEN_FILE: "/t" },
      profile({ token: { kind: "file", path: "/p" } }),
    );
    expect(overlay.problems).toEqual([
      "SEVDESK_API_TOKEN and SEVDESK_API_TOKEN_FILE are set in the environment, and profile " +
        '"work" names its own token (token.file). Remove one of them.',
    ]);
    expect(overlay.problems.join()).not.toContain(TOKEN);
    expect(
      applyProfile({ SEVDESK_API_TOKEN: TOKEN }, profile({ token: { kind: "file", path: "/p" } }))
        .problems[0],
    ).toMatch(/^SEVDESK_API_TOKEN is set in the environment, and profile/);
  });

  it("maps file and env token sources", () => {
    expect(applyProfile({}, profile({ token: { kind: "file", path: "/run/t" } })).env).toEqual({
      SEVDESK_API_TOKEN_FILE: "/run/t",
    });

    const fromEnv = applyProfile(
      { SEVDESK_TOKEN_WORK: TOKEN },
      profile({ token: { kind: "env", name: "SEVDESK_TOKEN_WORK" } }),
    );
    expect(fromEnv.env["SEVDESK_API_TOKEN"]).toBe(TOKEN);
    expect(fromEnv.origins.get("SEVDESK_API_TOKEN")).toBe("token.env");

    expect(
      applyProfile({}, profile({ token: { kind: "env", name: "SEVDESK_TOKEN_WORK" } })).problems,
    ).toEqual([
      'profile "work" reads its token from SEVDESK_TOKEN_WORK (token.env), which is not set.',
    ]);
  });
});

describe("describeProfileToken", () => {
  it("names the source, never a value", () => {
    expect(describeProfileToken(undefined)).toBe("-");
    expect(describeProfileToken({ kind: "keychain", label: "work" })).toBe("keychain:work");
    expect(describeProfileToken({ kind: "file", path: "/t" })).toBe("file:/t");
    expect(describeProfileToken({ kind: "env", name: "SEVDESK_TOKEN_A" })).toBe(
      "env:SEVDESK_TOKEN_A",
    );
  });
});
