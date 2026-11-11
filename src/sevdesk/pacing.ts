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

/** A caller waiting for its token; `wake` is set while it waits behind another one. */
interface TokenWaiter {
  wake?: () => void;
}

/**
 * Creates a pacer: a FIFO semaphore of `maxConcurrency` slots plus a token bucket in its virtual
 * scheduling form (GCRA). Callers take their tokens one at a time in arrival order, and the
 * schedule moves on only when a token is granted, so concurrent callers never share a token and
 * the long-run rate never exceeds `requestsPerSecond`.
 *
 * No start time is reserved ahead: a caller that is aborted while it waits takes no token. With
 * reservations made on arrival, a burst of cancelled calls pushed the account's next real request
 * back by one interval each (40 cancelled calls: 10 s at 4 requests per second; review 2026-11,
 * round 3).
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
  /** Callers that hold a slot and wait for a token, in arrival order; only the first is timed. */
  const tokenQueue: TokenWaiter[] = [];

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

  /** Resolves once `waiter` is first in the token queue; rejects when `signal` aborts before. */
  function untilFirst(waiter: TokenWaiter, signal: AbortSignal | undefined): Promise<void> {
    if (tokenQueue[0] === waiter) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        delete waiter.wake;
        reject(abortReason(signal));
      };
      waiter.wake = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Takes `waiter` out of the token queue and lets the caller behind it go on. */
  function leaveTokenQueue(waiter: TokenWaiter): void {
    const index = tokenQueue.indexOf(waiter);
    if (index === -1) return;
    tokenQueue.splice(index, 1);
    if (index === 0) tokenQueue[0]?.wake?.();
  }

  async function takeToken(signal: AbortSignal | undefined): Promise<void> {
    const waiter: TokenWaiter = {};
    tokenQueue.push(waiter);
    try {
      await untilFirst(waiter, signal);
      const current = now();
      const start = Math.max(current, nextStart - tolerance);
      const wait = start - current;
      if (wait > 0) await sleep(wait, signal);
      // Only a granted token moves the schedule: a caller that gave up while waiting (above, or
      // in the queue) leaves nothing behind, and the caller behind it gets its start time.
      nextStart = Math.max(nextStart, current) + interval;
    } finally {
      leaveTokenQueue(waiter);
    }
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
