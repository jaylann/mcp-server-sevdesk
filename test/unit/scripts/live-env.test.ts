import { describe, expect, it } from "vitest";

import {
  berlinToday,
  DEFAULT_MAX_EXISTING_RECORDS,
  foreignRecordCounts,
  lifecycleEmail,
  lifecycleGate,
  maxExistingRecords,
  passthrough,
  probeEmailAddress,
  readOnlyEnv,
  runTag,
  tokenMissingReason,
  trialCheck,
  writeEnv,
  writeGate,
} from "../../../scripts/lib/live-env.js";
import { loadConfig } from "../../../src/config.js";
import { ScriptedClient } from "./scripted-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("tokenMissingReason", () => {
  it("explains the skip without a token and is quiet with one", () => {
    expect(tokenMissingReason({})).toMatch(/SEVDESK_API_TOKEN is not set.*skipped/);
    expect(tokenMissingReason({ SEVDESK_API_TOKEN: "  " })).toBeDefined();
    expect(tokenMissingReason({ SEVDESK_API_TOKEN: TOKEN })).toBeUndefined();
    expect(tokenMissingReason({ SEVDESK_API_TOKEN_FILE: "/run/secrets/token" })).toBeUndefined();
  });
});

describe("environments", () => {
  const shell = {
    SEVDESK_API_TOKEN: TOKEN,
    SEVDESK_BASE_URL: "https://my.sevdesk.de/api/v1",
    SEVDESK_RATE_LIMIT: "2",
    SEVDESK_ALLOW: "all",
    SEVDESK_CONFIRM: "off",
    SEVDESK_I_UNDERSTAND_NO_CONFIRM: "1",
    SEVDESK_READ_ONLY: "0",
    SEVDESK_DRY_RUN: "1",
    SEVDESK_AUDIT_LOG: "/tmp/audit.jsonl",
    HOME: "/Users/someone",
  };

  it("passes only the whitelisted variables through", () => {
    expect(passthrough(shell)).toEqual({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_BASE_URL: "https://my.sevdesk.de/api/v1",
      SEVDESK_RATE_LIMIT: "2",
    });
  });

  it("builds a read-only config whatever the shell enables", () => {
    const config = loadConfig(readOnlyEnv(shell));
    expect(config.readOnly).toBe(true);
    expect([...config.allowedTiers]).toEqual(["read"]);
    expect(config.dryRun).toBe(false);
    expect(config.toolsets.size).toBeGreaterThan(5);
    expect(config.requestsPerSecond).toBe(2);
  });

  it("adds the external tier only when asked (an e-mail address the operator owns)", () => {
    const config = loadConfig(writeEnv(shell, { external: true }));
    expect([...config.allowedTiers].sort()).toEqual(["commit", "external", "read", "write"]);
    expect(probeEmailAddress(undefined)).toBeUndefined();
    expect(probeEmailAddress("  ")).toBeUndefined();
    expect(probeEmailAddress(" me@example.org ")).toBe("me@example.org");
    expect(() => probeEmailAddress("a@example.org,b@example.org")).toThrow(/exactly one/);
    expect(() => probeEmailAddress("Me <me@example.org>")).toThrow(/exactly one/);
    expect(lifecycleEmail({ SEVDESK_LIVE_EMAIL_TO: "me@example.org" })).toBe("me@example.org");
    expect(lifecycleEmail({})).toBeUndefined();
  });

  it("builds a write config with write and commit, never external", () => {
    const config = loadConfig(writeEnv(shell));
    expect(config.readOnly).toBe(false);
    expect([...config.allowedTiers].sort()).toEqual(["commit", "read", "write"]);
    expect(config.allowedTiers.has("external")).toBe(false);
    expect(config.confirm).toBe("off");
    expect(config.auditLogPath).toBeUndefined();
  });
});

