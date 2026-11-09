import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, type Env } from "../../../src/config.js";
import {
  httpDeployment,
  isLoopbackHost,
  loadHttpConfig,
  type LoadHttpConfigDeps,
  loopbackOrigin,
  parseDuration,
  prepareStateDir,
} from "../../../src/http/config.js";
import { generateSecret } from "../../../src/http/keys.js";
import { TEST_TOKEN } from "../../helpers/config.js";

const BEARER = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";
const BEARER_2 = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY-next";
const SECRET = generateSecret();

const BEARER_ENV: Env = {
  SEVDESK_HTTP_AUTH: "bearer",
  SEVDESK_API_TOKEN: TEST_TOKEN,
  SEVDESK_HTTP_BEARER_TOKEN: BEARER,
};

const OAUTH_ENV: Env = {
  SEVDESK_HTTP_AUTH: "oauth",
  SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
  SEVDESK_HTTP_SECRET: SECRET,
  SEVDESK_OAUTH_ACCOUNTS: "123456",
  SEVDESK_HTTP_STATE_DIR: "/data",
};

/** State directories are accepted without touching the disk unless a test says otherwise. */
const NO_DISK: LoadHttpConfigDeps = { prepareStateDir: () => undefined };

function load(env: Env, deps: LoadHttpConfigDeps = NO_DISK) {
  return loadHttpConfig(env, deps);
}

function problemsOf(env: Env, deps: LoadHttpConfigDeps = NO_DISK): readonly string[] {
  try {
    loadHttpConfig(env, deps);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadHttpConfig: bearer mode", () => {
  it("reads a minimal loopback setup with safe defaults", () => {
    const loaded = load(BEARER_ENV);
    expect(loaded.http).toEqual({
      auth: "bearer",
      host: "127.0.0.1",
      port: 8080,
      publicOrigin: undefined,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: ["http://localhost", "http://127.0.0.1", "http://[::1]"],
      trustProxy: 0,
      stateDir: undefined,
      bearerTokens: [BEARER],
      secret: undefined,
      previousSecret: undefined,
      oauth: undefined,
    });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.settings.confirmOpen).toBe(false);
    expect(loaded.fixed).toMatchObject({
      token: TEST_TOKEN,
      confirmOpen: false,
      deployment: {
        kind: "http",
        auth: "bearer",
        publicOrigin: "http://127.0.0.1:8080",
        approvalsUrl: undefined,
      },
    });
    expect(loaded.fixed?.account).toBeUndefined();
    expect(loaded.secrets).toEqual(expect.arrayContaining([TEST_TOKEN, BEARER]));
  });

  it("names the approval inbox when SEVDESK_CONFIRM=browser", () => {
    const loaded = load({
      ...BEARER_ENV,
      SEVDESK_CONFIRM: "browser",
      SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
    });
    expect(loaded.fixed?.deployment).toEqual({
      kind: "http",
      auth: "bearer",
      publicOrigin: "https://mcp.example.com",
      approvalsUrl: "https://mcp.example.com/approvals",
    });
  });

  it("accepts two bearer values for rotation, also from a file", () => {
    const loaded = load(
      {
        SEVDESK_HTTP_AUTH: "bearer",
        SEVDESK_API_TOKEN: TEST_TOKEN,
        SEVDESK_HTTP_BEARER_TOKEN_FILE: "/run/secrets/bearer",
      },
      { ...NO_DISK, readFile: () => `${BEARER}, ${BEARER_2}\n` },
    );
    expect(loaded.http.bearerTokens).toEqual([BEARER, BEARER_2]);
  });

  it("refuses a missing bearer token and a missing sevDesk token", () => {
    const problems = problemsOf({ SEVDESK_HTTP_AUTH: "bearer" });
    expect(problems).toEqual([
      expect.stringContaining("SEVDESK_API_TOKEN is not set"),
      expect.stringContaining("SEVDESK_HTTP_AUTH=bearer needs SEVDESK_HTTP_BEARER_TOKEN"),
    ]);
  });

  it.each([
    ["too short", "abcdefghijklmnopqrstuvwxyz0123", "too short"],
    ["not random", "abababababababababababababababababab", "not random enough"],
    ["with whitespace", "Zq3xR7pL0vN2mK8s T4wY6bH1cJ5dF9gA", "contains whitespace"],
  ])("refuses a bearer token that is %s, without echoing it", (_label, value, message) => {
    const problems = problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_BEARER_TOKEN: value });
    expect(problems).toEqual([expect.stringContaining(message)]);
    expect(problems.join("\n")).not.toContain(value);
  });

  it("refuses more than two bearer values", () => {
    const problems = problemsOf({
      ...BEARER_ENV,
      SEVDESK_HTTP_BEARER_TOKEN: `${BEARER},${BEARER_2},${BEARER}x`,
    });
    expect(problems).toEqual([expect.stringContaining("at most 2 comma-separated values")]);
  });

  it("refuses a bearer token equal to the sevDesk token", () => {
    const problems = problemsOf({ ...BEARER_ENV, SEVDESK_API_TOKEN: BEARER });
    expect(problems).toEqual([expect.stringContaining("must differ from SEVDESK_API_TOKEN")]);
    expect(problems.join("\n")).not.toContain(BEARER);
  });

  it("refuses an invalid sevDesk token", () => {
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_API_TOKEN: `Bearer ${TEST_TOKEN}` })).toEqual([
      expect.stringContaining("without a 'Bearer ' prefix"),
    ]);
  });

  it("keeps the optional server secret, so inbox sessions survive restarts", () => {
    const loaded = load({ ...BEARER_ENV, SEVDESK_HTTP_SECRET: SECRET });
    expect(loaded.http.secret?.length).toBe(32);
    expect(loaded.secrets).toContain(SECRET);
    expect(loaded.secrets).toContain(Buffer.from(loaded.http.secret ?? []).toString("hex"));
  });
});

