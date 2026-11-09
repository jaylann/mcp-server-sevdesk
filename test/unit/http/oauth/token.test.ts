import { afterEach, describe, expect, it } from "vitest";

import { IdentityError, type IdentityLookup } from "../../../../src/accounts/types.js";
import { openGrantStore } from "../../../../src/http/oauth/grant-store.js";
import { tokenRoute } from "../../../../src/http/oauth/token.js";
import { openRefresh, toSeconds } from "../../../../src/http/oauth/tokens.js";
import {
  ACCOUNT,
  authorizeUrl,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  completeConsent,
  connectClaudeAi,
  createOAuthRig,
  createTestRouter,
  DEFAULT_OAUTH,
  failingStore,
  fakeIdentity,
  mcpRequest,
  type OAuthRig,
  ORIGIN,
  OTHER_ACCOUNT,
  pkcePair,
  postForm,
  RESOURCE,
  SEVDESK_TOKEN,
  testContext,
} from "../../../helpers/oauth-browser.js";

const rigs: OAuthRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});

async function rig(overrides: Parameters<typeof createOAuthRig>[0] = {}): Promise<OAuthRig> {
  const created = await createOAuthRig(overrides);
  rigs.push(created);
  return created;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function expectError(response: Response, error: string, status = 400): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect((await json(response))["error"]).toBe(error);
}

/** A code from a completed consent, not yet exchanged. */
async function freshCode(r: OAuthRig): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = await pkcePair();
  const { redirect } = await completeConsent(r.fetch, authorizeUrl({ code_challenge: challenge }));
  return { code: redirect.searchParams.get("code") ?? "", verifier };
}

function exchange(r: OAuthRig, params: Record<string, string>) {
  return postForm(r.fetch, "/token", { grant_type: "authorization_code", ...params });
}

function refresh(r: OAuthRig, token: string, extra: Record<string, string> = {}) {
  return postForm(r.fetch, "/token", {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: CLAUDE_AI_CLIENT,
    ...extra,
  });
}

async function mcpStatus(r: OAuthRig, token: string): Promise<number> {
  return (await r.fetch(mcpRequest(token))).status;
}