describe("lifecycleGate", () => {
  const base = { SEVDESK_API_TOKEN: TOKEN };

  it.each([
    [{}, /SEVDESK_API_TOKEN is not set/],
    [base, /Lifecycle scenario off/],
    [{ ...base, SEVDESK_LIVE_LIFECYCLE: "1" }, /also need SEVDESK_LIVE_I_UNDERSTAND_WRITES=1/],
    [{ ...base, SEVDESK_LIVE_I_UNDERSTAND_WRITES: "1" }, /also needs SEVDESK_LIVE_LIFECYCLE=1/],
    [
      { ...base, SEVDESK_LIVE_LIFECYCLE: "yes", SEVDESK_LIVE_I_UNDERSTAND_WRITES: "1" },
      /also needs/,
    ],
  ])("stays closed for %j", (env, reason) => {
    const gate = lifecycleGate(env);
    expect(gate.open).toBe(false);
    expect(gate.open ? "" : gate.reason).toMatch(reason);
  });

  it("opens only with a token and both flags", () => {
    expect(
      lifecycleGate({
        ...base,
        SEVDESK_LIVE_LIFECYCLE: "1",
        SEVDESK_LIVE_I_UNDERSTAND_WRITES: "true",
      }),
    ).toEqual({ open: true });
  });
});

describe("writeGate", () => {
  it("needs the token, the flag and the acknowledgement", () => {
    expect(writeGate({}, true)).toMatchObject({ open: false });
    expect(writeGate({ SEVDESK_API_TOKEN: TOKEN }, false)).toEqual({
      open: false,
      reason: "write probes need --allow-writes",
    });
    expect(writeGate({ SEVDESK_API_TOKEN: TOKEN }, true)).toMatchObject({
      open: false,
      reason: expect.stringMatching(/SEVDESK_LIVE_I_UNDERSTAND_WRITES=1/) as unknown,
    });
    expect(
      writeGate({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_LIVE_I_UNDERSTAND_WRITES: "1" }, true),
    ).toEqual({ open: true });
  });
});

describe("trial heuristic", () => {
  it("refuses accounts with more foreign records than the limit", () => {
    expect(trialCheck({ invoices: 3, contacts: 2 }, 60)).toBeUndefined();
    expect(trialCheck({ invoices: 60, contacts: 0 }, 60)).toBeUndefined();
    expect(trialCheck({ invoices: 50, contacts: 11 }, 60)).toMatch(
      /already holds 50 invoices and 11 contacts \(limit 60\).*SEVDESK_LIVE_MAX_EXISTING_RECORDS/,
    );
  });

  it("reads the limit from the environment", () => {
    expect(maxExistingRecords({})).toBe(DEFAULT_MAX_EXISTING_RECORDS);
    expect(maxExistingRecords({ SEVDESK_LIVE_MAX_EXISTING_RECORDS: "200" })).toBe(200);
    expect(() => maxExistingRecords({ SEVDESK_LIVE_MAX_EXISTING_RECORDS: "-1" })).toThrow(
      /whole number/,
    );
  });

  it("counts records this tooling did not create, rows beyond the page as foreign", async () => {
    const client = new ScriptedClient((call) => {
      if (call.path === "/Invoice") {
        return {
          total: "1203",
          objects: [
            { id: "1", header: "MCP-E2E 20261107-2130-abcd Invoice" },
            { id: "2", header: "Rechnung 1" },
            { id: "3", header: null },
          ],
        };
      }
      return {
        objects: [
          { id: "10", name: "MCP-E2E 20261107-2130-abcd" },
          { id: "11", name: "Kunde GmbH" },
        ],
      };
    });

    expect(await foreignRecordCounts(client)).toEqual({ invoices: 1202, contacts: 1 });
    expect(client.calls.map((call) => [call.path, call.query])).toEqual([
      ["/Invoice", { limit: 1000, offset: 0 }],
      ["/Contact", { depth: 1, limit: 1000, offset: 0 }],
    ]);
  });
});

describe("runTag and berlinToday", () => {
  it("tags runs with the Berlin wall clock and a random suffix", () => {
    const now = new Date("2026-11-07T20:30:00Z");
    expect(runTag(now, () => 0)).toBe("MCP-E2E 20261107-2130-aaaa");
    expect(runTag(now, () => 0.999)).toMatch(/^MCP-E2E 20261107-2130-[a-z2-9]{4}$/);
    expect(berlinToday(new Date("2026-11-07T23:30:00Z"))).toBe("2026-11-08");
  });
});
