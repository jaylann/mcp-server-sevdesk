import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadLocalConfig, type LocalConfigDeps } from "../../../src/accounts/local-config.js";
import { ConfigError, type Env, loadConfig } from "../../../src/config.js";
import { KeychainError } from "../../../src/safety/keychain.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

/** A keychain double that records the labels it was asked for. */
function fakeKeychain(result: string | Error = TOKEN) {
  const labels: string[] = [];
  return {
    labels,
    keychain: {
      read(label: string): Promise<string> {
        labels.push(label);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

async function problemsOf(env: Env, deps: LocalConfigDeps = {}): Promise<string[]> {
  try {
    await loadLocalConfig(env, deps);
  } catch (error) {
    if (error instanceof ConfigError) {
      expect(error.message).not.toContain(TOKEN);
      expect(inspect(error)).not.toContain(TOKEN);
      return [...error.problems];
    }
    throw error;
  }
  return [];
}

describe("without profiles or the keychain", () => {
  it("equals loadConfig and never touches the keychain", async () => {
    const { keychain, labels } = fakeKeychain();
    const env = { SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "write" };

    const { config, warnings } = await loadLocalConfig(env, { keychain });

    expect(config).toEqual(loadConfig(env));
    expect(config.profile).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(labels).toEqual([]);
  });

  it("reports the same problems as loadConfig", async () => {
    expect(await problemsOf({ SEVDESK_ALLOW: "bogus" })).toEqual([
      expect.stringMatching(/SEVDESK_API_TOKEN is not set/),
      expect.stringMatching(/SEVDESK_ALLOW: unknown tier "bogus"/),
    ]);
  });

  it("ignores SEVDESK_PROFILES_PATH unless SEVDESK_PROFILE is set", async () => {
    const { config } = await loadLocalConfig({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_PROFILES_PATH: "/nonexistent/profiles.json",
    });
    expect(config.token).toBe(TOKEN);
  });
});

describe("SEVDESK_API_TOKEN_KEYCHAIN", () => {
  it("reads the token stored under the label", async () => {
    const { keychain, labels } = fakeKeychain();

    const { config } = await loadLocalConfig({ SEVDESK_API_TOKEN_KEYCHAIN: "work" }, { keychain });

    expect(config.token).toBe(TOKEN);
    expect(labels).toEqual(["work"]);
  });

  it("reports keychain failures with their fixed text", async () => {
    const missing = fakeKeychain(new KeychainError("not_found", 'No token under "work".'));
    expect(
      await problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "work" }, { keychain: missing.keychain }),
    ).toEqual(['SEVDESK_API_TOKEN_KEYCHAIN: No token under "work".']);

    const broken = fakeKeychain(new Error(`helper printed ${TOKEN}`));
    expect(
      await problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "work" }, { keychain: broken.keychain }),
    ).toEqual(["SEVDESK_API_TOKEN_KEYCHAIN: the OS keychain could not be read."]);
  });

  it("accepts a keychain token on Windows", async () => {
    const { keychain, labels } = fakeKeychain();
    const { config } = await loadLocalConfig(
      { SEVDESK_API_TOKEN_KEYCHAIN: "work" },
      { platform: "win32", keychain },
    );
    expect(config.token).toBe(TOKEN);
    expect(labels).toEqual(["work"]);
  });

  it("does not look anything up when the sources conflict or the label is bad", async () => {
    const { keychain, labels } = fakeKeychain();

    expect(
      await problemsOf(
        { SEVDESK_API_TOKEN_KEYCHAIN: "work", SEVDESK_API_TOKEN: TOKEN },
        { keychain },
      ),
    ).toEqual([expect.stringMatching(/^Set only one of SEVDESK_API_TOKEN/)]);
    expect(await problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "a b" }, { keychain })).toEqual([
      expect.stringMatching(/^SEVDESK_API_TOKEN_KEYCHAIN must be a name/),
    ]);
    expect(labels).toEqual([]);
  });
});

