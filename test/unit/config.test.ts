import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_BASE_URL,
  type KeychainLookup,
  loadConfig,
  localNameProblem,
  redactConfigProblem,
  tokenVariablesIn,
} from "../../src/config.js";
import { DEFAULT_TOOLSETS, TOOLSETS } from "../../src/tools/toolsets.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function problemsOf(
  env: Record<string, string>,
  readFile?: (path: string) => string,
  readKeychain?: (label: string) => KeychainLookup,
): string[] {
  try {
    loadConfig(env, {
      ...(readFile ? { readFile } : {}),
      ...(readKeychain ? { readKeychain } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe("loadConfig defaults", () => {
  it("is read-only with confirmation and all default toolsets", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TOKEN });

    expect(config.token).toBe(TOKEN);
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect([...config.allowedTiers]).toEqual(["read"]);
    expect(config.readOnly).toBe(false);
    expect(config.dryRun).toBe(false);
    expect(config.confirm).toBe("elicit");
    expect(config.confirmOpen).toBe(true);
    expect([...config.toolsets].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
    expect(config.toolsets.has("advanced")).toBe(false);
    expect(config.structuredOutput).toBe("auto");
    expect(config.requestsPerSecond).toBe(4);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.auditLogPath).toBeUndefined();
    expect(config.fileDirs).toEqual([]);
    expect(config.userAgent).toMatch(/^mcp-server-sevdesk\/\S+ \(\+https:\/\/github\.com\//);
  });
});

describe("token", () => {
  it("requires a token and explains where to get one", () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SEVDESK_API_TOKEN is not set/);
  });

  it("reads the token from a file and trims it", () => {
    const config = loadConfig(
      { SEVDESK_API_TOKEN_FILE: "/run/secrets/sevdesk" },
      { readFile: () => `${TOKEN}\n` },
    );
    expect(config.token).toBe(TOKEN);
  });

  it("reports an unreadable token file without leaking anything else", () => {
    const problems = problemsOf({ SEVDESK_API_TOKEN_FILE: "/nope" }, () => {
      throw new Error("ENOENT");
    });
    expect(problems).toEqual(["SEVDESK_API_TOKEN_FILE: cannot read /nope."]);
  });

  // Review 2026-11, round 3: the message quoted whatever the variable held, also a pasted secret.
  it("does not quote the value of a _FILE variable that is no absolute path", () => {
    // base64url, as `generate-secret` prints: the token-shape redaction does not know this form.
    const pasted = "Qm9ndXMtc2VjcmV0LWZvci1hLXRlc3QtMDEyMzQ1Njc4OQ";
    const problems = problemsOf({ SEVDESK_API_TOKEN_FILE: pasted }, () => {
      throw new Error("ENOENT");
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^SEVDESK_API_TOKEN_FILE: cannot read the file it names\./);
    expect(problems.join("\n").includes(pasted)).toBe(false);
  });

  it("rejects both token sources at once", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_API_TOKEN_FILE: "/x" })[0]).toMatch(
      /either SEVDESK_API_TOKEN or SEVDESK_API_TOKEN_FILE/,
    );
  });

  it("rejects a Bearer prefix and embedded whitespace", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: `Bearer ${TOKEN}` })[0]).toMatch(/without a 'Bearer '/);
    expect(problemsOf({ SEVDESK_API_TOKEN: "abc def" })[0]).toMatch(/whitespace/);
  });

  it("never puts the token into an error message", () => {
    const secret = "deadbeefdeadbeefdeadbeefdeadbeef";
    // The error is caught first and judged afterwards: an assertion inside the `try` would be
    // swallowed by the `catch`, and the test would pass without any ConfigError (review 2026-11,
    // round 3).
    let thrown: unknown;
    try {
      loadConfig({
        SEVDESK_API_TOKEN: secret,
        SEVDESK_ALLOW: "bogus",
        SEVDESK_BASE_URL: "http://x",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.problems).toHaveLength(2);
    expect(error.problems[0]).toMatch(/SEVDESK_BASE_URL must use https/);
    expect(error.problems[1]).toMatch(/SEVDESK_ALLOW: unknown tier "bogus"/);
    // `includes` instead of `not.toContain`: a failure must not print the text with the secret.
    expect(error.message.includes(secret)).toBe(false);
    expect(error.problems.join("\n").includes(secret)).toBe(false);
  });

  // Security review 2026-11, finding 8: a token pasted into the wrong setting was quoted back.
  it.each([
    ["SEVDESK_ALLOW", "0123456789abcdef0123456789abcdef"],
    ["SEVDESK_CONFIRM", "DEADBEEF0123456789ABCDEF01234567"],
    ["SEVDESK_TOOLSETS", "invoices,4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"],
  ])("does not quote a token-shaped value pasted into %s", (name, misplaced) => {
    const token = /[0-9a-f]{32}/i.exec(misplaced)?.[0] ?? misplaced;
    let problems: readonly string[] = [];
    try {
      loadConfig({ SEVDESK_API_TOKEN: "a1c3".repeat(8), [name]: misplaced });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      problems = (error as ConfigError).problems;
      expect((error as Error).message).not.toContain(token);
    }
    expect(problems.join("\n")).not.toContain(token);
    expect(problems.join("\n")).toContain("[redacted]");
  });

  it("keeps ordinary rejected values readable", () => {
    for (const problem of [
      'SEVDESK_ALLOW: unknown tier "admin" (expected read, write).',
      "SEVDESK_HTTP_STATE_DIR: /tmp/sevdesk-state-5gUhbV is not writable by this process.",
      "SEVDESK_CONFIRM_OPEN opens approval pages in a browser on the server's own machine.",
      // 33 hex characters are not a token.
      `SEVDESK_TOOLSETS: unknown toolset "${"a".repeat(33)}".`,
    ]) {
      expect(redactConfigProblem(problem)).toBe(problem);
    }
  });
});

