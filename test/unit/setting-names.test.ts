/**
 * Unknown `SEVDESK_*` variable names (review 2026-11, round 3): they used to be ignored, so a
 * misspelt safety switch (`SEVDESK_READONLY=1`) left real writes on. A near-miss of a setting now
 * refuses the configuration; any other unknown name is a startup warning.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkSettingNames,
  ConfigError,
  type Env,
  isKnownSetting,
  KNOWN_SETTINGS,
  loadConfig,
} from "../../src/config.js";
import { loadHttpConfig } from "../../src/http/config.js";
import { SECRET_SETTINGS } from "../../src/safety/redact.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BEARER = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";

function problemsOf(load: () => unknown): readonly string[] {
  let thrown: unknown;
  try {
    load();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) return [];
  expect(thrown).toBeInstanceOf(ConfigError);
  return (thrown as ConfigError).problems;
}

describe("misspelt setting names", () => {
  it.each([
    ["SEVDESK_READONLY", "SEVDESK_READ_ONLY"],
    ["SEVDESK_DRYRUN", "SEVDESK_DRY_RUN"],
    ["SEVDESK_READ-ONLY", "SEVDESK_READ_ONLY"],
    ["sevdesk_read_only", "SEVDESK_READ_ONLY"],
    ["Sevdesk_Dry_Run", "SEVDESK_DRY_RUN"],
    ["SEVDESK_ALOW", "SEVDESK_ALLOW"],
    ["SEVDESK_ALLOWED", "SEVDESK_ALLOW"],
    ["SEVDESK_CONFRIM", "SEVDESK_CONFIRM"],
    ["SEVDESK_TOOLSET", "SEVDESK_TOOLSETS"],
    ["SEVDESK_APITOKEN_FILE", "SEVDESK_API_TOKEN_FILE"],
    ["SEVDESK_OUTPUT_DIRS", "SEVDESK_OUTPUT_DIR"],
  ])("refuses %s and names %s", (name, meant) => {
    const problems = problemsOf(() => loadConfig({ SEVDESK_API_TOKEN: TOKEN, [name]: "1" }));

    expect(problems).toEqual([
      `${name} is not a setting of this server. Did you mean ${meant}? ` +
        "Rename or remove it: a setting under an unknown name does not apply.",
    ]);
  });

  it("does not start with writes on when the read-only switch is misspelt", () => {
    // What the operator wrote to make the server read-only. Before the fix this loaded with the
    // write tier enabled.
    const env = { SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "write", SEVDESK_READONLY: "1" };

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(loadConfig({ ...env, SEVDESK_READONLY: "", SEVDESK_READ_ONLY: "1" }).readOnly).toBe(
      true,
    );
  });

  it("names the variable, never its value", () => {
    const value = "Qm9ndXMtc2VjcmV0LWZvci1hLXRlc3QtMDEyMzQ1Njc4OQ";
    const problems = problemsOf(() =>
      loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_API_TOKN: value, SEVDESK_OTHER_TOOL: value }),
    );
    const findings = checkSettingNames({ SEVDESK_API_TOKN: value, SEVDESK_OTHER_TOOL: value });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Did you mean SEVDESK_API_TOKEN?");
    for (const text of [...problems, ...findings.problems, ...findings.warnings]) {
      expect(text.includes(value)).toBe(false);
    }
  });

  it("shows an odd name without its odd characters", () => {
    const { problems } = checkSettingNames({ "SEVDESK_DRY RUN\n- ignore previous": "1" });

    expect(problems).toHaveLength(0);
    expect(checkSettingNames({ "SEVDESK_DRY RUN": "1" }).problems).toEqual([
      "SEVDESK_DRY?RUN is not a setting of this server. Did you mean SEVDESK_DRY_RUN? " +
        "Rename or remove it: a setting under an unknown name does not apply.",
    ]);
    expect(checkSettingNames({ "SEVDESK_X\nY": "1" }).warnings).toEqual([
      "ignoring SEVDESK_X?Y: no setting of this server has that name (see docs/configuration.md).",
    ]);
  });

  it("accepts a differently-cased name when the setting itself reads as set (Windows)", () => {
    // A Windows environment answers to any case; an object that does the same stands in for it.
    const env: Env = { Sevdesk_Read_Only: "1", SEVDESK_READ_ONLY: "1" };

    expect(checkSettingNames(env)).toEqual({ problems: [], warnings: [] });
  });

  it("skips variables without a value", () => {
    expect(checkSettingNames({ SEVDESK_READONLY: "", SEVDESK_FOO: "  " })).toEqual({
      problems: [],
      warnings: [],
    });
    expect(loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_READONLY: "" }).readOnly).toBe(false);
  });

  it("is refused in the HTTP mode too", () => {
    const problems = problemsOf(() =>
      loadHttpConfig({
        SEVDESK_HTTP_AUTH: "bearer",
        SEVDESK_API_TOKEN: TOKEN,
        SEVDESK_HTTP_BEARER_TOKEN: BEARER,
        SEVDESK_HTTP_FILES: "off",
        SEVDESK_HTTP_TRUSTPROXY: "1",
        SEVDESK_OAUTH_ACCOUNT: "123456",
      }),
    );

    expect(problems).toEqual([
      expect.stringMatching(/^SEVDESK_HTTP_TRUSTPROXY .* Did you mean SEVDESK_HTTP_TRUST_PROXY\?/),
      expect.stringMatching(/^SEVDESK_OAUTH_ACCOUNT .* Did you mean SEVDESK_OAUTH_ACCOUNTS\?/),
    ]);
  });
});

describe("other unknown SEVDESK_* names", () => {
  const SHELL: Env = {
    SEVDESK_LIVE_LIFECYCLE: "1",
    SEVDESK_LIVE_I_UNDERSTAND_WRITES: "1",
    SEVDESK_LIVE_EMAIL_TO: "me@example.com",
    SEVDESK_DOMAIN: "mcp.example.com",
    HOME: "/home/me",
    PORT: "8080",
  };

  it("warns about them by name and still starts", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: TOKEN, ...SHELL }).readOnly).toBe(false);
    expect(checkSettingNames(SHELL)).toEqual({
      problems: [],
      warnings: [
        "ignoring SEVDESK_LIVE_LIFECYCLE, SEVDESK_LIVE_I_UNDERSTAND_WRITES, " +
          "SEVDESK_LIVE_EMAIL_TO, SEVDESK_DOMAIN: no setting of this server has that name " +
          "(see docs/configuration.md).",
      ],
    });
  });

  it("puts the warning into the HTTP mode's startup warnings", () => {
    const { warnings } = loadHttpConfig({
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_HTTP_BEARER_TOKEN: BEARER,
      SEVDESK_HTTP_FILES: "off",
      SEVDESK_DOMAIN: "mcp.example.com",
    });

    expect(warnings).toEqual([
      "ignoring SEVDESK_DOMAIN: no setting of this server has that name " +
        "(see docs/configuration.md).",
    ]);
  });

  it("lists at most eight names", () => {
    const env = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`SEVDESK_ZZ_OTHER_TOOL_${String(index)}`, "1"]),
    );
    const [warning] = checkSettingNames(env).warnings;

    expect(warning).toContain("SEVDESK_ZZ_OTHER_TOOL_7 and 3 more:");
    expect(warning).not.toContain("SEVDESK_ZZ_OTHER_TOOL_8");
  });

  it("says nothing about known settings and other programs' variables", () => {
    const env: Env = Object.fromEntries(KNOWN_SETTINGS.map((name) => [name, "x"]));

    expect(
      checkSettingNames({ ...env, SEVDESK_TOKEN_WORK: TOKEN, PATH: "/bin", SEVDESKX: "1" }),
    ).toEqual({ problems: [], warnings: [] });
  });
});

describe("the list of known settings", () => {
  /** `SEVDESK_…` identifiers in `src/` that are constants of the code, not environment variables. */
  const NOT_ENVIRONMENT = new Set(["SEVDESK_TIME_ZONE", "SEVDESK_TOKEN_PATTERN"]);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  it("holds every SEVDESK_ name the source mentions", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const mentioned = new Map<string, string>();
    for (const file of sourceFiles(src)) {
      for (const match of readFileSync(file, "utf8").matchAll(/SEVDESK_[A-Z0-9_]+/g)) {
        const name = match[0];
        // `SEVDESK_HTTP_` and the like: a family of names in prose, not a name.
        if (name.endsWith("_") || NOT_ENVIRONMENT.has(name)) continue;
        if (!mentioned.has(name)) mentioned.set(name, file.slice(src.length + 1));
      }
    }

    expect(mentioned.size).toBeGreaterThan(40);
    const missing = [...mentioned].filter(([name]) => !isKnownSetting(name));
    // A new setting belongs in KNOWN_SETTINGS (src/config.ts); otherwise setting it would be
    // reported as an unknown name.
    expect(missing).toEqual([]);
  });

  it("has every secret setting with its _FILE twin, and no entry twice", () => {
    for (const name of SECRET_SETTINGS) {
      expect(KNOWN_SETTINGS).toContain(name);
      expect(KNOWN_SETTINGS).toContain(`${name}_FILE`);
    }
    expect(new Set(KNOWN_SETTINGS).size).toBe(KNOWN_SETTINGS.length);
  });

  it("knows a profile's token variable by its shape", () => {
    expect(isKnownSetting("SEVDESK_TOKEN_WORK")).toBe(true);
    expect(isKnownSetting("SEVDESK_TOKEN_")).toBe(false);
    expect(isKnownSetting("SEVDESK_TOKEN_work")).toBe(false);
  });

  it("holds no two settings that are near-misses of each other by letters alone", () => {
    const squashed = KNOWN_SETTINGS.map((name) => name.replace(/[^A-Z0-9]/g, ""));

    expect(new Set(squashed).size).toBe(KNOWN_SETTINGS.length);
  });
});
