import { randomBytes } from "node:crypto";

import fc from "fast-check";
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
  openBytes,
  redactSealed,
  seal,
  sealBytes,
  SEALED_TOKEN_PATTERN,
  sealedWithPrevious,
  unseal,
} from "../../../src/http/seal.js";

const ISSUER = "https://mcp.example.com";
const secretA = new Uint8Array(randomBytes(32));
const secretB = new Uint8Array(randomBytes(32));

describe("redactSealed properties", () => {
  it("removes generated tokens of every purpose at every position and on repeated calls", () => {
    const bodies = fc.array(fc.uint8Array({ minLength: 34, maxLength: 256 }), {
      minLength: 1,
      maxLength: 8,
    });
    fc.assert(
      fc.property(bodies, (values) => {
        for (const type of ["ac", "at", "rt", "ss", "cs"] as const) {
          const tokens = values.map(
            (bytes) => `sdmcp_${type}_${Buffer.from(bytes).toString("base64url")}`,
          );
          const text = tokens.join("\n") + ` code=${tokens[0] ?? ""}&state=ok`;
          const result = redactSealed(text);
          expect(tokens.every((token) => !result.includes(token))).toBe(true);
          expect(result).toBe(
            values.map(() => "[redacted token]").join("\n") + " code=[redacted token]&state=ok",
          );
          expect(redactSealed(text)).toBe(result);
          expect(redactSealed(result)).toBe(result);
        }
      }),
      { numRuns: 100, seed: 20261112 },
    );
  });
});

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

describe("sealBytes / openBytes", () => {
  const set = deriveKeySet(secretA);
  const context = "blob-1|1001|pdf";
  const plaintext = Buffer.from("%PDF-1.7 Rechnung 4711 IBAN DE02120300000000202051");

  it("round-trips bytes under the file key and hides them", () => {
    const sealed = sealBytes(set, context, plaintext);
    expect(sealed.length).toBe(1 + 12 + plaintext.length + 16);
    expect(sealed.includes(Buffer.from("Rechnung"))).toBe(false);
    expect(openBytes(set, context, sealed)).toEqual(plaintext);
    expect(openBytes(set, context, sealBytes(set, context, new Uint8Array(0)))).toEqual(
      Buffer.alloc(0),
    );
  });

  it("uses a fresh nonce and the file key, distinct from every token key", () => {
    expect(sealBytes(set, context, plaintext).equals(sealBytes(set, context, plaintext))).toBe(
      false,
    );
    const others = ["seal:ac", "seal:at", "seal:rt", "seal:ss", "seal:cs"] as const;
    for (const purpose of others) {
      expect(set.key("seal:fl").equals(set.key(purpose))).toBe(false);
    }
  });

  it("refuses another context, another key, a flipped byte and garbage", () => {
    const sealed = sealBytes(set, context, plaintext);
    expect(openBytes(set, "blob-2|1001|pdf", sealed)).toBeUndefined();
    expect(openBytes(set, "blob-1|2002|pdf", sealed)).toBeUndefined();
    expect(openBytes(set, "blob-1|1001|xml", sealed)).toBeUndefined();
    expect(openBytes(deriveKeySet(secretB), context, sealed)).toBeUndefined();
    for (let index = 0; index < sealed.length; index += 7) {
      const copy = Buffer.from(sealed);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expect(openBytes(set, context, copy)).toBeUndefined();
    }
    expect(openBytes(set, context, new Uint8Array(10))).toBeUndefined();
    expect(openBytes(set, context, sealed.subarray(0, sealed.length - 1))).toBeUndefined();
  });

  it("opens a view into a larger buffer", () => {
    const sealed = sealBytes(set, context, plaintext);
    const padded = new Uint8Array(sealed.length + 8);
    padded.set(sealed, 4);
    expect(openBytes(set, context, padded.subarray(4, 4 + sealed.length))).toEqual(plaintext);
  });
});
