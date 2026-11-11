import { describe, expect, it } from "vitest";

import { ConfigError } from "../../../src/config.js";
import { loadHttpConfig } from "../../../src/http/config.js";
import { generateSecret } from "../../../src/http/keys.js";
import {
  configuredSecrets,
  REDACTED,
  redactHeaders,
  redactSecrets,
  SECRET_SETTINGS,
} from "../../../src/safety/redact.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("redactSecrets", () => {
  it("replaces every occurrence", () => {
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("matches case-insensitively", () => {
    expect(redactSecrets(`token=${TOKEN.toUpperCase()}`, [TOKEN])).toBe(`token=${REDACTED}`);
  });

  it("catches URL-encoded forms", () => {
    const secret = "s3cr/t+key word&x";
    const encoded = encodeURIComponent(secret);
    const lowerHex = encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
    const form = encoded.replace(/%20/g, "+");

    for (const variant of [secret, encoded, lowerHex, form, encodeURI(secret)]) {
      expect(redactSecrets(`url?q=${variant}&z=1`, [secret])).toBe(`url?q=${REDACTED}&z=1`);
    }
  });

  it("treats regex characters in secrets literally", () => {
    expect(redactSecrets("a.b a*b", ["a.b"])).toBe(`${REDACTED} a*b`);
  });

  it("replaces the longest secret first", () => {
    expect(redactSecrets("abcdef", ["abc", "abcdef"])).toBe(REDACTED);
  });

  it("ignores empty and missing secrets", () => {
    expect(redactSecrets("text", ["", undefined])).toBe("text");
    expect(redactSecrets("text", [])).toBe("text");
  });
});

describe("redactHeaders", () => {
  it("redacts credentials in a Headers object", () => {
    const headers = new Headers({
      Authorization: TOKEN,
      Cookie: "session=1",
      Accept: "application/json",
    });
    expect(redactHeaders(headers)).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      accept: "application/json",
    });
  });

  it("redacts credentials in a plain record, case-insensitively", () => {
    expect(
      redactHeaders({
        "X-Api-Key": "k",
        "Proxy-Authorization": "p",
        "Set-Cookie": "c",
        "X-Auth-Token": "t",
        "User-Agent": "ua",
      }),
    ).toEqual({
      "x-api-key": REDACTED,
      "proxy-authorization": REDACTED,
      "set-cookie": REDACTED,
      "x-auth-token": REDACTED,
      "user-agent": "ua",
    });
  });
});

describe("configuredSecrets (security review 2026-11, wave 2)", () => {
  const files: Record<string, string> = {
    "/run/secrets/bearer": "bearer-from-file-0123456789\n",
    "/run/secrets/api": `${TOKEN}\n`,
  };
  const readFile = (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  };

  it("collects values, rotation members, the previous secret and file contents", () => {
    const secrets = configuredSecrets(
      {
        SEVDESK_HTTP_BEARER_TOKEN: "current-bearer-1234567,previous-bearer-7654321",
        SEVDESK_HTTP_SECRET: "server-secret-abcdefghijkl",
        SEVDESK_HTTP_SECRET_PREVIOUS: "old-secret-abcdefghijklmn",
        SEVDESK_HTTP_BEARER_TOKEN_FILE: "/run/secrets/bearer",
        SEVDESK_API_TOKEN_FILE: "/run/secrets/api",
        SEVDESK_HTTP_SECRET_FILE: "/missing",
        SEVDESK_ALLOW: "read",
      },
      readFile,
    );

    for (const secret of [
      "current-bearer-1234567",
      "previous-bearer-7654321",
      "server-secret-abcdefghijkl",
      "old-secret-abcdefghijklmn",
      "bearer-from-file-0123456789",
      TOKEN,
    ]) {
      expect(secrets).toContain(secret);
    }
    expect(secrets).not.toContain("read");
    const problem = 'SEVDESK_HTTP_PORT: expected a port, got "previous-bearer-7654321".';
    expect(redactSecrets(problem, secrets)).not.toContain("previous-bearer-7654321");
  });

  it("skips short pieces that would blank out ordinary words", () => {
    expect(configuredSecrets({ SEVDESK_HTTP_BEARER_TOKEN: "a,bc,longenough-1" }, readFile)).toEqual(
      ["a,bc,longenough-1", "longenough-1"],
    );
  });
});

/**
 * Secrets here are random base64url values (the form `generate-secret` prints): the
 * token-shape rule of `ConfigError` only catches 32 hex characters. Assertions use `includes`, so
 * a failure never prints the text it searched.
 */
describe("configuredSecrets: file settings (review 2026-11, round 3)", () => {
  const unreadable = (): string => {
    throw new Error("ENOENT");
  };

  it.each(SECRET_SETTINGS)("collects the contents of the file %s_FILE names", (name) => {
    const secret = generateSecret();
    const secrets = configuredSecrets({ [`${name}_FILE`]: " /run/secrets/value " }, (path) => {
      if (path !== "/run/secrets/value") throw new Error("ENOENT");
      return `${secret}\n`;
    });

    expect(secrets.includes(secret)).toBe(true);
  });

  it("redacts a previous server secret that only a file holds from a failed startup", () => {
    const previous = generateSecret();
    const env = {
      SEVDESK_HTTP_AUTH: "oauth",
      SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
      SEVDESK_HTTP_SECRET: generateSecret(),
      SEVDESK_HTTP_SECRET_PREVIOUS_FILE: "/run/secrets/previous",
      SEVDESK_OAUTH_ACCOUNTS: "123456",
      // The mistake: the rotation key pasted into a setting whose problem quotes its value.
      SEVDESK_HTTP_PORT: previous,
    };
    const readFile = (path: string): string => {
      if (path !== "/run/secrets/previous") throw new Error("ENOENT");
      return `${previous}\n`;
    };

    let thrown: unknown;
    try {
      loadHttpConfig(env, { readFile });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    // The problem does quote the value, so the redaction below is what keeps it off stderr.
    expect(message.includes(previous)).toBe(true);
    const shown = redactSecrets(message, configuredSecrets(env, readFile));
    expect(shown.includes(previous)).toBe(false);
    expect(shown).toContain("SEVDESK_HTTP_PORT: expected a port number");
  });

  it("treats an unreadable value that is no absolute path as the secret it probably is", () => {
    const pasted = generateSecret();
    const secrets = configuredSecrets(
      { SEVDESK_HTTP_SECRET_FILE: pasted, SEVDESK_API_TOKEN_FILE: "/run/secrets/missing" },
      unreadable,
    );

    expect(secrets.includes(pasted)).toBe(true);
    // A real path that cannot be read stays readable in the problem that names it.
    expect(secrets).not.toContain("/run/secrets/missing");
  });

  it.each(SECRET_SETTINGS)("never quotes a secret pasted into %s_FILE", (name) => {
    const pasted = generateSecret();
    const env = {
      // Each mode reads its own secrets: the sevDesk and bearer tokens only in bearer mode.
      SEVDESK_HTTP_AUTH: name.startsWith("SEVDESK_HTTP_SECRET") ? "oauth" : "bearer",
      SEVDESK_HTTP_PUBLIC_URL: "https://mcp.example.com",
      SEVDESK_OAUTH_ACCOUNTS: "123456",
      [`${name}_FILE`]: pasted,
    };

    let thrown: unknown;
    try {
      loadHttpConfig(env, { readFile: unreadable });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.message.includes(pasted)).toBe(false);
    expect(error.problems.some((problem) => problem.startsWith(`${name}_FILE: cannot read`))).toBe(
      true,
    );
  });
});
