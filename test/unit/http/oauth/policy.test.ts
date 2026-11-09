import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createServerKeys } from "../../../../src/http/keys.js";
import { openGrantStore } from "../../../../src/http/oauth/grant-store.js";
import {
  createOAuthModule,
  isAccountAllowed,
  isClientAllowed,
} from "../../../../src/http/oauth/index.js";
import { disallowedReason } from "../../../../src/http/oauth/policy.js";
import type { Tier } from "../../../../src/safety/tiers.js";
import {
  ACCOUNT,
  connectClaudeAi,
  createOAuthRig,
  createTestRouter,
  DEFAULT_OAUTH,
  mcpRequest,
  ORIGIN,
  postForm,
  testContext,
} from "../../../helpers/oauth-browser.js";

describe("allowlist checks", () => {
  it("allows listed accounts and client hosts, or any", () => {
    expect(isAccountAllowed({ accounts: ["4711"] }, "4711")).toBe(true);
    expect(isAccountAllowed({ accounts: ["4711"] }, "4712")).toBe(false);
    expect(isAccountAllowed({ accounts: "any" }, "4712")).toBe(true);
    expect(isClientAllowed({ clients: ["claude.ai"] }, "Claude.AI")).toBe(true);
    expect(isClientAllowed({ clients: ["claude.ai"] }, "evil.example")).toBe(false);
    expect(isClientAllowed({ clients: "any" }, "evil.example")).toBe(true);
    expect(
      disallowedReason(DEFAULT_OAUTH, { accountId: ACCOUNT, clientHost: "claude.ai" }),
    ).toBeUndefined();
    expect(disallowedReason(DEFAULT_OAUTH, { accountId: "1", clientHost: "x.example" })).toBe(
      "account_removed",
    );
    expect(disallowedReason(DEFAULT_OAUTH, { accountId: ACCOUNT, clientHost: "x.example" })).toBe(
      "client_removed",
    );
  });
});

describe("removing an account or client host and restarting", () => {
  it("revokes its grants and the account's inbox sessions at startup", async () => {
    const rig = await createOAuthRig();
    const kept = await connectClaudeAi(rig);
    const { access, refresh } = await connectClaudeAi(rig);
    const tokenSession = await rig.module.store.createSession({
      accountId: ACCOUNT,
      via: "token",
      ttlSeconds: 3600,
    });

    // Same keys and store, account 4711 no longer listed (p1 of the review).
    const restarted = await createOAuthModule({
      origin: ORIGIN,
      keys: rig.keys,
      oauth: { ...DEFAULT_OAUTH, accounts: ["99999"] },
      allowedTiers: new Set<Tier>(["read", "write", "commit"]),
      stateDir: undefined,
      identity: rig.identity.lookup,
      log: rig.log,
      now: rig.clock.now,
      store: rig.module.store,
    });
    expect(rig.module.store.list().map((grant) => grant.reason)).toEqual([
      "account_removed",
      "account_removed",
    ]);
    expect(rig.module.store.getSession(tokenSession.sid)).toBeUndefined();
    expect(rig.log.lines).toContainEqual({
      level: "warn",
      event: "account_removed",
      fields: { account: ACCOUNT, grants: 2 },
    });
    const auth = await restarted.authenticator.authenticate(
      mcpRequest(access),
      testContext(rig.log),
    );
    expect(auth).toBeInstanceOf(Response);
    expect((auth as Response).status).toBe(401);
    const refreshed = await postForm(
      createTestRouter(restarted.routes, { log: rig.log }),
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: refresh,
      },
    );
    expect(refreshed.status).toBe(400);
    expect(((await refreshed.json()) as { error: string }).error).toBe("invalid_grant");
    expect(kept.access).not.toBe(access);
    await restarted.close();
    await rig.close();
  });

  it("revokes the grants of a removed client host at startup", async () => {
    const rig = await createOAuthRig();
    await connectClaudeAi(rig);
    const restarted = await createOAuthModule({
      origin: ORIGIN,
      keys: rig.keys,
      oauth: { ...DEFAULT_OAUTH, clients: ["example.org"] },
      allowedTiers: new Set<Tier>(["read"]),
      stateDir: undefined,
      identity: rig.identity.lookup,
      log: rig.log,
      now: rig.clock.now,
      store: rig.module.store,
    });
    expect(rig.module.store.list()[0]).toMatchObject({
      status: "revoked",
      reason: "client_removed",
    });
    await restarted.close();
    await rig.close();
  });
});

describe("module startup", () => {
  it("closes the store it opened when the startup sweep fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdmcp-sweep-"));
    try {
      const store = await openGrantStore({ stateDir: dir, heartbeatMs: 0 });
      await store.createPending({
        accountId: "4711",
        clientId: "https://claude.ai/x",
        clientHost: "claude.ai",
        tiers: ["read"],
        ttlSeconds: 3600,
      });
      await store.close();
      const failingLog = {
        info: () => undefined,
        warn: () => {
          throw new Error("log sink down");
        },
      };
      await expect(
        createOAuthModule({
          origin: ORIGIN,
          keys: createServerKeys(randomBytes(32)),
          oauth: { ...DEFAULT_OAUTH, accounts: ["99999"] },
          allowedTiers: new Set<Tier>(["read"]),
          stateDir: dir,
          identity: () => Promise.reject(new Error("unused")),
          log: failingLog,
          onFatal: () => undefined,
        }),
      ).rejects.toThrow("log sink down");
      // The lock was released: the directory can be opened again right away.
      const again = await openGrantStore({ stateDir: dir, heartbeatMs: 0 });
      expect(again.list()[0]?.reason).toBe("account_removed");
      await again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