describe("keychain token source", () => {
  const found = (token: string) => () => ({ token });

  it("takes the token looked up for SEVDESK_API_TOKEN_KEYCHAIN", () => {
    const labels: string[] = [];
    const config = loadConfig(
      { SEVDESK_API_TOKEN_KEYCHAIN: "work" },
      {
        readKeychain: (label) => {
          labels.push(label);
          return { token: TOKEN };
        },
      },
    );
    expect(config.token).toBe(TOKEN);
    expect(labels).toEqual(["work"]);
  });

  it("accepts exactly one of the three token variables", () => {
    const expected =
      "Set only one of SEVDESK_API_TOKEN, SEVDESK_API_TOKEN_FILE and SEVDESK_API_TOKEN_KEYCHAIN.";
    for (const other of ["SEVDESK_API_TOKEN", "SEVDESK_API_TOKEN_FILE"]) {
      expect(
        problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "work", [other]: TOKEN }, () => TOKEN),
      ).toEqual([expected]);
    }
    expect(
      problemsOf({
        SEVDESK_API_TOKEN: TOKEN,
        SEVDESK_API_TOKEN_FILE: "/x",
        SEVDESK_API_TOKEN_KEYCHAIN: "work",
      }),
    ).toEqual([expected]);
    expect(tokenVariablesIn({ SEVDESK_API_TOKEN: " ", SEVDESK_API_TOKEN_KEYCHAIN: "w" })).toEqual([
      "SEVDESK_API_TOKEN_KEYCHAIN",
    ]);
  });

  it("checks the label without echoing it", () => {
    const tokenAsLabel = problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: TOKEN });
    expect(tokenAsLabel).toEqual([
      'SEVDESK_API_TOKEN_KEYCHAIN looks like a sevDesk API token. It takes a name you choose (for example "work"), never the token itself.',
    ]);
    expect(tokenAsLabel.join()).not.toContain(TOKEN);
    for (const label of ["a b", "-a", ".hidden", "x".repeat(65), "läbel"]) {
      expect(problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: label })[0]).toMatch(
        /^SEVDESK_API_TOKEN_KEYCHAIN must be a name of up to 64/,
      );
    }
    expect(localNameProblem("work.2026_a-b", "x")).toBeUndefined();
  });

  it("reports the keychain problem, a missing lookup, and a malformed stored token", () => {
    expect(
      problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "work" }, undefined, () => ({
        problem: 'No token is stored under keychain label "work".',
      })),
    ).toEqual(['No token is stored under keychain label "work".']);
    expect(problemsOf({ SEVDESK_API_TOKEN_KEYCHAIN: "work" })[0]).toMatch(
      /read only by the stdio server/,
    );
    const problems = problemsOf(
      { SEVDESK_API_TOKEN_KEYCHAIN: "work" },
      undefined,
      found(`${TOKEN} x`),
    );
    expect(problems).toEqual([
      'The token stored under keychain label "work" contains whitespace; paste only the token itself.',
    ]);
    expect(problems.join()).not.toContain(TOKEN);
  });

  it("still validates the other settings", () => {
    expect(
      problemsOf(
        { SEVDESK_API_TOKEN_KEYCHAIN: "work", SEVDESK_ALLOW: "bogus" },
        undefined,
        found(TOKEN),
      ),
    ).toEqual([expect.stringMatching(/SEVDESK_ALLOW: unknown tier/)]);
  });
});

describe("tiers", () => {
  it("always includes read and accepts a comma list", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "write, commit" });
    expect([...config.allowedTiers].sort()).toEqual(["commit", "read", "write"]);
  });

  it("expands all", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "all" });
    expect([...config.allowedTiers].sort()).toEqual(["commit", "external", "read", "write"]);
  });

  it("lets SEVDESK_READ_ONLY override every other tier", () => {
    const config = loadConfig({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_ALLOW: "all",
      SEVDESK_READ_ONLY: "1",
    });
    expect(config.readOnly).toBe(true);
    expect([...config.allowedTiers]).toEqual(["read"]);
  });

  it("rejects unknown tiers", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "read,admin" })[0]).toMatch(
      /unknown tier "admin"/,
    );
  });
});

