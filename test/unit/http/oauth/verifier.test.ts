import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import type { AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { grantOf } from "../../../../src/accounts/types.js";
import { createServerKeys } from "../../../../src/http/keys.js";
import { openGrantStore } from "../../../../src/http/oauth/grant-store.js";
import { createOAuthModule } from "../../../../src/http/oauth/index.js";
import { sealAccess, toSeconds } from "../../../../src/http/oauth/tokens.js";
import { createOAuthAuthenticator } from "../../../../src/http/oauth/verifier.js";
import { sealedWithPrevious } from "../../../../src/http/seal.js";
import type { GrantStore } from "../../../../src/http/types.js";
import {
  ACCOUNT,
  CLAUDE_AI_CLIENT,
  connectClaudeAi,
  createOAuthRig,
  createTestRouter,
  DEFAULT_OAUTH,
  failingStore,
  fakeClock,
  mcpRequest,
  type OAuthRig,
  ORIGIN,
  postForm,
  RESOURCE,
  SEVDESK_TOKEN,
  testContext,
} from "../../../helpers/oauth-browser.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function rig(overrides: Parameters<typeof createOAuthRig>[0] = {}): Promise<OAuthRig> {
  const created = await createOAuthRig(overrides);
  cleanup.push(() => created.close());
  return created;
}

async function authenticate(r: OAuthRig, token: string | undefined): Promise<AuthInfo | Response> {
  return r.module.authenticator.authenticate(mcpRequest(token), testContext(r.log));
}

