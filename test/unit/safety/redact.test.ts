import { describe, expect, it } from "vitest";

import {
  configuredSecrets,
  REDACTED,
  redactHeaders,
  redactSecrets,
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
