import { inspect } from "node:util";

import type { AuthInfo } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  createAccountResolver,
  MissingGrantError,
  type OAuthAccountOptions,
  tierKey,
} from "../../../src/accounts/resolver.js";
import { GRANT_EXTRA_KEY, VerifiedGrant } from "../../../src/accounts/types.js";
import type { Config, Deployment } from "../../../src/config.js";
import type { Tier } from "../../../src/safety/tiers.js";
import type { Pacer } from "../../../src/sevdesk/pacing.js";
import type { SevdeskClient } from "../../../src/sevdesk/types.js";
import { TEST_TOKEN, testConfig } from "../../helpers/config.js";
import { stubClient } from "../../helpers/dummy-tools.js";
import { createFakeClock, createFakeFetch, envelope } from "../../helpers/fake-fetch.js";

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_A_NEW = "abababababababababababababababab";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";

const DEPLOYMENT: Deployment = {
  kind: "http",
  auth: "oauth",
  publicOrigin: "https://mcp.example.com",
  approvalsUrl: "https://mcp.example.com/approvals",
};

/** The process settings: every tier but `external`, file access configured (and ignored). */
function settings() {
  const {
    token: _token,
    account: _account,
    deployment: _deployment,
    ...rest
  } = testConfig({
    allowedTiers: new Set<Tier>(["read", "write", "commit"]),
    fileDirs: ["/srv/belege"],
    outputDir: "/srv/out",
    confirmOpen: true,
    auditLogPath: "/var/log/sevdesk-audit.jsonl",
  });
  return rest;
}

function authInfo(
  accountId: string,
  token: string,
  tiers: readonly Tier[] = ["read", "write"],
  grantId = `grant-${accountId}`,
): AuthInfo {
  return {
    token: "sdmcp_at.opaque",
    clientId: CLIENT,
    scopes: [...tiers],
    extra: {
      [GRANT_EXTRA_KEY]: new VerifiedGrant(
        { grantId, accountId, clientId: CLIENT, tiers: new Set(tiers) },
        token,
      ),
    },
  };
}

interface Created {
  readonly config: Config;
  readonly pacer: Pacer;
}

function oauth(overrides: Partial<OAuthAccountOptions> = {}) {
  const created: Created[] = [];
  let now = 1_000_000;
  const resolver = createAccountResolver({
    mode: "oauth",
    settings: settings(),
    deployment: DEPLOYMENT,
    createClient: (config, pacer) => {
      created.push({ config, pacer });
      return stubClient();
    },
    now: () => now,
    ...overrides,
  });
  return {
    resolver,
    created,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("fixed resolver (stdio, bearer)", () => {
  it("serves every request with the one context", () => {
    const config = testConfig();
    const client = stubClient();
    const resolver = createAccountResolver({ mode: "fixed", config, client });

    const plain = resolver.resolve(undefined);
    const withGrant = resolver.resolve(authInfo("1001", TOKEN_A));
    resolver.close();

    expect(plain).toBe(withGrant);
    expect(plain).toEqual({ key: "fixed", config, client });
    expect(Object.isFrozen(plain)).toBe(true);
    expect(resolver.resolve(undefined)).toBe(plain);
  });
});

describe("OAuth resolver: the account's config", () => {
  it("refuses a request without a verified grant", () => {
    const { resolver } = oauth();

    expect(() => resolver.resolve(undefined)).toThrow(MissingGrantError);
    expect(() =>
      resolver.resolve({ token: "bearer", clientId: "bearer", scopes: [], extra: {} }),
    ).toThrow(/without a verified grant/);
  });

  it("derives a frozen config: tiers granted ∩ allowed, no file access, no opener, the account", () => {
    const { resolver } = oauth();

    const { config } = resolver.resolve(authInfo("1001", TOKEN_A, ["read", "commit", "external"]));

    expect([...config.allowedTiers]).toEqual(["read", "commit"]);
    expect(config.fileDirs).toEqual([]);
    expect(config.outputDir).toBeUndefined();
    expect(config.confirmOpen).toBe(false);
    expect(config.account).toEqual({ id: "1001" });
    expect(config.deployment).toBe(DEPLOYMENT);
    expect(config.token).toBe(TOKEN_A);
    expect(config.auditLogPath).toBe("/var/log/sevdesk-audit.jsonl");
    expect(config.baseUrl).toBe(settings().baseUrl);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.fileDirs)).toBe(true);
  });

  it("keeps the token out of serialized and inspected configs and contexts", () => {
    const { resolver } = oauth();

    const context = resolver.resolve(authInfo("1001", TOKEN_A));

    expect(JSON.stringify(context.config)).not.toContain(TOKEN_A);
    expect(inspect(context, { depth: 5 })).not.toContain(TOKEN_A);
    expect(context.key).not.toContain(TOKEN_A);
    expect({ ...context.config }).not.toHaveProperty("token");
  });

  it("keys contexts by account, token fingerprint and tiers", () => {
    const { resolver } = oauth();

    const { key } = resolver.resolve(authInfo("1001", TOKEN_A, ["read", "write"]));

    expect(key).toMatch(/^1001:[A-Za-z0-9_-]{22}:read\+write$/);
  });

  it("names tier sets in tier order", () => {
    expect(tierKey(new Set<Tier>(["commit", "read"]))).toBe("read+commit");
    expect(tierKey(new Set<Tier>())).toBe("");
  });
});

