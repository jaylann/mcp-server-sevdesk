import { describe, expect, it } from "vitest";

import { createNonceStore } from "../../../src/safety/nonces.js";

describe("nonce store", () => {
  it("issues distinct 128-bit base64url nonces", () => {
    const store = createNonceStore({ ttlMs: 1_000 });
    const nonces = new Set(Array.from({ length: 50 }, () => store.issue()));

    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("consumes an issued nonce exactly once", () => {
    const store = createNonceStore({ ttlMs: 1_000 });
    const nonce = store.issue();

    expect(store.consume(nonce)).toBe(true);
    expect(store.consume(nonce)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("refuses nonces it never issued", () => {
    const store = createNonceStore({ ttlMs: 1_000 });
    store.issue();

    expect(store.consume("never-issued")).toBe(false);
    expect(store.size).toBe(1);
  });

  it("refuses expired nonces and forgets them", () => {
    let now = 0;
    const store = createNonceStore({ ttlMs: 1_000, now: () => now });
    const early = store.issue();
    now = 500;
    const late = store.issue();

    now = 1_000;
    expect(store.consume(early)).toBe(false);
    expect(store.size).toBe(1);
    expect(store.consume(late)).toBe(true);
  });

  it("forgets the oldest nonces beyond maxEntries (they fail closed)", () => {
    const store = createNonceStore({ ttlMs: 1_000, maxEntries: 2 });
    const first = store.issue();
    const second = store.issue();
    const third = store.issue();

    expect(store.size).toBe(2);
    expect(store.consume(first)).toBe(false);
    expect(store.consume(second)).toBe(true);
    expect(store.consume(third)).toBe(true);
  });
});