describe("toolsets", () => {
  it("always keeps meta and accepts all/default keywords", () => {
    const only = loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_TOOLSETS: "invoices" });
    expect([...only.toolsets].sort()).toEqual(["invoices", "meta"]);

    const all = loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_TOOLSETS: "all" });
    expect(all.toolsets.size).toBe(TOOLSETS.length);

    const extended = loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_TOOLSETS: "default,advanced" });
    expect(extended.toolsets.has("advanced")).toBe(true);
    expect(extended.toolsets.has("contacts")).toBe(true);
  });

  it("rejects unknown toolsets", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_TOOLSETS: "payroll" })[0]).toMatch(
      /unknown toolset "payroll"/,
    );
  });
});

describe("confirmation", () => {
  it("opens approval pages unless SEVDESK_CONFIRM_OPEN turns it off", () => {
    const open = (value: string) =>
      loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM_OPEN: value }).confirmOpen;

    expect(open("0")).toBe(false);
    expect(open("false")).toBe(false);
    expect(open("1")).toBe(true);
    expect(open(" ")).toBe(true);
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM_OPEN: "sometimes" })[0]).toMatch(
      /SEVDESK_CONFIRM_OPEN: expected 1\/0 or true\/false/,
    );
  });

  it("refuses to turn confirmation off without the explicit acknowledgement", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM: "off" })[0]).toMatch(
      /SEVDESK_I_UNDERSTAND_NO_CONFIRM=1/,
    );
    const config = loadConfig({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_CONFIRM: "off",
      SEVDESK_I_UNDERSTAND_NO_CONFIRM: "true",
    });
    expect(config.confirm).toBe("off");
  });

  it("accepts browser mode and rejects unknown modes", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM: "Browser" }).confirm).toBe(
      "browser",
    );
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM: "maybe" })[0]).toMatch(
      /SEVDESK_CONFIRM: expected one of elicit, browser, off/,
    );
  });
});

describe("other settings", () => {
  it("requires https for the base URL and strips trailing slashes", () => {
    expect(
      problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_BASE_URL: "http://my.sevdesk.de" })[0],
    ).toMatch(/must use https/);
    expect(
      loadConfig({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_BASE_URL: "https://example.test/api/v1//" })
        .baseUrl,
    ).toBe("https://example.test/api/v1");
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_BASE_URL: "not a url" })[0]).toBe(
      "SEVDESK_BASE_URL is not a valid URL.",
    );
  });

  it("rejects base URLs whose query, fragment or credentials would corrupt requests", () => {
    const base = (url: string) => problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_BASE_URL: url });

    expect(base("https://my.sevdesk.de/api/v1?x=1")).toEqual([
      "SEVDESK_BASE_URL must not contain a query string (?…) or fragment (#…).",
    ]);
    expect(base("https://my.sevdesk.de/api/v1#top")).toHaveLength(1);
    const withCredentials = base("https://user:hunter2@my.sevdesk.de/api/v1");
    expect(withCredentials).toEqual(["SEVDESK_BASE_URL must not contain a username or password."]);
    expect(withCredentials.join("\n")).not.toContain("hunter2");
  });

  it("validates flags and numeric ranges", () => {
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_DRY_RUN: "perhaps" })[0]).toMatch(
      /SEVDESK_DRY_RUN: expected 1\/0/,
    );
    expect(problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_RATE_LIMIT: "0" })[0]).toMatch(
      /SEVDESK_RATE_LIMIT: expected a number between 0.1 and 50/,
    );
    const config = loadConfig({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_DRY_RUN: "yes",
      SEVDESK_RATE_LIMIT: "2.5",
      SEVDESK_TIMEOUT_MS: "10000",
      SEVDESK_STRUCTURED_OUTPUT: "on",
    });
    expect(config.dryRun).toBe(true);
    expect(config.requestsPerSecond).toBe(2.5);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.structuredOutput).toBe("on");
  });

  it("keeps the case of file directories and splits them like PATH", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const config = loadConfig({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_FILE_DIRS: `/Users/Me/Belege${sep} /tmp/Receipts `,
      SEVDESK_AUDIT_LOG: " /var/log/sevdesk.audit.jsonl ",
    });
    expect(config.fileDirs).toEqual(["/Users/Me/Belege", "/tmp/Receipts"]);
    expect(config.auditLogPath).toBe("/var/log/sevdesk.audit.jsonl");
  });

  it("refuses relative file directories, naming them", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    expect(
      problemsOf({ SEVDESK_FILE_DIRS: `/abs/Belege${sep}Belege${sep}./in` }).filter((problem) =>
        problem.startsWith("SEVDESK_FILE_DIRS"),
      ),
    ).toEqual([
      'SEVDESK_FILE_DIRS: every directory must be an absolute path (got "Belege", "./in").',
    ]);
  });

  it("collects every problem at once", () => {
    const problems = problemsOf({
      SEVDESK_ALLOW: "x",
      SEVDESK_TOOLSETS: "y",
      SEVDESK_CONFIRM: "z",
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});
