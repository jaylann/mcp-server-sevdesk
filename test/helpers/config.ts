import type { Config } from "../../src/config.js";
import { type Tier, TIERS } from "../../src/safety/tiers.js";
import { DEFAULT_TOOLSETS, type ToolsetName, TOOLSETS } from "../../src/tools/toolsets.js";

/** A syntactically valid, fake sevDesk token (32 hex chars). Tests assert it never leaks. */
export const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

/**
 * A complete {@link Config} with the defaults `loadConfig` produces for a minimal environment
 * (read tier only, default toolsets, structured output `auto`), plus `overrides`.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: TEST_TOKEN,
    baseUrl: "https://my.sevdesk.de/api/v1",
    allowedTiers: new Set<Tier>(["read"]),
    readOnly: false,
    dryRun: false,
    confirm: "elicit",
    // Tests never launch a browser; write-flow tests inject an opener.
    confirmOpen: false,
    toolsets: new Set<ToolsetName>(DEFAULT_TOOLSETS),
    structuredOutput: "auto",
    requestsPerSecond: 4,
    timeoutMs: 30_000,
    auditLogPath: undefined,
    outputDir: undefined,
    fileDirs: [],
    userAgent: "mcp-server-sevdesk/0.0.0-test",
    ...overrides,
  };
}

/** Shorthand for `allowedTiers`. */
export function tiers(...allowed: Tier[]): ReadonlySet<Tier> {
  return new Set<Tier>(allowed);
}

/** Every tier and every toolset enabled. */
export function allEnabledConfig(overrides: Partial<Config> = {}): Config {
  return testConfig({
    allowedTiers: new Set<Tier>(TIERS),
    toolsets: new Set<ToolsetName>(TOOLSETS),
    ...overrides,
  });
}