describe("loadHttpConfig: oauth mode", () => {
  it("reads the OAuth settings with their defaults", () => {
    const loaded = load(OAUTH_ENV);
    expect(loaded.fixed).toBeUndefined();
    expect(loaded.http.auth).toBe("oauth");
    expect(loaded.http.publicOrigin).toBe("https://mcp.example.com");
    expect(loaded.http.allowedHosts).toEqual([
      "mcp.example.com",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
    expect(loaded.http.stateDir).toBe("/data");
    expect(loaded.http.oauth).toEqual({
      accounts: ["123456"],
      clients: ["claude.ai"],
      accessTtlSeconds: 3600,
      refreshIdleTtlSeconds: 14 * 86_400,
      grantTtlSeconds: 90 * 86_400,
    });
    expect(loaded.warnings).toEqual([]);
  });

  it("refuses OAuth without secret, public URL and accounts, all at once", () => {
    const problems = problemsOf({ SEVDESK_HTTP_AUTH: "oauth" });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("needs SEVDESK_HTTP_SECRET"),
        expect.stringContaining("needs SEVDESK_HTTP_PUBLIC_URL"),
        expect.stringContaining("needs SEVDESK_OAUTH_ACCOUNTS"),
      ]),
    );
    expect(problems).toHaveLength(3);
  });

  it("refuses a weak server secret without echoing it", () => {
    const weak = "short-secret";
    const problems = problemsOf({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET: weak });
    expect(problems).toEqual([expect.stringContaining("at least 32 random bytes")]);
    expect(problems.join("\n")).not.toContain(weak);
  });

  it("checks the previous secret of a rotation", () => {
    const previous = generateSecret();
    expect(
      load({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET_PREVIOUS: previous }).http.previousSecret,
    ).toEqual(new Uint8Array(Buffer.from(previous, "base64url")));
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET_PREVIOUS: SECRET })).toEqual([
      expect.stringContaining("must differ from SEVDESK_HTTP_SECRET"),
    ]);
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET_PREVIOUS: "weak" })).toEqual([
      expect.stringContaining("must be the former SEVDESK_HTTP_SECRET"),
    ]);
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_SECRET_PREVIOUS: previous })).toEqual([
      "SEVDESK_HTTP_SECRET_PREVIOUS is set without SEVDESK_HTTP_SECRET.",
    ]);
  });

  it.each(["SEVDESK_FILE_DIRS", "SEVDESK_OUTPUT_DIR"])(
    "refuses %s, which would share the server's disk between accounts",
    (name) => {
      expect(problemsOf({ ...OAUTH_ENV, [name]: "/srv/files" })).toEqual([
        expect.stringContaining(`${name} cannot be used with SEVDESK_HTTP_AUTH=oauth`),
      ]);
    },
  );

  it("keeps file directories in bearer mode", () => {
    expect(load({ ...BEARER_ENV, SEVDESK_FILE_DIRS: "/srv/files" }).fixed?.fileDirs).toEqual([
      "/srv/files",
    ]);
  });

  it("warns about SEVDESK_OAUTH_ACCOUNTS=any and SEVDESK_OAUTH_CLIENTS=any", () => {
    const loaded = load({
      ...OAUTH_ENV,
      SEVDESK_OAUTH_ACCOUNTS: "any",
      SEVDESK_OAUTH_CLIENTS: "ANY",
    });
    expect(loaded.http.oauth?.accounts).toBe("any");
    expect(loaded.http.oauth?.clients).toBe("any");
    expect(loaded.warnings).toEqual([
      expect.stringContaining("SEVDESK_OAUTH_ACCOUNTS=any"),
      expect.stringContaining("SEVDESK_OAUTH_CLIENTS=any"),
    ]);
  });

  it("refuses malformed account and client lists", () => {
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_OAUTH_ACCOUNTS: "any,123" })).toEqual([
      expect.stringContaining("either `any` or a list of account ids"),
    ]);
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_OAUTH_ACCOUNTS: "12 34" })).toEqual([
      expect.stringContaining("expected sevDesk account ids"),
    ]);
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_OAUTH_CLIENTS: "claude.ai,any" })).toEqual([
      expect.stringContaining("either `any` or a list of hostnames"),
    ]);
    expect(problemsOf({ ...OAUTH_ENV, SEVDESK_OAUTH_CLIENTS: "https://claude.ai" })).toEqual([
      expect.stringContaining("expected the hostnames"),
    ]);
  });

  it("reads client hosts and account ids, without duplicates", () => {
    const loaded = load({
      ...OAUTH_ENV,
      SEVDESK_OAUTH_ACCOUNTS: "1,2,1",
      SEVDESK_OAUTH_CLIENTS: "claude.ai, Example.org",
    });
    expect(loaded.http.oauth?.accounts).toEqual(["1", "2"]);
    expect(loaded.http.oauth?.clients).toEqual(["claude.ai", "example.org"]);
  });

  it("parses the token lifetimes and enforces their bounds", () => {
    const loaded = load({
      ...OAUTH_ENV,
      SEVDESK_OAUTH_ACCESS_TTL: "30m",
      SEVDESK_OAUTH_REFRESH_IDLE_TTL: "7d",
      SEVDESK_OAUTH_GRANT_TTL: "86400",
    });
    expect(loaded.http.oauth).toMatchObject({
      accessTtlSeconds: 1800,
      refreshIdleTtlSeconds: 7 * 86_400,
      grantTtlSeconds: 86_400,
    });
    expect(
      problemsOf({
        ...OAUTH_ENV,
        SEVDESK_OAUTH_ACCESS_TTL: "2m",
        SEVDESK_OAUTH_REFRESH_IDLE_TTL: "91d",
        SEVDESK_OAUTH_GRANT_TTL: "soon",
      }),
    ).toEqual([
      expect.stringContaining("SEVDESK_OAUTH_ACCESS_TTL: expected a duration between 5m and 24h"),
      expect.stringContaining(
        "SEVDESK_OAUTH_REFRESH_IDLE_TTL: expected a duration between 1d and 90d",
      ),
      expect.stringContaining("SEVDESK_OAUTH_GRANT_TTL: expected a duration between 1d and 365d"),
    ]);
  });

  it("warns when OAuth grants would live in memory only", () => {
    const { SEVDESK_HTTP_STATE_DIR: _dir, ...env } = OAUTH_ENV;
    expect(load(env).warnings).toEqual([
      expect.stringContaining("SEVDESK_HTTP_STATE_DIR is not set"),
    ]);
  });

  it("warns about a sevDesk or bearer token that OAuth mode does not use", () => {
    const loaded = load({
      ...OAUTH_ENV,
      SEVDESK_API_TOKEN_FILE: "/run/secrets/token",
      SEVDESK_HTTP_BEARER_TOKEN: BEARER,
    });
    expect(loaded.warnings).toEqual([
      expect.stringContaining("SEVDESK_API_TOKEN is not used"),
      expect.stringContaining("SEVDESK_HTTP_BEARER_TOKEN is not used"),
    ]);
    expect(loaded.secrets).not.toContain(BEARER);
  });
});

