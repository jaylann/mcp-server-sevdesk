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
  looksHumanChosen,
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

/** For tests about other settings: remote file transfer adds warnings on loopback http. */
const FILES_OFF: Env = { SEVDESK_HTTP_FILES: "off" };
const MIB = 1024 * 1024;
const PLAIN_HTTP_WARNING = "SEVDESK_HTTP_FILES=on over plain http";
const IN_MEMORY_WARNING = "SEVDESK_HTTP_FILES keeps uploaded files and download links in memory";

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
      files: { maxBytes: 64 * MIB, ttlSeconds: 1800 },
    });
    expect(loaded.warnings).toEqual([
      expect.stringContaining(PLAIN_HTTP_WARNING),
      expect.stringContaining(IN_MEMORY_WARNING),
    ]);
    expect(loaded.settings.confirmOpen).toBe(false);
    expect(loaded.fixed).toMatchObject({
      token: TEST_TOKEN,
      confirmOpen: false,
      deployment: {
        kind: "http",
        auth: "bearer",
        publicOrigin: "http://127.0.0.1:8080",
        approvalsUrl: undefined,
        files: { ttlSeconds: 1800 },
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
      files: { ttlSeconds: 1800 },
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
      expect.stringContaining("SEVDESK_OAUTH_ACCOUNTS=any: every sevDesk account"),
      expect.stringContaining("SEVDESK_OAUTH_CLIENTS=any"),
      expect.stringContaining("SEVDESK_OAUTH_ACCOUNTS=any with SEVDESK_HTTP_FILES=on"),
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

  it("warns about access tokens shorter than the clients' early-refresh window", () => {
    const short = load({ ...OAUTH_ENV, SEVDESK_OAUTH_ACCESS_TTL: "5m" });
    expect(short.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SEVDESK_OAUTH_ACCESS_TTL is under 10 minutes"),
      ]),
    );
    const normal = load({ ...OAUTH_ENV, SEVDESK_OAUTH_ACCESS_TTL: "10m" });
    expect(normal.warnings.join("\n")).not.toContain("SEVDESK_OAUTH_ACCESS_TTL");
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
      expect.stringContaining(IN_MEMORY_WARNING),
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
    expect(load({ ...BEARER_ENV, ...FILES_OFF, SEVDESK_ALLOW: "write,commit" }).warnings).toEqual([
      expect.stringContaining("Set SEVDESK_CONFIRM=browser"),
    ]);
    expect(
      load({ ...BEARER_ENV, ...FILES_OFF, SEVDESK_ALLOW: "all", SEVDESK_CONFIRM: "browser" })
        .warnings,
    ).toEqual([]);
    expect(load({ ...BEARER_ENV, ...FILES_OFF, SEVDESK_ALLOW: "write" }).warnings).toEqual([]);
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
    expect(
      Object.keys(httpDeployment("oauth", "https://a.example", "elicit")).includes("files"),
    ).toBe(false);
    expect(
      httpDeployment("bearer", "https://a.example", "browser", { maxBytes: 1, ttlSeconds: 600 }),
    ).toEqual({
      kind: "http",
      auth: "bearer",
      publicOrigin: "https://a.example",
      approvalsUrl: "https://a.example/approvals",
      files: { ttlSeconds: 600 },
    });
  });
});