describe("SEVDESK_PROFILE", () => {
  let dir: string;
  let path: string;

  const write = (profiles: unknown, mode = 0o600) =>
    writeFile(path, JSON.stringify({ version: 1, profiles }), { mode });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sevdesk-local-config-"));
    path = join(dir, "profiles.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds the config from the chosen profile and names it", async () => {
    await write({
      work: { token: { keychain: "work" }, allow: ["write"], toolsets: "all", dryRun: true },
      home: { token: { keychain: "home" } },
    });
    const { keychain, labels } = fakeKeychain();

    const { config, warnings } = await loadLocalConfig(
      { SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path },
      { keychain },
    );

    expect(config.profile).toBe("work");
    expect(config.token).toBe(TOKEN);
    expect([...config.allowedTiers].sort()).toEqual(["read", "write"]);
    expect(config.dryRun).toBe(true);
    expect(config.toolsets.has("advanced")).toBe(true);
    expect(labels).toEqual(["work"]);
    expect(warnings).toEqual([]);
  });

  it("finds the file under XDG_CONFIG_HOME", async () => {
    const configDir = join(dir, "mcp-server-sevdesk");
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(
      join(configDir, "profiles.json"),
      JSON.stringify({ version: 1, profiles: { ro: { readOnly: true } } }),
      { mode: 0o600 },
    );

    const { config } = await loadLocalConfig({
      SEVDESK_PROFILE: "ro",
      XDG_CONFIG_HOME: dir,
      SEVDESK_API_TOKEN: TOKEN,
    });

    expect(config.readOnly).toBe(true);
    expect(config.profile).toBe("ro");
  });

  it("lets the environment tighten the profile", async () => {
    await write({ work: { allow: "all" } });

    const { config } = await loadLocalConfig({
      SEVDESK_PROFILE: "work",
      SEVDESK_PROFILES_PATH: path,
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_READ_ONLY: "1",
    });

    expect([...config.allowedTiers]).toEqual(["read"]);
  });

  it("explains a missing file, an unknown profile and a bad name", async () => {
    expect(await problemsOf({ SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path })).toEqual([
      `SEVDESK_PROFILE is set to "work", but there is no profiles file at ${path}. Create it (see ` +
        "Profiles in docs/configuration.md), or set SEVDESK_PROFILES_PATH to yours.",
    ]);

    await write({ home: {}, demo: {} });
    expect(await problemsOf({ SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path })).toEqual([
      `SEVDESK_PROFILE: there is no profile "work" in ${path}. Available: home, demo.`,
    ]);
    await write({});
    expect(await problemsOf({ SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path })).toEqual([
      `SEVDESK_PROFILE: there is no profile "work" in ${path}. The file defines no profiles.`,
    ]);

    expect(await problemsOf({ SEVDESK_PROFILE: TOKEN, SEVDESK_PROFILES_PATH: path })).toEqual([
      expect.stringMatching(/^SEVDESK_PROFILE looks like a sevDesk API token/),
    ]);
    expect(await problemsOf({ SEVDESK_PROFILE: "w", SEVDESK_PROFILES_PATH: "rel.json" })).toEqual([
      "SEVDESK_PROFILES_PATH must be an absolute path to the profiles file.",
    ]);
  });

  it("refuses conflicts with the environment before reading the keychain", async () => {
    await write({ work: { token: { keychain: "work" }, allow: "write" } });
    const { keychain, labels } = fakeKeychain();

    const problems = await problemsOf(
      {
        SEVDESK_PROFILE: "work",
        SEVDESK_PROFILES_PATH: path,
        SEVDESK_ALLOW: "read",
        SEVDESK_API_TOKEN: OTHER,
      },
      { keychain },
    );

    expect(problems).toEqual([
      'SEVDESK_ALLOW is set in the environment and by profile "work" (allow). Remove one of them.',
      'SEVDESK_API_TOKEN is set in the environment, and profile "work" names its own token ' +
        "(token.keychain). Remove one of them.",
    ]);
    expect(problems.join()).not.toContain(OTHER);
    expect(labels).toEqual([]);
  });

  it("says which profile key a problem came from", async () => {
    await write({
      work: { token: { keychain: "work" }, allow: "bogus", baseUrl: "http://plain.test" },
    });
    const missing = fakeKeychain(new KeychainError("not_found", "No token stored."));

    const problems = await problemsOf(
      { SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path, SEVDESK_TIMEOUT_MS: "1" },
      { keychain: missing.keychain },
    );

    expect(problems).toEqual([
      'SEVDESK_API_TOKEN_KEYCHAIN: No token stored. (set by profile "work", token.keychain)',
      expect.stringMatching(
        /^SEVDESK_BASE_URL must use https.*\(set by profile "work", baseUrl\)$/,
      ),
      expect.stringMatching(
        /^SEVDESK_ALLOW: unknown tier "bogus".*\(set by profile "work", allow\)$/,
      ),
      expect.stringMatching(/^SEVDESK_TIMEOUT_MS: expected a number between .*"1"\.$/),
    ]);
  });

  it("reads a token named by token.env and never echoes it", async () => {
    await write({ work: { token: { env: "SEVDESK_TOKEN_WORK" } } });

    const { config } = await loadLocalConfig({
      SEVDESK_PROFILE: "work",
      SEVDESK_PROFILES_PATH: path,
      SEVDESK_TOKEN_WORK: TOKEN,
    });
    expect(config.token).toBe(TOKEN);

    const problems = await problemsOf({
      SEVDESK_PROFILE: "work",
      SEVDESK_PROFILES_PATH: path,
      SEVDESK_TOKEN_WORK: `Bearer ${TOKEN}`,
    });
    expect(problems).toEqual([
      "SEVDESK_API_TOKEN must be the raw token, without a 'Bearer ' prefix. (set by profile " +
        '"work", token.env)',
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "warns when a profile's token file is readable by others",
    async () => {
      const tokenFile = join(dir, "work.token");
      await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o644 });
      await write({ work: { token: { file: tokenFile } } });
      const env = { SEVDESK_PROFILE: "work", SEVDESK_PROFILES_PATH: path };

      const loose = await loadLocalConfig(env);
      expect(loose.config.token).toBe(TOKEN);
      expect(loose.warnings).toEqual([
        `the token file of profile "work" (${tokenFile}) can be read by other users of this ` +
          `computer. Run \`chmod 600 ${tokenFile}\`.`,
      ]);
      expect(loose.warnings.join()).not.toContain(TOKEN);

      await chmod(tokenFile, 0o600);
      expect((await loadLocalConfig(env)).warnings).toEqual([]);
      expect((await loadLocalConfig(env, { platform: "win32" })).warnings).toEqual([]);

      await rm(tokenFile);
      expect(await problemsOf(env)).toEqual([
        `SEVDESK_API_TOKEN_FILE: cannot read ${tokenFile}. (set by profile "work", token.file)`,
      ]);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a profiles file others can write", async () => {
    await write({ work: {} }, 0o600);
    await chmod(path, 0o666);

    expect(
      await problemsOf({
        SEVDESK_PROFILE: "work",
        SEVDESK_PROFILES_PATH: path,
        SEVDESK_API_TOKEN: TOKEN,
      }),
    ).toEqual([expect.stringMatching(/^Other users can change the profiles file/)]);
  });
});