describe("loadHttpConfig: binding and public URL", () => {
  it("refuses a missing or unknown auth mode", () => {
    expect(problemsOf({})).toEqual([expect.stringContaining("SEVDESK_HTTP_AUTH is not set")]);
    expect(problemsOf({ SEVDESK_HTTP_AUTH: "none" })).toEqual([
      'SEVDESK_HTTP_AUTH: expected one of bearer, oauth, got "none".',
    ]);
  });

  it("refuses a non-loopback bind without a public URL", () => {
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_HOST: "0.0.0.0" })).toEqual([
      expect.stringContaining("SEVDESK_HTTP_HOST=0.0.0.0 is not a loopback address"),
    ]);
  });

  it("derives Host and Origin allowlists from the public URL on a public bind", () => {
    const loaded = load({
      ...BEARER_ENV,
      SEVDESK_HTTP_HOST: "0.0.0.0",
      SEVDESK_HTTP_PUBLIC_URL: "https://MCP.Example.com/",
      SEVDESK_HTTP_ALLOWED_HOSTS: "internal.example.net, [::1], 10.0.0.5",
      SEVDESK_HTTP_ALLOWED_ORIGINS: "https://app.example.com/, http://localhost:6274",
    });
    expect(loaded.http.publicOrigin).toBe("https://mcp.example.com");
    expect(loaded.http.allowedHosts).toEqual([
      "mcp.example.com",
      "internal.example.net",
      "[::1]",
      "10.0.0.5",
    ]);
    expect(loaded.http.allowedOrigins).toEqual([
      "https://mcp.example.com",
      "https://app.example.com",
      "http://localhost:6274",
    ]);
    expect(loaded.fixed?.deployment).toMatchObject({ publicOrigin: "https://mcp.example.com" });
  });

  it("refuses malformed allowlist entries", () => {
    expect(
      problemsOf({
        ...BEARER_ENV,
        SEVDESK_HTTP_ALLOWED_HOSTS: "host:8080,*,::1",
        SEVDESK_HTTP_ALLOWED_ORIGINS: "claude.ai,https://a.example/path,ftp://x.example",
      }),
    ).toEqual([
      'SEVDESK_HTTP_ALLOWED_HOSTS: expected hostnames without scheme or port (IPv6 in brackets), got "host:8080", "*", "::1".',
      expect.stringContaining('got "claude.ai", "https://a.example/path", "ftp://x.example".'),
    ]);
  });

  it("refuses an http public URL on a non-loopback host, and accepts it on loopback", () => {
    expect(
      problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_PUBLIC_URL: "http://mcp.example.com" }),
    ).toEqual([expect.stringContaining("must use https unless its host is localhost")]);
    expect(
      load({ ...BEARER_ENV, SEVDESK_HTTP_PUBLIC_URL: "http://localhost:8080" }).http.publicOrigin,
    ).toBe("http://localhost:8080");
  });

  it.each([
    ["a path", "https://mcp.example.com/mcp", "origin only"],
    ["a query", "https://mcp.example.com/?x=1", "origin only"],
    ["an empty query", "https://mcp.example.com?", "origin only"],
    ["a fragment", "https://mcp.example.com#top", "origin only"],
    ["credentials", "https://user:pw@mcp.example.com", "username or password"],
    ["another scheme", "ftp://mcp.example.com", "must be an https URL"],
  ])("refuses a public URL with %s", (_label, url, message) => {
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_PUBLIC_URL: url })).toEqual([
      expect.stringContaining(message),
    ]);
  });

  it("does not echo an unparsable public URL", () => {
    const problems = problemsOf({
      ...BEARER_ENV,
      SEVDESK_HTTP_PUBLIC_URL: "https://user:hunter2@",
    });
    expect(problems).toEqual([
      "SEVDESK_HTTP_PUBLIC_URL is not a valid URL (expected e.g. https://mcp.example.com).",
    ]);
  });

  it("reads host and port, with PORT as fallback", () => {
    expect(load({ ...BEARER_ENV, PORT: "3000" }).http.port).toBe(3000);
    expect(load({ ...BEARER_ENV, PORT: "3000", SEVDESK_HTTP_PORT: "0" }).http.port).toBe(0);
    expect(problemsOf({ ...BEARER_ENV, PORT: "70000" })).toEqual([
      'PORT: expected a port number between 0 and 65535, got "70000".',
    ]);
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_PORT: "http" })).toEqual([
      'SEVDESK_HTTP_PORT: expected a port number between 0 and 65535, got "http".',
    ]);
    const v6 = load({ ...BEARER_ENV, SEVDESK_HTTP_HOST: "[::1]", SEVDESK_HTTP_PORT: "9000" });
    expect(v6.http.host).toBe("::1");
    expect(v6.fixed?.deployment).toMatchObject({ publicOrigin: "http://[::1]:9000" });
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_HOST: "not a host" })).toEqual([
      expect.stringContaining("SEVDESK_HTTP_HOST: expected an IP address or hostname"),
    ]);
  });

  it("reads the trusted proxy hops (0 to 5)", () => {
    expect(load({ ...BEARER_ENV, SEVDESK_HTTP_TRUST_PROXY: "2" }).http.trustProxy).toBe(2);
    for (const value of ["6", "-1", "one", "1.5"]) {
      expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_TRUST_PROXY: value })).toEqual([
        expect.stringContaining("SEVDESK_HTTP_TRUST_PROXY: expected the number of reverse proxies"),
      ]);
    }
  });
});

