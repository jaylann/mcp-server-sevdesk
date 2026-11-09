import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServerKeys } from "../../../src/http/keys.js";
import { seal, unseal } from "../../../src/http/seal.js";
import {
  clearSessionCookie,
  createEphemeralKeys,
  createSessionCookie,
  type CreateSessionCookieInput,
  readSession,
  SESSION_TTL_SECONDS,
  sessionCookieName,
} from "../../../src/http/session.js";
import {
  createMemorySessionStore,
  fakeClock,
  type MemorySessionStore,
  ORIGIN,
} from "../../helpers/remote-approvals.js";

const LOOPBACK = "http://127.0.0.1:8080";
const secretA = new Uint8Array(randomBytes(32));
const secretB = new Uint8Array(randomBytes(32));

function setup(origin = ORIGIN) {
  const clock = fakeClock();
  const store = createMemorySessionStore(clock.now);
  const keys = createServerKeys(secretA);
  const input = (overrides: Partial<CreateSessionCookieInput> = {}): CreateSessionCookieInput => ({
    keys,
    store,
    accountId: "4711",
    via: "token",
    origin,
    ttlSeconds: SESSION_TTL_SECONDS,
    ...overrides,
  });
  const read = (
    cookie: string | undefined,
    overrides: { origin?: string; store?: MemorySessionStore } = {},
  ) =>
    readSession(
      new Request(`${overrides.origin ?? origin}/approvals`, {
        headers: cookie === undefined ? {} : { Cookie: cookie },
      }),
      { keys, store: overrides.store ?? store, origin: overrides.origin ?? origin, now: clock.now },
    );
  return { clock, store, keys, input, read };
}

/** `name=value` of a Set-Cookie value. */
function pair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

function valueOf(setCookie: string): string {
  const first = pair(setCookie);
  return first.slice(first.indexOf("=") + 1);
}