describe("POST /token: authorization_code", () => {
  it("issues a sealed access and refresh token and activates the grant", async () => {
    const r = await rig();
    const { code, verifier } = await freshCode(r);
    const response = await exchange(r, {
      code,
      redirect_uri: CLAUDE_AI_REDIRECT,
      code_verifier: verifier,
      client_id: CLAUDE_AI_CLIENT,
      resource: RESOURCE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await json(response);
    expect(body).toEqual({
      access_token: expect.stringMatching(/^sdmcp_at_/) as unknown,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^sdmcp_rt_/) as unknown,
      scope: "sevdesk:read",
    });
    expect(r.module.store.list()[0]).toMatchObject({ status: "active", gen: 1 });
    expect(await mcpStatus(r, String(body["access_token"]))).toBe(204);
    expect(r.log.events()).toContain("token_issued");
  });

  it("refuses a wrong verifier without using up the code", async () => {
    const r = await rig();
    const { code, verifier } = await freshCode(r);
    const base = { code, redirect_uri: CLAUDE_AI_REDIRECT, client_id: CLAUDE_AI_CLIENT };
    await expectError(
      await exchange(r, { ...base, code_verifier: (await pkcePair()).verifier }),
      "invalid_grant",
    );
    await expectError(await exchange(r, { ...base, code_verifier: "short" }), "invalid_grant");
    await expectError(
      await exchange(r, { ...base, code_verifier: `${verifier}!` }),
      "invalid_grant",
    );
    expect(r.module.store.list()[0]?.status).toBe("pending");
    expect((await exchange(r, { ...base, code_verifier: verifier })).status).toBe(200);
  });

  it("refuses another redirect URI, another client, a tampered or expired code", async () => {
    const r = await rig();
    const { code, verifier } = await freshCode(r);
    const base = {
      code,
      redirect_uri: CLAUDE_AI_REDIRECT,
      client_id: CLAUDE_AI_CLIENT,
      code_verifier: verifier,
    };
    await expectError(
      await exchange(r, { ...base, redirect_uri: `${CLAUDE_AI_REDIRECT}/` }),
      "invalid_grant",
    );
    await expectError(
      await exchange(r, { ...base, client_id: "https://claude.ai/oauth/other" }),
      "invalid_grant",
    );
    const flipped = code.slice(0, -5) + (code.at(-5) === "A" ? "B" : "A") + code.slice(-4);
    await expectError(await exchange(r, { ...base, code: flipped }), "invalid_grant");
    await expectError(
      await exchange(r, { ...base, resource: "https://other.example/mcp" }),
      "invalid_target",
    );
    r.clock.advance(60_000);
    await expectError(await exchange(r, base), "invalid_grant");
  });

  it("treats a second exchange of a code as a replay and revokes the grant", async () => {
    const r = await rig();
    const first = await connectClaudeAi(r);
    const again = await exchange(r, {
      code: first.code,
      redirect_uri: CLAUDE_AI_REDIRECT,
      code_verifier: first.verifier,
      client_id: CLAUDE_AI_CLIENT,
    });
    await expectError(again, "invalid_grant");
    expect(r.module.store.list()[0]).toMatchObject({ status: "revoked", reason: "code_replay" });
    expect(r.log.lines).toContainEqual(
      expect.objectContaining({ level: "warn", event: "code_replay" }),
    );
    expect(await mcpStatus(r, first.access)).toBe(401);
    await expectError(await refresh(r, first.refresh), "invalid_grant");
  });

  it("refuses incomplete, malformed and confidential-client requests", async () => {
    const r = await rig();
    await expectError(await exchange(r, { code: "x" }), "invalid_request");
    await expectError(await postForm(r.fetch, "/token", {}), "invalid_request");
    await expectError(
      await postForm(r.fetch, "/token", { grant_type: "password" }),
      "unsupported_grant_type",
    );
    await expectError(
      await postForm(r.fetch, "/token", { grant_type: "client_credentials", client_secret: "s" }),
      "invalid_client",
      401,
    );
    const basic = await r.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic eDp5",
        },
        body: "grant_type=refresh_token&refresh_token=x",
      }),
    );
    await expectError(basic, "invalid_client", 401);
    const asJson = await r.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      }),
    );
    await expectError(asJson, "invalid_request");
    const duplicate = await r.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&grant_type=authorization_code",
      }),
    );
    await expectError(duplicate, "invalid_request");
    const big = await postForm(r.fetch, "/token", {
      grant_type: "refresh_token",
      pad: "x".repeat(5000),
    });
    await expectError(big, "invalid_request", 413);
  });

  it("refuses an access token or refresh token presented as a code", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    for (const code of [tokens.access, tokens.refresh]) {
      const response = await exchange(r, {
        code,
        redirect_uri: CLAUDE_AI_REDIRECT,
        code_verifier: tokens.verifier,
        client_id: CLAUDE_AI_CLIENT,
      });
      await expectError(response, "invalid_grant");
    }
  });

  it("answers CORS preflights", async () => {
    const r = await rig();
    const response = await r.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Headers": "content-type, mcp-protocol-version" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, mcp-protocol-version",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("POST /token: refresh_token", () => {
  it("rotates, accepts the previous generation for 30 s, then treats it as a replay", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r, { tiers: ["write"] });
    const first = await refresh(r, tokens.refresh, { resource: RESOURCE });
    expect(first.status).toBe(200);
    const rotated = await json(first);
    expect(rotated["scope"]).toBe("sevdesk:read sevdesk:write");
    expect(rotated["refresh_token"]).not.toBe(tokens.refresh);
    expect(r.module.store.list()[0]?.gen).toBe(2);
    expect(r.identity.calls.filter((token) => token === SEVDESK_TOKEN)).toHaveLength(2);

    // Concurrent refresh with the same (now previous) token, within the grace.
    r.clock.advance(29_000);
    const concurrent = await refresh(r, tokens.refresh);
    expect(concurrent.status).toBe(200);
    const parallel = await json(concurrent);
    const scope = { keys: r.keys, issuer: ORIGIN };
    const now = toSeconds(r.clock.now());
    expect(openRefresh(scope, String(parallel["refresh_token"]), now)?.gen).toBe(2);
    expect(r.module.store.list()[0]?.gen).toBe(2);

    // Both current refresh tokens work; the newer generation advances.
    const next = await refresh(r, String(parallel["refresh_token"]));
    expect(next.status).toBe(200);
    expect(r.module.store.list()[0]?.gen).toBe(3);

    r.clock.advance(31_000);
    await expectError(await refresh(r, String(rotated["refresh_token"])), "invalid_grant");
    expect(r.module.store.list()[0]).toMatchObject({ status: "revoked", reason: "refresh_replay" });
    expect(r.log.lines).toContainEqual(
      expect.objectContaining({ level: "warn", event: "refresh_replay" }),
    );
    const latest = await json(next);
    await expectError(await refresh(r, String(latest["refresh_token"])), "invalid_grant");
    expect(await mcpStatus(r, String(latest["access_token"]))).toBe(401);
  });

  it("revokes the grant when sevDesk no longer accepts the token", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    r.identity.kill(SEVDESK_TOKEN);
    await expectError(await refresh(r, tokens.refresh), "invalid_grant");
    expect(r.module.store.list()[0]).toMatchObject({ status: "revoked", reason: "sevdesk_401" });
    expect(r.log.lines).toContainEqual({
      level: "warn",
      event: "grant_revoked",
      fields: { grant: r.module.store.list()[0]?.gid.slice(0, 8), reason: "sevdesk_401" },
    });
    expect(await mcpStatus(r, tokens.access)).toBe(401);
  });

  it("revokes the grant when the token now belongs to another account", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    r.identity.set(SEVDESK_TOKEN, { accountId: OTHER_ACCOUNT });
    await expectError(await refresh(r, tokens.refresh), "invalid_grant");
    expect(r.module.store.list()[0]).toMatchObject({
      status: "revoked",
      reason: "account_changed",
    });
  });

  it("still refreshes while sevDesk is unreachable", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    r.identity.unreachable(true);
    expect((await refresh(r, tokens.refresh)).status).toBe(200);
    expect(r.log.events()).toContain("identity_check_skipped");
  });

  it("refuses another client, another resource, a wider scope and the wrong token type", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r, { tiers: ["write"] });
    await expectError(
      await refresh(r, tokens.refresh, { client_id: "https://claude.ai/x" }),
      "invalid_grant",
    );
    await expectError(
      await refresh(r, tokens.refresh, { resource: `${RESOURCE}/` }),
      "invalid_target",
    );
    await expectError(
      await refresh(r, tokens.refresh, { scope: "sevdesk:commit" }),
      "invalid_scope",
    );
    await expectError(await refresh(r, tokens.access), "invalid_grant");
    await expectError(
      await postForm(r.fetch, "/token", { grant_type: "refresh_token" }),
      "invalid_request",
    );
    // None of these used up the refresh token.
    const narrowed = await refresh(r, tokens.refresh, { scope: "sevdesk:read offline_access" });
    expect((await json(narrowed))["scope"]).toBe("sevdesk:read");
  });

  it("accepts a refresh without client_id (the token names its client)", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const response = await postForm(r.fetch, "/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
    });
    expect(response.status).toBe(200);
  });

  it("expires refresh tokens after the idle time and never beyond the grant", async () => {
    const short = await rig({ oauth: { ...DEFAULT_OAUTH, grantTtlSeconds: 86_400 } });
    const tokens = await connectClaudeAi(short);
    const scope = { keys: short.keys, issuer: ORIGIN };
    const now = toSeconds(short.clock.now());
    const payload = openRefresh(scope, tokens.refresh, now);
    expect(payload?.exp).toBe(short.module.store.list()[0]?.expiresAt);
    short.clock.advance(86_400_000);
    await expectError(await refresh(short, tokens.refresh), "invalid_grant");

    const idle = await rig();
    const idleTokens = await connectClaudeAi(idle);
    idle.clock.advance(14 * 86_400_000);
    await expectError(await refresh(idle, idleTokens.refresh), "invalid_grant");
    expect(idle.module.store.list()[0]?.status).toBe("active");
  });

  it("caps the access token lifetime at the grant expiry", async () => {
    const r = await rig({ oauth: { ...DEFAULT_OAUTH, grantTtlSeconds: 1800 } });
    const tokens = await connectClaudeAi(r);
    expect(tokens.body["expires_in"]).toBe(1800);
  });

  it("refuses refreshing a grant revoked by the grants command (read before every token request)", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const [grant] = r.module.store.list();
    await r.module.store.revoke(grant?.gid ?? "", "operator");
    await expectError(await refresh(r, tokens.refresh), "invalid_grant");
  });
});