describe("loadHttpConfig: confirmation", () => {
  it("defaults SEVDESK_CONFIRM_OPEN to off and keeps an explicit value on loopback", () => {
    expect(load(BEARER_ENV).settings.confirmOpen).toBe(false);
    expect(load({ ...BEARER_ENV, SEVDESK_CONFIRM_OPEN: "1" }).settings.confirmOpen).toBe(true);
  });

  it("refuses SEVDESK_CONFIRM_OPEN=1 on a non-loopback bind", () => {
    const env = {
      ...BEARER_ENV,
      SEVDESK_HTTP_HOST: "0.0.0.0",
      SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
    };
    expect(problemsOf({ ...env, SEVDESK_CONFIRM_OPEN: "1" })).toEqual([
      expect.stringContaining("SEVDESK_CONFIRM_OPEN=1 opens approval pages"),
    ]);
    expect(load({ ...env, SEVDESK_CONFIRM_OPEN: "0" }).settings.confirmOpen).toBe(false);
  });

  it("warns when elicitation is the only confirmation for commit tools", () => {
    expect(load({ ...BEARER_ENV, SEVDESK_ALLOW: "write,commit" }).warnings).toEqual([
      expect.stringContaining("Set SEVDESK_CONFIRM=browser"),
    ]);
    expect(
      load({ ...BEARER_ENV, SEVDESK_ALLOW: "all", SEVDESK_CONFIRM: "browser" }).warnings,
    ).toEqual([]);
    expect(load({ ...BEARER_ENV, SEVDESK_ALLOW: "write" }).warnings).toEqual([]);
  });

  it("reports shared-setting problems together with its own", () => {
    expect(problemsOf({ SEVDESK_ALLOW: "everything" })).toEqual([
      expect.stringContaining("SEVDESK_HTTP_AUTH is not set"),
      expect.stringContaining('SEVDESK_ALLOW: unknown tier "everything"'),
    ]);
  });
});