describe("loadHttpConfig: review fixes", () => {
  it("warns about a loopback public URL on a public bind, but still starts (#8)", () => {
    // The image smoke: HOST 0.0.0.0 inside the container, the port published on 127.0.0.1.
    const loaded = load({
      ...BEARER_ENV,
      ...FILES_OFF,
      SEVDESK_HTTP_HOST: "0.0.0.0",
      SEVDESK_HTTP_PUBLIC_URL: "http://127.0.0.1:8080",
    });
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:8080");
    expect(loaded.warnings).toEqual([
      expect.stringContaining("anyone who can reach the port can use the server"),
    ]);
    expect(loaded.warnings[0]).toContain("travel in clear text");
    expect(loaded.warnings[0]).toContain("-p 127.0.0.1:8080:8080");

    const oauth = load({
      ...OAUTH_ENV,
      SEVDESK_HTTP_HOST: "::",
      SEVDESK_HTTP_PUBLIC_URL: "https://localhost:8443",
    });
    expect(oauth.warnings).toEqual([expect.stringContaining("is a loopback URL")]);
    expect(oauth.warnings[0]).not.toContain("clear text");
  });

  it("does not warn for a loopback bind or a real public URL", () => {
    expect(
      load({ ...BEARER_ENV, ...FILES_OFF, SEVDESK_HTTP_PUBLIC_URL: "http://localhost:8080" })
        .warnings,
    ).toEqual([]);
    expect(
      load({
        ...BEARER_ENV,
        SEVDESK_HTTP_HOST: "0.0.0.0",
        SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
        SEVDESK_HTTP_STATE_DIR: "/data",
      }).warnings,
    ).toEqual([]);
  });

  it("warns about passphrase-like secrets without printing them (#9)", () => {
    const passphrase = "ThisIsMyServerSecretForTheSevdeskMcpServer2026";
    const secret = load({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET: passphrase });
    expect(secret.warnings).toEqual([
      expect.stringContaining("SEVDESK_HTTP_SECRET looks like a passphrase"),
    ]);
    expect(secret.warnings[0]).toContain("mcp-server-sevdesk generate-secret");
    expect(secret.warnings.join("\n")).not.toContain(passphrase);

    const previous = load({
      ...OAUTH_ENV,
      SEVDESK_HTTP_SECRET_PREVIOUS: "CorrectHorseBatteryStapleSevdeskSecretNovember",
    });
    expect(previous.warnings).toEqual([
      expect.stringContaining("SEVDESK_HTTP_SECRET_PREVIOUS looks like a passphrase"),
    ]);

    const bearerPhrase = "correct-horse-battery-staple-sevdesk-mcp";
    const bearer = load({
      ...BEARER_ENV,
      ...FILES_OFF,
      SEVDESK_HTTP_BEARER_TOKEN: `${BEARER},${bearerPhrase}`,
    });
    expect(bearer.http.bearerTokens).toEqual([BEARER, bearerPhrase]);
    expect(bearer.warnings).toEqual([
      expect.stringContaining("value 2 of SEVDESK_HTTP_BEARER_TOKEN looks like a passphrase"),
    ]);
    expect(bearer.warnings.join("\n")).not.toContain(bearerPhrase);
  });

  it("never warns about generated secrets", () => {
    for (let index = 0; index < 200; index += 1) {
      const value = generateSecret();
      const loaded = load({ ...OAUTH_ENV, SEVDESK_HTTP_SECRET: value });
      expect(loaded.warnings).toEqual([]);
      const hex = Buffer.from(value, "base64url").toString("hex");
      expect(looksHumanChosen(hex)).toBe(false);
    }
  });
});

describe("looksHumanChosen", () => {
  it("flags passphrases, repetitions and ascending runs, not random strings", () => {
    for (const value of [
      "ThisIsMyServerSecretForTheSevdeskMcpServer2026",
      "MySuperSecretBearerTokenForSevdesk2026!!",
      "sevdesk-mcp-server-bearer-token-for-claude-code",
      "deadbeef".repeat(8),
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
      "Xk9#qL2v12345678mP0z!Rt7wQ4nB8sJ",
    ]) {
      expect(looksHumanChosen(value), value).toBe(true);
    }
    for (const value of [BEARER, BEARER_2, "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", SECRET]) {
      expect(looksHumanChosen(value), value).toBe(false);
    }
  });
});