describe("POST /revoke", () => {
  it("revokes the grant of a refresh token; the next call is refused", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const response = await postForm(r.fetch, "/revoke", {
      token: tokens.refresh,
      client_id: CLAUDE_AI_CLIENT,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.module.store.list()[0]).toMatchObject({ status: "revoked", reason: "user" });
    expect(await mcpStatus(r, tokens.access)).toBe(401);
    await expectError(await refresh(r, tokens.refresh), "invalid_grant");
  });

  it("revokes by access token, also with an expired one", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    r.clock.advance(3_700_000);
    const response = await postForm(r.fetch, "/revoke", {
      token: tokens.access,
      token_type_hint: "access_token",
    });
    expect(response.status).toBe(200);
    expect(r.module.store.list()[0]?.status).toBe("revoked");
  });

  it("answers 200 for unknown tokens and 400 without a token", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    expect((await postForm(r.fetch, "/revoke", { token: "sdmcp_rt_garbage" })).status).toBe(200);
    expect((await postForm(r.fetch, "/revoke", { token: SEVDESK_TOKEN })).status).toBe(200);
    expect(r.module.store.list()[0]?.status).toBe("active");
    await expectError(await postForm(r.fetch, "/revoke", {}), "invalid_request");
    await expectError(
      await postForm(r.fetch, "/revoke", { token: "a", client_secret: "b" }),
      "invalid_client",
      401,
    );
    const preflight = await r.fetch(new Request(`${ORIGIN}/revoke`, { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(await mcpStatus(r, tokens.access)).toBe(204);
  });
});

describe("no secrets in token responses' side channels", () => {
  it("logs only grant prefixes", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    await refresh(r, tokens.refresh);
    await postForm(r.fetch, "/revoke", { token: tokens.refresh });
    const log = r.log.text();
    expect(log).not.toContain(SEVDESK_TOKEN);
    expect(log).not.toContain("sdmcp_");
    expect(log).not.toContain(tokens.code);
    const gid = r.module.store.list()[0]?.gid ?? "";
    expect(log).toContain(gid.slice(0, 8));
    expect(log).not.toContain(gid);
    expect(log).toContain(ACCOUNT);
  });
});