describe("OAuth resolver: contexts", () => {
  it("reuses the context of the same account, token and tiers (any grant)", () => {
    const { resolver, created } = oauth();

    const first = resolver.resolve(authInfo("1001", TOKEN_A));
    const again = resolver.resolve(authInfo("1001", TOKEN_A, ["read", "write"], "grant-other"));

    expect(again).toBe(first);
    expect(created).toHaveLength(1);
  });

  it("gives every account, token and tier set its own config and client", () => {
    const { resolver } = oauth();

    const contexts = [
      resolver.resolve(authInfo("1001", TOKEN_A)),
      resolver.resolve(authInfo("1001", TOKEN_A_NEW)),
      resolver.resolve(authInfo("1001", TOKEN_A, ["read"])),
      resolver.resolve(authInfo("2002", TOKEN_B)),
    ];

    expect(new Set(contexts.map((context) => context.config)).size).toBe(4);
    expect(new Set(contexts.map((context) => context.client)).size).toBe(4);
    expect(new Set(contexts.map((context) => context.key)).size).toBe(4);
  });

  it("shares one pacer between the clients of one account, not between accounts", () => {
    const { resolver, created } = oauth();

    resolver.resolve(authInfo("1001", TOKEN_A, ["read", "write"]));
    resolver.resolve(authInfo("1001", TOKEN_A, ["read"]));
    resolver.resolve(authInfo("2002", TOKEN_B));

    expect(created[0]?.pacer).toBe(created[1]?.pacer);
    expect(created[2]?.pacer).not.toBe(created[0]?.pacer);
  });

  it("keeps at most maxContexts, dropping the least recently used", () => {
    const { resolver, created } = oauth({ maxContexts: 2 });
    const a = resolver.resolve(authInfo("1001", TOKEN_A));
    resolver.resolve(authInfo("2002", TOKEN_B));
    resolver.resolve(authInfo("1001", TOKEN_A)); // a is now the most recently used

    resolver.resolve(authInfo("3003", TOKEN_A_NEW)); // drops 2002

    expect(resolver.resolve(authInfo("1001", TOKEN_A))).toBe(a);
    expect(created).toHaveLength(3);
    resolver.resolve(authInfo("2002", TOKEN_B));
    expect(created).toHaveLength(4);
  });

  it("drops contexts unused for 15 minutes, and the pacer with the account's last context", () => {
    const { resolver, created, advance } = oauth();
    const first = resolver.resolve(authInfo("1001", TOKEN_A));
    resolver.resolve(authInfo("2002", TOKEN_B));

    advance(14 * 60_000);
    expect(resolver.resolve(authInfo("1001", TOKEN_A))).toBe(first);
    advance(15 * 60_000);
    const fresh = resolver.resolve(authInfo("1001", TOKEN_A));

    expect(fresh).not.toBe(first);
    expect(fresh.config).not.toBe(first.config);
    expect(created.at(-1)?.pacer).not.toBe(created[0]?.pacer);
    // 2002 idled out too: a new client and pacer.
    resolver.resolve(authInfo("2002", TOKEN_B));
    expect(created).toHaveLength(4);
    expect(created[3]?.pacer).not.toBe(created[1]?.pacer);
  });

  it("forgets every context on close", () => {
    const { resolver } = oauth();
    const first = resolver.resolve(authInfo("1001", TOKEN_A));

    resolver.close();

    expect(resolver.resolve(authInfo("1001", TOKEN_A))).not.toBe(first);
  });

  it("builds real clients that send the grant's token, with the client deps given", async () => {
    const clock = createFakeClock();
    const fake = createFakeFetch(envelope({ version: "2.0" }));
    const resolver = createAccountResolver({
      mode: "oauth",
      settings: settings(),
      deployment: DEPLOYMENT,
      clientDeps: { fetch: fake.fetch, sleep: clock.sleep, monotonicNow: clock.now },
    });
    const client: SevdeskClient = resolver.resolve(authInfo("1001", TOKEN_A)).client;

    await client.request({ method: "GET", path: "/Tools/bookkeepingSystemVersion" });

    expect(fake.requests[0]?.headers.get("authorization")).toBe(TOKEN_A);
    expect(fake.requests[0]?.headers.get("authorization")).not.toBe(TEST_TOKEN);
  });
});