describe("session cookie", () => {
  it("is a __Host- cookie with Secure, HttpOnly, SameSite=Lax and a 12 h lifetime on https", async () => {
    const { input } = setup();
    const cookie = await createSessionCookie(input());

    expect(cookie).toMatch(
      /^__Host-sevdesk_session=sdmcp_ss_[A-Za-z0-9_-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(sessionCookieName(ORIGIN)).toBe("__Host-sevdesk_session");
  });

  it("drops the prefix and Secure on a plain-http loopback origin and names the port", async () => {
    const { input, read } = setup(LOOPBACK);
    const cookie = await createSessionCookie(input({ origin: LOOPBACK }));

    expect(cookie).toMatch(
      /^sevdesk_session_8080=sdmcp_ss_[A-Za-z0-9_-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/,
    );
    expect(read(pair(cookie))?.accountId).toBe("4711");
    expect(clearSessionCookie(LOOPBACK)).toBe(
      "sevdesk_session_8080=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    );
    expect(sessionCookieName("http://localhost")).toBe("sevdesk_session_80");
    expect(sessionCookieName("http://[::1]:3000")).toBe("sevdesk_session_3000");
  });

  it("keeps the sessions of two loopback servers on different ports apart", async () => {
    const other = "http://127.0.0.1:9090";
    const { input, read } = setup(LOOPBACK);
    const first = pair(await createSessionCookie(input({ origin: LOOPBACK, accountId: "1" })));
    const second = pair(await createSessionCookie(input({ origin: other, accountId: "2" })));

    // Browsers send the cookies of every port of the host; neither overwrites the other.
    const both = `${first}; ${second}`;
    expect(first.split("=")[0]).not.toBe(second.split("=")[0]);
    expect(read(both)?.accountId).toBe("1");
    expect(read(both, { origin: other })?.accountId).toBe("2");
    // A cookie of the other port under this port's name is still refused (sealed per origin).
    expect(read(`sevdesk_session_8080=${second.split("=")[1] ?? ""}`)).toBeUndefined();
  });

  it("seals {v, sid, acct, gid, iat, exp} for the origin and nothing else", async () => {
    const { input, keys, store, clock } = setup();
    const cookie = await createSessionCookie(input({ gid: "grant-1", via: "consent" }));

    const payload = unseal(keys, "ss", ORIGIN, valueOf(cookie)) as Record<string, unknown>;
    const [record] = [...store.records.values()];
    const at = Math.floor(clock.now() / 1000);
    expect(payload).toEqual({
      v: 1,
      sid: record?.sid,
      acct: "4711",
      gid: "grant-1",
      iat: at,
      exp: at + SESSION_TTL_SECONDS,
    });
    expect(record).toMatchObject({ accountId: "4711", gid: "grant-1", via: "consent" });
    // No grant: no gid field at all.
    const plain = await createSessionCookie(input());
    expect(Object.keys(unseal(keys, "ss", ORIGIN, valueOf(plain)) as object)).toEqual([
      "v",
      "sid",
      "acct",
      "iat",
      "exp",
    ]);
    // Sealed for this issuer only.
    expect(unseal(keys, "ss", "https://other.example.com", valueOf(cookie))).toBeUndefined();
  });

  it("creates a new session id on every call", async () => {
    const { input, read } = setup();
    const first = read(pair(await createSessionCookie(input())));
    const second = read(pair(await createSessionCookie(input())));

    expect(first?.sid).toBeDefined();
    expect(second?.sid).toBeDefined();
    expect(first?.sid).not.toBe(second?.sid);
  });

  it("refuses a lifetime that is not a positive number of seconds", async () => {
    const { input } = setup();
    await expect(createSessionCookie(input({ ttlSeconds: 0 }))).rejects.toThrow(RangeError);
    await expect(createSessionCookie(input({ ttlSeconds: 1.5 }))).rejects.toThrow(RangeError);
  });

  it("clears the cookie with the same name and attributes", () => {
    expect(clearSessionCookie(ORIGIN)).toBe(
      "__Host-sevdesk_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
  });
});

describe("readSession", () => {
  it("returns the store's record for a valid cookie", async () => {
    const { input, read, store } = setup();
    const cookie = await createSessionCookie(input({ gid: "g1", via: "consent" }));

    const session = read(`other=1; ${pair(cookie)}; more=2`);

    expect(session).toEqual([...store.records.values()][0]);
  });

  it("returns nothing without the cookie, with the other name, or an empty value", async () => {
    const { input, read } = setup();
    const cookie = await createSessionCookie(input());

    expect(read(undefined)).toBeUndefined();
    expect(read("unrelated=1")).toBeUndefined();
    expect(read("__Host-sevdesk_session=")).toBeUndefined();
    // The plain-http name is not read on an https origin.
    expect(read(`sevdesk_session_443=${valueOf(cookie)}`)).toBeUndefined();
    expect(read(`sevdesk_session=${valueOf(cookie)}`)).toBeUndefined();
  });

  it("refuses a tampered, foreign-key, foreign-issuer or wrong-type cookie", async () => {
    const { input, read, keys, store } = setup();
    const value = valueOf(await createSessionCookie(input()));
    const name = "__Host-sevdesk_session";
    const record = [...store.records.values()][0];
    const payload = {
      v: 1,
      sid: record?.sid,
      acct: "4711",
      iat: record?.createdAt,
      exp: record?.expiresAt,
    };

    const flipped = `${value.slice(0, -3)}${value.at(-3) === "A" ? "B" : "A"}${value.slice(-2)}`;
    expect(read(`${name}=${flipped}`)).toBeUndefined();
    expect(read(`${name}=${value}x`)).toBeUndefined();
    expect(
      read(`${name}=${seal(createServerKeys(secretB), "ss", ORIGIN, payload)}`),
    ).toBeUndefined();
    expect(read(`${name}=${seal(keys, "ss", "https://evil.example", payload)}`)).toBeUndefined();
    const consentState = seal(keys, "cs", ORIGIN, payload);
    expect(read(`${name}=${consentState}`)).toBeUndefined();
    expect(read(`${name}=${consentState.replace("sdmcp_cs_", "sdmcp_ss_")}`)).toBeUndefined();
    // The genuine payload, resealed, still works: the refusals above are not about its content.
    expect(read(`${name}=${seal(keys, "ss", ORIGIN, payload)}`)?.sid).toBe(record?.sid);
  });

  it("refuses payloads of the wrong shape", () => {
    const { read, keys } = setup();
    const name = "__Host-sevdesk_session";
    const at = Math.floor(Date.UTC(2026, 10, 9, 12) / 1000);
    const base = { v: 1, sid: "s".repeat(22), acct: "4711", iat: at, exp: at + 60 };
    for (const payload of [
      { ...base, v: 2 },
      { ...base, extra: true },
      { ...base, sid: "bad sid" },
      { ...base, acct: "" },
      { ...base, exp: "soon" },
      { ...base, gid: null },
      "a string",
      null,
    ]) {
      expect(read(`${name}=${seal(keys, "ss", ORIGIN, payload)}`)).toBeUndefined();
    }
  });

  it("ends at expiry, by the cookie's and by the store's clock", async () => {
    const { input, read, clock } = setup();
    const cookie = pair(await createSessionCookie(input({ ttlSeconds: 120 })));

    clock.advance(119_000);
    expect(read(cookie)).toBeDefined();
    clock.advance(1_000);
    expect(read(cookie)).toBeUndefined();
  });

  it("refuses an expired cookie even if the store still has the session", async () => {
    const { read, keys, store, clock } = setup();
    const record = await store.createSession({ accountId: "4711", via: "token", ttlSeconds: 3600 });
    const at = Math.floor(clock.now() / 1000);
    const name = "__Host-sevdesk_session";
    const expired = seal(keys, "ss", ORIGIN, {
      v: 1,
      sid: record.sid,
      acct: "4711",
      iat: at - 100,
      exp: at,
    });
    const future = seal(keys, "ss", ORIGIN, {
      v: 1,
      sid: record.sid,
      acct: "4711",
      iat: at + 3600,
      exp: at + 7200,
    });
    const inverted = seal(keys, "ss", ORIGIN, {
      v: 1,
      sid: record.sid,
      acct: "4711",
      iat: at,
      exp: at,
    });

    expect(read(`${name}=${expired}`)).toBeUndefined();
    expect(read(`${name}=${future}`)).toBeUndefined();
    expect(read(`${name}=${inverted}`)).toBeUndefined();
  });

  it("refuses a cookie whose session is gone, revoked with its grant, or names other ids", async () => {
    const { input, read, store, keys } = setup();
    const loggedOut = pair(await createSessionCookie(input()));
    const consented = pair(await createSessionCookie(input({ gid: "grant-9", via: "consent" })));
    const kept = pair(await createSessionCookie(input()));
    const keptRecord = read(kept);

    await store.revokeSession(read(loggedOut)?.sid ?? "");
    store.revokeGrant("grant-9");

    expect(read(loggedOut)).toBeUndefined();
    expect(read(consented)).toBeUndefined();
    expect(read(kept)).toBeDefined();
    // A cookie naming the right sid but another account or grant is refused.
    const name = "__Host-sevdesk_session";
    const base = {
      v: 1,
      sid: keptRecord?.sid,
      iat: keptRecord?.createdAt,
      exp: keptRecord?.expiresAt,
    };
    expect(read(`${name}=${seal(keys, "ss", ORIGIN, { ...base, acct: "999" })}`)).toBeUndefined();
    expect(
      read(`${name}=${seal(keys, "ss", ORIGIN, { ...base, acct: "4711", gid: "g" })}`),
    ).toBeUndefined();
    // Another store (a restart without persistence) does not know it.
    expect(read(kept, { store: createMemorySessionStore(() => Date.now()) })).toBeUndefined();
  });

  it("still reads cookies sealed with the previous secret during a rotation", async () => {
    const { input, store, clock } = setup();
    const old = createServerKeys(secretA);
    const cookie = pair(await createSessionCookie(input({ keys: old })));
    const rotated = createServerKeys(secretB, secretA);
    const request = new Request(`${ORIGIN}/approvals`, { headers: { Cookie: cookie } });

    expect(
      readSession(request, { keys: rotated, store, origin: ORIGIN, now: clock.now }),
    ).toBeDefined();
    expect(
      readSession(request, {
        keys: createServerKeys(secretB),
        store,
        origin: ORIGIN,
        now: clock.now,
      }),
    ).toBeUndefined();
  });

  it("uses Date.now when no clock is given", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const keys = createServerKeys(secretA);
    const cookie = await createSessionCookie({
      keys,
      store,
      accountId: "1",
      via: "token",
      origin: ORIGIN,
      ttlSeconds: 60,
    });
    const request = new Request(`${ORIGIN}/approvals`, { headers: { Cookie: pair(cookie) } });
    expect(readSession(request, { keys, store, origin: ORIGIN })?.accountId).toBe("1");
  });
});

describe("createEphemeralKeys", () => {
  it("creates distinct random key sets per call", async () => {
    const first = createEphemeralKeys();
    const second = createEphemeralKeys();
    expect(first.current.kid.equals(second.current.kid)).toBe(false);
    expect(first.previous).toBeUndefined();

    const store = createMemorySessionStore(() => Date.now());
    const cookie = pair(
      await createSessionCookie({
        keys: first,
        store,
        accountId: "1",
        via: "token",
        origin: ORIGIN,
        ttlSeconds: 60,
      }),
    );
    const request = new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } });
    expect(readSession(request, { keys: first, store, origin: ORIGIN })).toBeDefined();
    // A restart (new keys) ends every session.
    expect(readSession(request, { keys: second, store, origin: ORIGIN })).toBeUndefined();
  });
});
