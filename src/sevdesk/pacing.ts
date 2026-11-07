/**
 * Client-side request pacing. sevDesk documents no rate limit but throttles bursts, so the client
 * spaces requests with a token bucket and caps how many are in flight at once.
 */

/** Waits `ms` milliseconds; rejects early when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface PacerOptions {
  /** Sustained rate (tokens added per second). Must be > 0. */
  readonly requestsPerSecond: number;
  /** Bucket size: how many requests may start back to back after an idle period. Default 1. */
  readonly burst?: number;
  /** Maximum requests in flight at once. Default 4. */
  readonly maxConcurrency?: number;
  /**
   * Monotonic clock in milliseconds (e.g. `performance.now()`). A wall clock would stall every
   * request for as long as the clock jumps backwards.
   */
  readonly now: () => number;
  readonly sleep: Sleep;
}

/** Releases a concurrency slot. Idempotent. */
type Release = () => void;

export interface Pacer {
  /**
   * Waits for a concurrency slot and then for a rate token. Resolves with a `release` function
   * that must be called once the request (including reading its body) is done. Rejects with the
   * abort reason when `signal` aborts while waiting; no slot is held in that case.
   */
  acquire(signal?: AbortSignal): Promise<Release>;
}

const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Creates a pacer: a FIFO semaphore of `maxConcurrency` slots plus a token bucket in its virtual
 * scheduling form (GCRA). Each acquirer reserves the next start time synchronously, so concurrent
 * callers never share a token and the long-run rate never exceeds `requestsPerSecond`. A
 * reservation abandoned by an abort is not refunded; that only ever makes pacing slower.
 */
export function createPacer(options: PacerOptions): Pacer {
  const { now, sleep } = options;
  if (!(options.requestsPerSecond > 0)) throw new RangeError("requestsPerSecond must be > 0.");
  const interval = 1000 / options.requestsPerSecond;
  const burst = Math.max(1, Math.floor(options.burst ?? 1));
  const tolerance = (burst - 1) * interval;
  const maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));

  /** Theoretical arrival time of the next request (GCRA). */
  let nextStart = Number.NEGATIVE_INFINITY;
  let inFlight = 0;
  const waiters: (() => void)[] = [];

  function releaseSlot(): void {
    const next = waiters.shift();
    if (next === undefined) inFlight -= 1;
    else next();
  }

  function takeSlot(signal: AbortSignal | undefined): Promise<void> {
    if (inFlight < maxConcurrency) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = waiters.indexOf(grant);
        if (index !== -1) waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      // A released slot is handed over directly: `inFlight` stays the same.
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function takeToken(signal: AbortSignal | undefined): Promise<void> {
    const current = now();
    const start = Math.max(current, nextStart - tolerance);
    nextStart = Math.max(nextStart, current) + interval;
    const wait = start - current;
    if (wait > 0) await sleep(wait, signal);
  }

  return {
    async acquire(signal) {
      throwIfAborted(signal);
      await takeSlot(signal);
      let released = false;
      const release: Release = () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
      try {
        await takeToken(signal);
      } catch (error) {
        release();
        throw error;
      }
      return release;
    },
  };
}

/** Abort-aware `setTimeout` promise; rejects with the signal's reason when aborted. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** The signal's abort reason as an `Error` (an `AbortError` when the reason is not an Error). */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
