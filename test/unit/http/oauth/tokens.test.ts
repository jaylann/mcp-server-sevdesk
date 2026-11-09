import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServerKeys } from "../../../../src/http/keys.js";
import {
  grantOfToken,
  intersectTiers,
  openAccess,
  openCode,
  openConsent,
  openRefresh,
  scopeOf,
  sealAccess,
  sealCode,
  sealConsent,
  sealRefresh,
  tiersOfScope,
  toSeconds,
} from "../../../../src/http/oauth/tokens.js";
import { seal } from "../../../../src/http/seal.js";
import { ORIGIN, RESOURCE, SEVDESK_TOKEN } from "../../../helpers/oauth-browser.js";

const keys = createServerKeys(randomBytes(32));
const scope = { keys, issuer: ORIGIN };
const now = toSeconds(Date.now());
const gid = "g".repeat(22);

const access = {
  gid,
  cid: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  acct: "4711",
  tiers: ["read" as const],
  res: RESOURCE,
  tok: SEVDESK_TOKEN,
  iat: now,
  exp: now + 3600,
};

/** `token` with one character of its body changed. */
function flip(token: string, at = -10): string {
  const index = token.length + at;
  const char = token[index] === "A" ? "B" : "A";
  return token.slice(0, index) + char + token.slice(index + 1);
}

describe("sealed OAuth tokens", () => {
  it("round-trip every type", () => {
    expect(openAccess(scope, sealAccess(scope, access), now)).toEqual(access);
    const refresh = {
      gid,
      cid: access.cid,
      gen: 3,
      res: RESOURCE,
      tok: SEVDESK_TOKEN,
      iat: now,
      exp: now + 60,
    };
    expect(openRefresh(scope, sealRefresh(scope, refresh), now)).toEqual(refresh);
    const code = {
      jti: "j".repeat(22),
      gid,
      cid: access.cid,
      ruri: "https://claude.ai/api/mcp/auth_callback",
      cc: "c".repeat(43),
      res: RESOURCE,
      acct: "4711",
      tiers: ["read" as const, "write" as const],
      tok: SEVDESK_TOKEN,
      iat: now,
      exp: now + 60,
    };
    expect(openCode(scope, sealCode(scope, code), now)).toEqual(code);
    const consent = {
      cid: access.cid,
      ruri: code.ruri,
      st: "xyz",
      cc: code.cc,
      res: RESOURCE,
      offer: ["read" as const],
      csrf: "tag",
      iat: now,
      exp: now + 600,
    };
    expect(openConsent(scope, sealConsent(scope, consent), now)).toEqual(consent);
  });

  it("refuses a flipped byte, the wrong type, an unknown key and another issuer", () => {
    const token = sealAccess(scope, access);
    expect(openAccess(scope, flip(token), now)).toBeUndefined();
    expect(openAccess(scope, flip(token, -40), now)).toBeUndefined();
    // An access token presented as a refresh token (and vice versa) does not open.
    expect(openRefresh(scope, token, now)).toBeUndefined();
    expect(openRefresh(scope, token.replace("sdmcp_at_", "sdmcp_rt_"), now)).toBeUndefined();
    const other = { keys: createServerKeys(randomBytes(32)), issuer: ORIGIN };
    expect(openAccess(other, token, now)).toBeUndefined();
    expect(openAccess({ keys, issuer: "https://evil.example" }, token, now)).toBeUndefined();
    expect(openAccess(scope, "", now)).toBeUndefined();
  });

  it("refuses expired tokens, tokens from the future and unexpected payloads", () => {
    const token = sealAccess(scope, access);
    expect(openAccess(scope, token, now + 3600)).toBeUndefined();
    expect(openAccess(scope, token, now + 3599)).toBeDefined();
    const future = sealAccess(scope, { ...access, iat: now + 600, exp: now + 4000 });
    expect(openAccess(scope, future, now)).toBeUndefined();
    // A payload with extra fields (strict schema) or a malformed sevDesk token is refused.
    expect(
      openAccess(scope, seal(keys, "at", ORIGIN, { ...access, admin: true }), now),
    ).toBeUndefined();
    expect(
      openAccess(scope, seal(keys, "at", ORIGIN, { ...access, tok: "x" }), now),
    ).toBeUndefined();
    expect(() => sealAccess(scope, { ...access, tiers: [] })).toThrow();
  });

  it("opens with the previous key during a rotation", () => {
    const previousSecret = randomBytes(32);
    const old = { keys: createServerKeys(previousSecret), issuer: ORIGIN };
    const token = sealAccess(old, access);
    const rotated = { keys: createServerKeys(randomBytes(32), previousSecret), issuer: ORIGIN };
    expect(openAccess(rotated, token, now)).toEqual(access);
  });

  it("finds the grant of a refresh or access token regardless of expiry", () => {
    const refresh = sealRefresh(scope, {
      gid,
      cid: access.cid,
      gen: 1,
      res: RESOURCE,
      tok: SEVDESK_TOKEN,
      iat: now - 100,
      exp: now - 1,
    });
    expect(grantOfToken(scope, refresh, "refresh_token")).toEqual({ gid, cid: access.cid });
    expect(grantOfToken(scope, refresh, "access_token")).toEqual({ gid, cid: access.cid });
    expect(grantOfToken(scope, sealAccess(scope, access), "refresh_token")?.gid).toBe(gid);
    expect(grantOfToken(scope, "sdmcp_rt_nonsense", "refresh_token")).toBeUndefined();
  });
});

describe("scopes", () => {
  it("maps tiers to scopes and back", () => {
    expect(scopeOf(["write", "read"])).toBe("sevdesk:read sevdesk:write");
    expect(tiersOfScope("sevdesk:read offline_access sevdesk:commit other:x")).toEqual(
      new Set(["read", "commit"]),
    );
    expect(tiersOfScope("offline_access")).toBeUndefined();
    expect(tiersOfScope(null)).toBeUndefined();
    expect(tiersOfScope("sevdesk:admin")).toBeUndefined();
    expect(intersectTiers(["external", "read", "write"], new Set(["read", "external"]))).toEqual([
      "read",
      "external",
    ]);
  });
});