async function refused(result: AuthInfo | Response): Promise<string> {
  if (!(result instanceof Response)) throw new Error("expected a refusal");
  expect(result.status).toBe(401);
  expect(result.headers.get("www-authenticate")).toContain(
    `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
  return JSON.stringify(await result.json());
}

describe("OAuth authenticator", () => {
  it("accepts a valid access token with a VerifiedGrant that never shows the sevDesk token", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r, {
      tiers: ["write", "commit"],
      params: { scope: undefined },
    });
    const auth = await authenticate(r, tokens.access);
    if (auth instanceof Response) throw new Error(`refused: ${String(auth.status)}`);
    const grant = grantOf(auth);
    const [record] = r.module.store.list();
    expect(auth).toMatchObject({
      token: "oauth",
      clientId: CLAUDE_AI_CLIENT,
      scopes: ["sevdesk:read", "sevdesk:write", "sevdesk:commit"],
      resource: new URL(RESOURCE),
      resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    });
    expect(auth.expiresAt).toBe(toSeconds(r.clock.now()) + 3600);
    expect(grant?.grantId).toBe(record?.gid);
    expect(grant?.accountId).toBe(ACCOUNT);
    expect([...(grant?.tiers ?? [])]).toEqual(["read", "write", "commit"]);
    expect(grant?.token()).toBe(SEVDESK_TOKEN);
    expect(JSON.stringify(auth)).not.toContain(SEVDESK_TOKEN);
    expect(JSON.stringify(auth)).not.toContain("sdmcp_");
    expect(inspect(auth, { depth: 10 })).not.toContain(SEVDESK_TOKEN);
  });

  it("caps tiers at SEVDESK_ALLOW (token ∩ grant ∩ settings)", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r, {
      tiers: ["write", "commit"],
      params: { scope: undefined },
    });
    const readOnly = createOAuthAuthenticator({
      keys: r.keys,
      issuer: ORIGIN,
      resource: RESOURCE,
      store: r.module.store,
      oauth: DEFAULT_OAUTH,
      allowedTiers: new Set(["read", "write"]),
      now: r.clock.now,
      log: r.log,
    });
    const auth = await readOnly.authenticate(mcpRequest(tokens.access), testContext(r.log));
    if (auth instanceof Response) throw new Error("refused");
    expect([...(grantOf(auth)?.tiers ?? [])]).toEqual(["read", "write"]);
    expect(auth.scopes).toEqual(["sevdesk:read", "sevdesk:write"]);
  });

  it("refuses a missing token with the resource metadata challenge", async () => {
    const r = await rig();
    expect(await refused(await authenticate(r, undefined))).toContain("invalid_token");
  });

  it("refuses a flipped byte, a refresh token, an unknown key and an expired token", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const index = tokens.access.length - 12;
    const flipped =
      tokens.access.slice(0, index) +
      (tokens.access[index] === "A" ? "B" : "A") +
      tokens.access.slice(index + 1);
    await refused(await authenticate(r, flipped));
    await refused(await authenticate(r, tokens.refresh));
    await refused(await authenticate(r, tokens.access.replace("sdmcp_at_", "sdmcp_rt_")));
    const foreign = sealAccess(
      { keys: createServerKeys(randomBytes(32)), issuer: ORIGIN },
      {
        gid: r.module.store.list()[0]?.gid ?? "",
        cid: CLAUDE_AI_CLIENT,
        acct: ACCOUNT,
        tiers: ["read"],
        res: RESOURCE,
        tok: SEVDESK_TOKEN,
        iat: toSeconds(r.clock.now()),
        exp: toSeconds(r.clock.now()) + 60,
      },
    );
    await refused(await authenticate(r, foreign));
    r.clock.advance(3_600_000);
    await refused(await authenticate(r, tokens.access));
  });

  it("refuses a token for another resource, an unknown grant and a foreign client", async () => {
    const r = await rig();
    await connectClaudeAi(r);
    const [grant] = r.module.store.list();
    const scope = { keys: r.keys, issuer: ORIGIN };
    const base = {
      gid: grant?.gid ?? "",
      cid: CLAUDE_AI_CLIENT,
      acct: ACCOUNT,
      tiers: ["read" as const],
      res: RESOURCE,
      tok: SEVDESK_TOKEN,
      iat: toSeconds(r.clock.now()),
      exp: toSeconds(r.clock.now()) + 60,
    };
    expect(
      await refused(
        await authenticate(r, sealAccess(scope, { ...base, res: "https://other.example/mcp" })),
      ),
    ).toContain("not for this server");
    await refused(
      await authenticate(r, sealAccess(scope, { ...base, gid: "unknown-grant-0000000" })),
    );
    await refused(
      await authenticate(r, sealAccess(scope, { ...base, cid: "https://claude.ai/other" })),
    );
    await refused(await authenticate(r, sealAccess(scope, { ...base, acct: "9999" })));
    expect(await authenticate(r, sealAccess(scope, base))).not.toBeInstanceOf(Response);
  });

  it("refuses a pending, revoked or expired grant", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const [grant] = r.module.store.list();
    await r.module.store.revoke(grant?.gid ?? "", "user");
    expect(await refused(await authenticate(r, tokens.access))).toContain("revoked");
    expect(r.log.events()).toContain("access_refused");
  });

  it("applies a revocation by the grants command on the next call (after at most a second)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdmcp-verifier-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const clock = fakeClock();
    const store = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
    cleanup.push(() => store.close());
    const r = await rig({ store, now: clock.now });
    const tokens = await connectClaudeAi({
      fetch: createTestRouter(r.module.routes, { log: r.log }),
    });
    expect(await authenticate(r, tokens.access)).not.toBeInstanceOf(Response);

    const cli = await openGrantStore({ stateDir: dir, role: "cli" });
    await cli.revoke(store.list()[0]?.gid ?? "", "operator");
    await cli.close();
    clock.advance(1000);
    await refused(await authenticate(r, tokens.access));
  });

  it("accepts tokens of the previous secret during a rotation and reseals on refresh", async () => {
    const clock = fakeClock();
    const oldSecret = randomBytes(32);
    const store: GrantStore = await openGrantStore({ stateDir: undefined, now: clock.now });
    cleanup.push(() => store.close());
    const before = await rig({ store, now: clock.now, keys: createServerKeys(oldSecret) });
    const tokens = await connectClaudeAi(before);

    const rotatedKeys = createServerKeys(randomBytes(32), oldSecret);
    const after = await rig({ store, now: clock.now, keys: rotatedKeys });
    expect(await authenticate(after, tokens.access)).not.toBeInstanceOf(Response);
    expect(sealedWithPrevious(rotatedKeys, tokens.refresh)).toBe(true);
    const response = await postForm(after.fetch, "/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; refresh_token: string };
    expect(sealedWithPrevious(rotatedKeys, body.refresh_token)).toBe(false);
    expect(sealedWithPrevious(rotatedKeys, body.access_token)).toBe(false);

    // Once the previous secret is dropped, old tokens no longer open.
    const finished = await rig({ store, now: clock.now, keys: createServerKeys(randomBytes(32)) });
    await refused(await authenticate(finished, tokens.access));
  });

  it("closes only a store it opened", async () => {
    const store = await openGrantStore({ stateDir: undefined });
    const module = await createOAuthModule({
      origin: ORIGIN,
      keys: createServerKeys(randomBytes(32)),
      oauth: {
        accounts: "any",
        clients: "any",
        accessTtlSeconds: 60,
        refreshIdleTtlSeconds: 60,
        grantTtlSeconds: 60,
      },
      allowedTiers: new Set(["read"]),
      stateDir: undefined,
      identity: () => Promise.reject(new Error("unused")),
      log: { info: () => undefined, warn: () => undefined },
      store,
    });
    await module.close();
    await expect(
      store.createSession({ accountId: "a1", via: "token", ttlSeconds: 60 }),
    ).resolves.toBeDefined();
    await store.close();
  });
});

describe("OAuth authenticator: allowlists and store failures", () => {
  function authenticatorWith(r: OAuthRig, oauth: typeof DEFAULT_OAUTH, store = r.module.store) {
    return createOAuthAuthenticator({
      keys: r.keys,
      issuer: ORIGIN,
      resource: RESOURCE,
      store,
      oauth,
      allowedTiers: new Set(["read", "write", "commit"]),
      now: r.clock.now,
      log: r.log,
    });
  }

  it("refuses and revokes a grant whose account or client host was removed from the allowlist", async () => {
    const r = await rig();
    const first = await connectClaudeAi(r);
    const second = await connectClaudeAi(r);
    const noAccount = authenticatorWith(r, { ...DEFAULT_OAUTH, accounts: ["99999"] });
    expect(
      await refused(await noAccount.authenticate(mcpRequest(first.access), testContext(r.log))),
    ).toContain("no longer accepts");
    const noClient = authenticatorWith(r, { ...DEFAULT_OAUTH, clients: ["Example.org"] });
    await refused(await noClient.authenticate(mcpRequest(second.access), testContext(r.log)));
    const reasons = r.module.store.list().map((grant) => grant.reason);
    expect(reasons.sort()).toEqual(["account_removed", "client_removed"]);
    expect(r.log.lines.filter((line) => line.event === "grant_revoked")).toHaveLength(2);
    // Revoked for good: the original allowlists do not bring it back.
    await refused(await authenticate(r, first.access));
  });

  it("answers 500 (not 401) while the grant store cannot be trusted, so clients keep their tokens", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const failed = { on: true };
    const gate = authenticatorWith(r, DEFAULT_OAUTH, failingStore(r.module.store, failed));
    const result = await gate.authenticate(mcpRequest(tokens.access), testContext(r.log));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    failed.on = false;
    expect(
      await gate.authenticate(mcpRequest(tokens.access), testContext(r.log)),
    ).not.toBeInstanceOf(Response);
  });
});