describe("state directory", () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "sevdesk-state-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing directory with mode 0700", () => {
    const path = join(tempDir(), "nested", "state");
    expect(loadHttpConfig({ ...BEARER_ENV, SEVDESK_HTTP_STATE_DIR: path }).http.stateDir).toBe(
      path,
    );
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("refuses an unwritable directory", () => {
    const path = tempDir();
    chmodSync(path, 0o500);
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_STATE_DIR: path }, {})).toEqual([
      expect.stringContaining(`${path} is not writable by this process`),
    ]);
  });

  it("refuses a file, an uncreatable path and a relative path", () => {
    const dir = tempDir();
    const file = join(dir, "file");
    writeFileSync(file, "x");
    expect(prepareStateDir(file)).toContain("exists but is not a directory");
    expect(prepareStateDir(join(file, "below"))).toContain("cannot create");
    expect(problemsOf({ ...BEARER_ENV, SEVDESK_HTTP_STATE_DIR: "data" })).toEqual([
      'SEVDESK_HTTP_STATE_DIR must be an absolute path, got "data".',
    ]);
  });

  it("reports what an injected check finds", () => {
    expect(
      problemsOf(
        { ...BEARER_ENV, SEVDESK_HTTP_STATE_DIR: "/data" },
        { prepareStateDir: () => "SEVDESK_HTTP_STATE_DIR: /data is read-only." },
      ),
    ).toEqual(["SEVDESK_HTTP_STATE_DIR: /data is read-only."]);
  });
});

describe("helpers", () => {
  it("parses durations", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("1H")).toBe(3600);
    expect(parseDuration("14d")).toBe(14 * 86_400);
    expect(parseDuration("1.5h")).toBeUndefined();
    expect(parseDuration("1w")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });

  it("recognizes loopback hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "10.0.0.1", "example.com", "128.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("builds loopback origins and deployments", () => {
    expect(loopbackOrigin("127.0.0.1", 8080)).toBe("http://127.0.0.1:8080");
    expect(loopbackOrigin("::1", 8080)).toBe("http://[::1]:8080");
    expect(loopbackOrigin("localhost", 80)).toBe("http://localhost");
    expect(httpDeployment("oauth", "https://a.example", "elicit")).toEqual({
      kind: "http",
      auth: "oauth",
      publicOrigin: "https://a.example",
      approvalsUrl: undefined,
    });
  });
});
