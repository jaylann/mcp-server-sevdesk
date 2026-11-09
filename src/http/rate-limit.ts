/**
 * Token-bucket rate limits for the HTTP mode, kept in memory in a bounded LRU map: at most
 * {@link DEFAULT_MAX_KEYS} buckets, the least recently used dropped first, and buckets that have
 * refilled completely dropped as they age (a missing bucket behaves exactly like a full one).
 *
 * A bucket holds up to `burst` tokens (default `perMinute`) and refills continuously at
 * `perMinute` per minute; each request takes one. Bounded memory beats exactness: a flood of
 * distinct keys can push a partly drained bucket out, which only makes that key's limit lenient
 * once, never stricter.
 */
import type { RateRule } from "./types.js";

/** Most buckets kept at once. */
const DEFAULT_MAX_KEYS = 10_000;

const EPSILON = 1e-9;

/** How many of the oldest buckets each call inspects for removal (amortized cleanup). */
const SWEEP_PER_CALL = 8;

export interface RateLimiterOptions {
  /** Most buckets kept (default {@link DEFAULT_MAX_KEYS}). */
  readonly maxKeys?: number;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
}

/** Outcome of {@link RateLimiter.take}. */
interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds until a token is available again (0 when allowed); for `Retry-After`. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Takes one token from the bucket of `rule.name` + `key`. */
  take(rule: RateRule, key: string): RateDecision;
  /** Number of buckets currently kept. */
  readonly size: number;
}

interface Bucket {
  tokens: number;
  /** Last update, epoch ms. */
  at: number;
  /** When the bucket is full again, epoch ms. */
  fullAt: number;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  // Insertion order is recency order: every take re-inserts its bucket at the end.
  const buckets = new Map<string, Bucket>();

  const sweep = (time: number): void => {
    let inspected = 0;
    for (const [id, bucket] of buckets) {
      if (inspected++ >= SWEEP_PER_CALL) break;
      if (bucket.fullAt <= time) buckets.delete(id);
    }
  };

  return {
    take(rule, key) {
      const capacity = rule.burst ?? rule.perMinute;
      if (!(rule.perMinute > 0) || !(capacity >= 1)) {
        throw new RangeError(`Invalid rate rule ${rule.name}: perMinute > 0 and burst >= 1.`);
      }
      const perMs = rule.perMinute / 60_000;
      const time = now();
      sweep(time);
      const id = `${rule.name}\u0000${key}`;
      const previous = buckets.get(id);
      let tokens = capacity;
      if (previous !== undefined) {
        buckets.delete(id);
        tokens = Math.min(capacity, previous.tokens + Math.max(0, time - previous.at) * perMs);
      }
      // Tolerates float noise of fractional rates (20 per hour is 0.333… per minute).
      const allowed = tokens >= 1 - EPSILON;
      if (allowed) tokens = Math.max(0, tokens - 1);
      buckets.set(id, { tokens, at: time, fullAt: time + (capacity - tokens) / perMs });
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next();
        if (oldest.done !== true) buckets.delete(oldest.value);
      }
      return {
        allowed,
        // Rounded to whole ms first, so float noise does not add a second.
        retryAfterSeconds: allowed
          ? 0
          : Math.max(1, Math.ceil(Math.round((1 - tokens) / perMs) / 1000)),
      };
    },
    get size() {
      return buckets.size;
    },
  };
}
