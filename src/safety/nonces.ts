/**
 * Single-use nonces for elicitation confirmations. A nonce is issued when the server asks the
 * human and travels inside the signed `requestState`; the approved retry consumes it. A second
 * retry with the same state (a replayed approval) finds it gone and is refused, even though its
 * signature is still valid.
 */
import { randomBytes } from "node:crypto";

export interface NonceStore {
  /** Creates, remembers and returns a fresh random nonce (128 bit, base64url). */
  issue(): string;
  /**
   * Removes `nonce` and returns true when it was issued here, not consumed yet and not expired;
   * false otherwise. Each issued nonce can be consumed at most once.
   */
  consume(nonce: string): boolean;
  /** Nonces currently remembered (issued, unexpired, unconsumed). */
  readonly size: number;
}

export interface NonceStoreOptions {
  /** How long an issued nonce stays consumable. */
  readonly ttlMs: number;
  /**
   * Upper bound on remembered nonces; issuing beyond it forgets the oldest, whose confirmation
   * then fails closed (it is refused as if replayed).
   */
  readonly maxEntries?: number;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const NONCE_BYTES = 16;

export function createNonceStore(options: NonceStoreOptions): NonceStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Insertion order is issue order, so the first entries are the oldest.
  const expiries = new Map<string, number>();

  function prune(at: number): void {
    for (const [nonce, expiresAt] of expiries) {
      if (expiresAt > at) break;
      expiries.delete(nonce);
    }
  }

  return {
    issue() {
      const at = now();
      prune(at);
      const nonce = randomBytes(NONCE_BYTES).toString("base64url");
      expiries.set(nonce, at + options.ttlMs);
      while (expiries.size > maxEntries) {
        const oldest = expiries.keys().next().value;
        if (oldest === undefined) break;
        expiries.delete(oldest);
      }
      return nonce;
    },
    consume(nonce) {
      const at = now();
      prune(at);
      const expiresAt = expiries.get(nonce);
      if (expiresAt === undefined) return false;
      expiries.delete(nonce);
      return expiresAt > at;
    },
    get size() {
      prune(now());
      return expiries.size;
    },
  };
}
