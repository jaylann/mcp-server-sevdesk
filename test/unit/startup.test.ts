import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { checkConnection } from "../../src/startup.js";
import { stubClient } from "../helpers/dummy-tools.js";

const config = {
  readOnly: false,
  dryRun: false,
  allowedTiers: new Set(["read", "write"] as const),
};

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

describe("checkConnection", () => {
  it("reports the bookkeeping system version and active tiers", async () => {
    const client = stubClient({ request: () => Promise.resolve({ version: "2.0" }) });
    const { lines, log } = collect();

    const result = await checkConnection(client, config, log);

    expect(result).toEqual({ ok: true, systemVersion: "2.0" });
    expect(lines).toEqual(["connected to sevDesk (bookkeeping system 2.0); tiers: read, write"]);
  });

  it("mentions dry-run mode", async () => {
    const client = stubClient({ request: () => Promise.resolve({ version: "1.0" }) });
    const { lines, log } = collect();

    await checkConnection(client, { ...config, dryRun: true }, log);

    expect(lines[0]).toMatch(/bookkeeping system 1\.0.*; dry-run$/);
  });

  it("warns instead of failing when the token is rejected", async () => {
    const error = new SevdeskError({
      kind: "auth",
      message: "sevDesk rejected the API token (HTTP 401).",
    });
    const client = stubClient({ request: () => Promise.reject(error) });
    const { lines, log } = collect();

    const result = await checkConnection(client, config, log);

    expect(result).toEqual({ ok: false, message: error.message });
    expect(lines).toEqual([`warning: startup check failed: ${error.message}`]);
  });

  it("never echoes unexpected error text", async () => {
    const client = stubClient({
      request: () => Promise.reject(new Error("socket hang up token=deadbeef")),
    });
    const { lines, log } = collect();

    const result = await checkConnection(client, config, log);

    expect(result.ok).toBe(false);
    expect(lines.join("\n")).not.toContain("deadbeef");
  });
});
