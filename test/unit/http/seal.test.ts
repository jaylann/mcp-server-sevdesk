import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createServerKeys,
  decodeSecret,
  deriveKeySet,
  generateSecret,
  keyedTag,
  MIN_SECRET_BYTES,
} from "../../../src/http/keys.js";
import {
  MAX_SEALED_LENGTH,
  redactSealed,
  seal,
  SEALED_TOKEN_PATTERN,
  sealedWithPrevious,
  unseal,
} from "../../../src/http/seal.js";

const ISSUER = "https://mcp.example.com";
const secretA = new Uint8Array(randomBytes(32));
const secretB = new Uint8Array(randomBytes(32));

describe("decodeSecret", () => {
  it("accepts hex, base64 and base64url of at least 32 bytes", () => {
    const bytes = randomBytes(32);
    expect(decodeSecret(bytes.toString("hex"))).toEqual(new Uint8Array(bytes));
    expect(decodeSecret(bytes.toString("base64"))).toEqual(new Uint8Array(bytes));
    expect(decodeSecret(bytes.toString("base64url"))).toEqual(new Uint8Array(bytes));
    expect(decodeSecret(generateSecret())?.length).toBe(MIN_SECRET_BYTES);
  });

  it("refuses short, uniform and malformed secrets", () => {
    expect(decodeSecret(randomBytes(31).toString("base64url"))).toBeUndefined();
    expect(decodeSecret("a".repeat(64))).toBeUndefined();
    expect(decodeSecret(Buffer.alloc(40, 7).toString("base64"))).toBeUndefined();
    expect(decodeSecret("not a secret!")).toBeUndefined();
    expect(decodeSecret("")).toBeUndefined();
  });
});

describe("server keys", () => {
  it("derives distinct keys per purpose and a stable key id", () => {
    const set = deriveKeySet(secretA);
    expect(set.key("seal:at").equals(set.key("seal:rt"))).toBe(false);
    expect(set.kid).toHaveLength(4);
    expect(deriveKeySet(secretA).kid.equals(set.kid)).toBe(true);
    expect(deriveKeySet(secretB).kid.equals(set.kid)).toBe(false);
  });

  it("refuses a previous secret equal to the current one and short secrets", () => {
    expect(() => createServerKeys(secretA, secretA)).toThrow(/must differ/);
    expect(() => deriveKeySet(new Uint8Array(16))).toThrow(RangeError);
  });

  it("finds key sets by id", () => {
    const keys = createServerKeys(secretA, secretB);
    expect(keys.byKid(keys.current.kid)).toBe(keys.current);
    expect(keys.byKid(deriveKeySet(secretB).kid)).toBe(keys.previous);
    expect(keys.byKid(Buffer.from([1, 2, 3, 4]))).toBeUndefined();
  });

  it("tags data per purpose", () => {
    const set = deriveKeySet(secretA);
    expect(keyedTag(set, "csrf", "x")).toBe(keyedTag(set, "csrf", "x"));
    expect(keyedTag(set, "csrf", "x")).not.toBe(keyedTag(set, "cookie", "x"));
  });
});

describe("seal / unseal", () => {
  const keys = createServerKeys(secretA);
  const payload = { gid: "g1", tok: "0123456789abcdef0123456789abcdef", exp: 123 };

  it("round-trips a payload and hides it", () => {
    const token = seal(keys, "at", ISSUER, payload);
    expect(token).toMatch(/^sdmcp_at_[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("0123456789abcdef");
    expect(unseal(keys, "at", ISSUER, token)).toEqual(payload);
  });

  it("uses a fresh nonce for every token", () => {
    expect(seal(keys, "at", ISSUER, payload)).not.toBe(seal(keys, "at", ISSUER, payload));
  });

  it("refuses a flipped byte anywhere in the body", () => {
    const token = seal(keys, "at", ISSUER, payload);
    const prefixLength = "sdmcp_at_".length;
    const body = Buffer.from(token.slice(prefixLength), "base64url");
    for (let index = 0; index < body.length; index += 1) {
      const copy = Buffer.from(body);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expect(unseal(keys, "at", ISSUER, `sdmcp_at_${copy.toString("base64url")}`)).toBeUndefined();
    }
  });

  it("refuses another type, a swapped prefix and another issuer", () => {
    const token = seal(keys, "rt", ISSUER, payload);
    expect(unseal(keys, "at", ISSUER, token)).toBeUndefined();
    expect(unseal(keys, "at", ISSUER, token.replace("sdmcp_rt_", "sdmcp_at_"))).toBeUndefined();
    expect(unseal(keys, "rt", "https://other.example.com", token)).toBeUndefined();
  });

  it("refuses unknown keys, garbage and oversized input", () => {
    const other = createServerKeys(secretB);
    const token = seal(other, "at", ISSUER, payload);
    expect(unseal(keys, "at", ISSUER, token)).toBeUndefined();
    expect(unseal(keys, "at", ISSUER, "sdmcp_at_")).toBeUndefined();
    expect(unseal(keys, "at", ISSUER, "sdmcp_at_!!!")).toBeUndefined();
    expect(unseal(keys, "at", ISSUER, "Bearer x")).toBeUndefined();
    expect(unseal(keys, "at", ISSUER, `sdmcp_at_${"A".repeat(MAX_SEALED_LENGTH)}`)).toBeUndefined();
  });

  it("opens tokens of the previous key during a rotation, and not after it", () => {
    const old = createServerKeys(secretB);
    const token = seal(old, "rt", ISSUER, payload);
    const rotating = createServerKeys(secretA, secretB);
    expect(unseal(rotating, "rt", ISSUER, token)).toEqual(payload);
    expect(sealedWithPrevious(rotating, token)).toBe(true);
    expect(sealedWithPrevious(rotating, seal(rotating, "rt", ISSUER, payload))).toBe(false);
    expect(unseal(createServerKeys(secretA), "rt", ISSUER, token)).toBeUndefined();
  });

  it("finds and redacts sealed tokens in text", () => {
    const token = seal(keys, "ac", ISSUER, payload);
    const line = `code=${token}&state=x`;
    expect(line.match(SEALED_TOKEN_PATTERN)).toEqual([token]);
    expect(redactSealed(line)).toBe("code=[redacted token]&state=x");
  });
});