describe("POST /token: fix round", () => {
  /** The token endpoint of `r` as it would run with other allowlists (no startup sweep). */
  function routeWith(r: OAuthRig, oauth: typeof DEFAULT_OAUTH) {
    return createTestRouter(
      [
        tokenRoute({
          keys: r.keys,
          issuer: ORIGIN,
          resource: RESOURCE,
          oauth,
          store: r.module.store,
          identity: r.identity.lookup,
          now: r.clock.now,
          log: r.log,
        }),
      ],
      { log: r.log },
    );
  }

  it("revokes a grant on refresh once its account is no longer allowed", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const fetch = routeWith(r, { ...DEFAULT_OAUTH, accounts: ["99999"] });
    const response = await postForm(fetch, "/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
    });
    await expectError(response, "invalid_grant");
    const [grant] = r.module.store.list();
    expect(grant).toMatchObject({ status: "revoked", reason: "account_removed" });
    expect(r.log.lines).toContainEqual({
      level: "warn",
      event: "grant_revoked",
      fields: { grant: grant?.gid.slice(0, 8), reason: "account_removed" },
    });
    // No sevDesk lookup for a grant that is refused anyway.
    expect(r.identity.calls).toHaveLength(1);
  });

  it("revokes a grant on refresh and at the code exchange once its client host is removed", async () => {
    const r = await rig();
    const tokens = await connectClaudeAi(r);
    const fetch = routeWith(r, { ...DEFAULT_OAUTH, clients: ["example.org"] });
    await expectError(
      await postForm(fetch, "/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
      }),
      "invalid_grant",
    );
    expect(r.module.store.list()[0]?.reason).toBe("client_removed");

    const { code, verifier } = await freshCode(r);
    const exchanged = await postForm(fetch, "/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_AI_REDIRECT,
      code_verifier: verifier,
      client_id: CLAUDE_AI_CLIENT,
    });
    await expectError(exchanged, "invalid_grant");
    expect(r.module.store.list()[0]).toMatchObject({ status: "revoked", reason: "client_removed" });
  });

  it("checks sevDesk before rotating: a client that drops during the check can retry", async () => {
    let slow = false;
    const real = fakeIdentity();
    const identity: IdentityLookup = (token, signal) =>
      slow
        ? new Promise((_resolve, reject) => {
            const fail = (): void => {
              reject(new IdentityError("unreachable", "aborted"));
            };
            if (signal.aborted) fail();
            signal.addEventListener("abort", fail);
          })
        : real.lookup(token, signal);
    const r = await rig({ identity });
    const tokens = await connectClaudeAi(r);
    slow = true;
    const client = new AbortController();
    const pending = r.route("/token").handle(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh }),
      }),
      testContext(r.log, { signal: client.signal }),
    );
    client.abort();
    const lost = await pending;
    expect(lost?.status).toBe(503);
    expect(r.module.store.list()[0]?.gen).toBe(1);

    slow = false;
    r.clock.advance(31_000);
    const retry = await refresh(r, tokens.refresh);
    expect(retry.status).toBe(200);
    expect(r.module.store.list()[0]).toMatchObject({ status: "active", gen: 2 });
  });

  it("answers 503 temporarily_unavailable while the grant store cannot be trusted", async () => {
    const failed = { on: false };
    const store = await openGrantStore({ stateDir: undefined });
    const r = await rig({ store: failingStore(store, failed) });
    const tokens = await connectClaudeAi(r);
    failed.on = true;
    await expectError(await refresh(r, tokens.refresh), "temporarily_unavailable", 503);
    await expectError(
      await postForm(r.fetch, "/revoke", { token: tokens.refresh }),
      "temporarily_unavailable",
      503,
    );
    failed.on = false;
    expect((await refresh(r, tokens.refresh)).status).toBe(200);
    await store.close();
  });
});