describe("loadHttpConfig: remote file transfer", () => {
  it("is on by default: 256 MB with a state directory, 30 minutes", () => {
    const loaded = load(OAUTH_ENV);
    expect(loaded.http.files).toEqual({ maxBytes: 256 * MIB, ttlSeconds: 1800 });
    expect(loaded.warnings).toEqual([]);
  });

  it("reads the limit and the lifetime within their bounds", () => {
    const loaded = load({
      ...OAUTH_ENV,
      SEVDESK_HTTP_FILES: "ON",
      SEVDESK_HTTP_FILES_MAX_MB: "4096",
      SEVDESK_HTTP_FILES_TTL: "24h",
    });
    expect(loaded.http.files).toEqual({ maxBytes: 4096 * MIB, ttlSeconds: 86_400 });
    expect(load({ ...OAUTH_ENV, SEVDESK_HTTP_FILES_MAX_MB: "32" }).http.files?.maxBytes).toBe(
      32 * MIB,
    );
    expect(load({ ...OAUTH_ENV, SEVDESK_HTTP_FILES_TTL: "300" }).http.files?.ttlSeconds).toBe(300);
  });

  it.each([
    ["SEVDESK_HTTP_FILES", "yes", 'SEVDESK_HTTP_FILES: expected one of on, off, got "yes".'],
    ["SEVDESK_HTTP_FILES", "1", 'SEVDESK_HTTP_FILES: expected one of on, off, got "1".'],
    ["SEVDESK_HTTP_FILES_MAX_MB", "31", "between 32 and 4096"],
    ["SEVDESK_HTTP_FILES_MAX_MB", "4097", "between 32 and 4096"],
    ["SEVDESK_HTTP_FILES_MAX_MB", "64.5", "between 32 and 4096"],
    ["SEVDESK_HTTP_FILES_MAX_MB", "1G", "between 32 and 4096"],
    [
      "SEVDESK_HTTP_FILES_TTL",
      "4m",
      "SEVDESK_HTTP_FILES_TTL: expected a duration between 5m and 24h",
    ],
    ["SEVDESK_HTTP_FILES_TTL", "25h", "between 5m and 24h"],
    ["SEVDESK_HTTP_FILES_TTL", "soon", "between 5m and 24h"],
  ])("refuses %s=%s", (name, value, message) => {
    expect(problemsOf({ ...OAUTH_ENV, [name]: value })).toEqual([expect.stringContaining(message)]);
  });

  it("can be switched off; its settings then have no effect", () => {
    const off = load({ ...BEARER_ENV, ...FILES_OFF });
    expect(off.http.files).toBeUndefined();
    expect(off.warnings).toEqual([]);
    expect(off.fixed?.deployment).not.toHaveProperty("files");
    const tuned = load({
      ...BEARER_ENV,
      SEVDESK_HTTP_FILES: "off",
      SEVDESK_HTTP_FILES_MAX_MB: "abc",
      SEVDESK_HTTP_FILES_TTL: "1h",
    });
    expect(tuned.warnings).toEqual([
      "SEVDESK_HTTP_FILES_MAX_MB and SEVDESK_HTTP_FILES_TTL have no effect with SEVDESK_HTTP_FILES=off.",
    ]);
  });

  it("warns about plain http, files in memory and a server open to any account", () => {
    const local = load(BEARER_ENV);
    expect(local.warnings).toEqual([
      expect.stringContaining(PLAIN_HTTP_WARNING),
      expect.stringContaining("(up to 64 MB, SEVDESK_HTTP_FILES_MAX_MB)"),
    ]);
    expect(local.warnings[0]).toContain("another local server could use them as you");
    const loopbackUrl = load({
      ...BEARER_ENV,
      SEVDESK_HTTP_PUBLIC_URL: "http://localhost:8080",
      SEVDESK_HTTP_STATE_DIR: "/data",
    });
    expect(loopbackUrl.warnings).toEqual([expect.stringContaining(PLAIN_HTTP_WARNING)]);
    const any = load({ ...OAUTH_ENV, SEVDESK_OAUTH_ACCOUNTS: "any" });
    expect(any.warnings).toEqual([
      expect.stringContaining("SEVDESK_OAUTH_ACCOUNTS=any: every sevDesk account"),
      expect.stringContaining("holds the receipts and exports of every account"),
    ]);
    expect(load({ ...OAUTH_ENV, ...FILES_OFF, SEVDESK_OAUTH_ACCOUNTS: "any" }).warnings).toEqual([
      expect.stringContaining("SEVDESK_OAUTH_ACCOUNTS=any: every sevDesk account"),
    ]);
  });

  it("points OAuth deployments that set local folders to uploads and download links", () => {
    const [problem] = problemsOf({ ...OAUTH_ENV, SEVDESK_OUTPUT_DIR: "/srv/out" });
    expect(problem).toContain("upload pages and download exports through links");
  });

  it("names the files lifetime in the bearer deployment", () => {
    const loaded = load({ ...BEARER_ENV, SEVDESK_HTTP_FILES_TTL: "1h" });
    expect(loaded.fixed?.deployment).toMatchObject({ files: { ttlSeconds: 3600 } });
  });
});

describe("loadHttpConfig: local-only settings", () => {
  it.each(["SEVDESK_PROFILE", "SEVDESK_PROFILES_PATH", "SEVDESK_API_TOKEN_KEYCHAIN"])(
    "refuses %s in both auth modes, without echoing its value",
    (name) => {
      const value = "private-value-7f3a";
      for (const env of [BEARER_ENV, OAUTH_ENV]) {
        const problems = problemsOf({ ...env, [name]: value });
        expect(problems).toEqual([
          `${name} works only over stdio, not with --http. Configure the HTTP server through its ` +
            "environment (SEVDESK_API_TOKEN or SEVDESK_API_TOKEN_FILE in bearer mode).",
        ]);
        expect(problems.join("\n")).not.toContain(value);
      }
    },
  );

  it("reports all three together and ignores them when empty", () => {
    expect(
      problemsOf({
        ...BEARER_ENV,
        SEVDESK_PROFILE: "work",
        SEVDESK_PROFILES_PATH: "/home/me/profiles.json",
        SEVDESK_API_TOKEN_KEYCHAIN: "work",
      }),
    ).toHaveLength(3);
    expect(
      load({ ...BEARER_ENV, ...FILES_OFF, SEVDESK_PROFILE: " ", SEVDESK_API_TOKEN_KEYCHAIN: "" })
        .warnings,
    ).toEqual([]);
  });
});
