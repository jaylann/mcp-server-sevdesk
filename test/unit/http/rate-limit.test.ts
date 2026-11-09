import { describe, expect, it } from "vitest";

import { createRateLimiter } from "../../../src/http/rate-limit.js";
import type { RateRule } from "../../../src/http/types.js";

function clock(start = 0) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const PER_MINUTE: RateRule = { name: "login", perMinute: 6 };

describe("createRateLimiter", () => {
  it("allows a burst, then refuses with a Retry-After until a token refills", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });
    for (let index = 0; index < 6; index += 1) {
      expect(limiter.take(PER_MINUTE, "1.2.3.4")).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(limiter.take(PER_MINUTE, "1.2.3.4")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    time.advance(9_000);
    expect(limiter.take(PER_MINUTE, "1.2.3.4")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    time.advance(1_000);
    expect(limiter.take(PER_MINUTE, "1.2.3.4").allowed).toBe(true);
    expect(limiter.take(PER_MINUTE, "1.2.3.4").allowed).toBe(false);
  });

  it("keeps keys and rule families apart", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const strict: RateRule = { name: "strict", perMinute: 1 };
    expect(limiter.take(strict, "a").allowed).toBe(true);
    expect(limiter.take(strict, "a").allowed).toBe(false);
    expect(limiter.take(strict, "b").allowed).toBe(true);
    expect(limiter.take({ name: "other", perMinute: 1 }, "a").allowed).toBe(true);
  });

  it("supports bursts smaller than the rate and slow hourly rules", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now });
    const hourly: RateRule = { name: "hourly", perMinute: 20 / 60, burst: 20 };
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.take(hourly, "ip").allowed).toBe(true);
    }
    const refused = limiter.take(hourly, "ip");
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 180 });
    // The bucket must not be dropped as idle while it is still refilling.
    time.advance(30 * 60_000);
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.take(hourly, "ip").allowed).toBe(true);
    }
    expect(limiter.take(hourly, "ip").allowed).toBe(false);
  });

  it("drops refilled buckets and bounds the number of keys", () => {
    const time = clock();
    const limiter = createRateLimiter({ now: time.now, maxKeys: 3 });
    const rule: RateRule = { name: "r", perMinute: 60, burst: 2 };
    for (const key of ["a", "b", "c", "d"]) limiter.take(rule, key);
    expect(limiter.size).toBe(3);
    // "a" was evicted as the least recently used: it starts full again.
    expect(limiter.take(rule, "a").allowed).toBe(true);
    time.advance(60_000);
    limiter.take(rule, "e");
    expect(limiter.size).toBe(1);
  });

  it("refuses invalid rules", () => {
    const limiter = createRateLimiter();
    expect(() => limiter.take({ name: "zero", perMinute: 0 }, "a")).toThrow(RangeError);
    expect(() => limiter.take({ name: "burst", perMinute: 5, burst: 0.5 }, "a")).toThrow(
      RangeError,
    );
  });
});
