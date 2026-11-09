import { describe, expect, it } from "vitest";

import { GRANT_EXTRA_KEY, VerifiedGrant } from "../../../src/accounts/types.js";
import { createServerKeys, generateSecret } from "../../../src/http/keys.js";
import {
  createHttpLog,
  MAX_LOG_FIELD_LENGTH,
  principalLogFields,
  redactLogText,
} from "../../../src/http/log.js";
import { seal } from "../../../src/http/seal.js";
import { TEST_TOKEN } from "../../helpers/config.js";

const BEARER = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";

function capture(secrets: readonly string[] = []) {
  const lines: string[] = [];
  const log = createHttpLog({ write: (line) => lines.push(line), secrets, now: () => 0 });
  return {
    log,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createHttpLog", () => {
  it("writes one JSON object per event with time, level and fields", () => {
    const { log, records } = capture();
    log.info("request", { route: "/mcp", status: 200, ms: 12, ok: true, skipped: undefined });
    log.warn("refresh_replay", { grant: "abcd1234" });
    expect(records()).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "info",
        event: "request",
        route: "/mcp",
        status: 200,
        ms: 12,
        ok: true,
      },
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "warn",
        event: "refresh_replay",
        grant: "abcd1234",
      },
    ]);
  });

  it("never lets a field overwrite time, level or event", () => {
    const { log, records } = capture();
    log.info("request", { level: "debug", event: "other", time: "never" });
    expect(records()[0]).toMatchObject({ level: "info", event: "request" });
    expect(records()[0]?.["time"]).toBe("1970-01-01T00:00:00.000Z");
  });

  it("redacts configured secrets, sealed tokens and token-shaped hex in every field", () => {
    const keys = createServerKeys(new Uint8Array(Buffer.from(generateSecret(), "base64url")));
    const sealed = seal(keys, "at", "https://mcp.example.com", { gid: "g" });
    const { log, lines } = capture([BEARER]);
    log.warn(`event ${BEARER}`, {
      message: `Bearer ${BEARER} failed; token ${TEST_TOKEN.toUpperCase()}; sealed ${sealed}`,
      encoded: encodeURIComponent(`${BEARER} `),
      hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const text = lines.join("\n");
    expect(text).not.toContain(BEARER);
    expect(text.toLowerCase()).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(sealed);
    expect(text).not.toContain("sdmcp_at_");
    expect(text).not.toContain("0123456789abcdef0123456789abcdef");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("[redacted token]");
  });

  it("cuts long values", () => {
    const { log, records } = capture();
    log.info("request", { message: "x".repeat(MAX_LOG_FIELD_LENGTH + 100) });
    const message = records()[0]?.["message"] as string;
    expect(message.startsWith("x".repeat(MAX_LOG_FIELD_LENGTH))).toBe(true);
    expect(message.endsWith("…[cut]")).toBe(true);
  });

  it("survives a failing writer", () => {
    const log = createHttpLog({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => {
      log.info("request");
    }).not.toThrow();
  });

  it("writes to stderr by default", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      createHttpLog().info("listening", { url: "http://127.0.0.1:1/mcp" });
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({ event: "listening" });
  });
});

describe("redactLogText", () => {
  it("ignores empty secrets and keeps short hex", () => {
    expect(redactLogText("id deadbeef", ["", undefined])).toBe("id deadbeef");
  });
});

describe("principalLogFields", () => {
  it("logs an 8-character grant prefix, bearer, or nothing", () => {
    const grant = new VerifiedGrant(
      {
        grantId: "AbCdEfGh123456789",
        accountId: "1",
        clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        tiers: new Set(["read"]),
      },
      TEST_TOKEN,
    );
    expect(
      principalLogFields({
        token: "sdmcp_at_x",
        clientId: "c",
        scopes: [],
        extra: { [GRANT_EXTRA_KEY]: grant },
      }),
    ).toEqual({ grant: "AbCdEfGh" });
    expect(principalLogFields({ token: "bearer", clientId: "bearer", scopes: [] })).toEqual({
      grant: "bearer",
    });
    expect(principalLogFields(undefined)).toEqual({});
  });
});
