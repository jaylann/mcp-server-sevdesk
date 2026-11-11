/**
 * In-process locks on sevDesk records, so two write calls that book against the same document or
 * bank transaction run one after the other instead of interleaving their read, check and write.
 *
 * Why: a payment's guard (at most the open amount, at most what the transaction holds) is checked
 * on what `prepare` read. Two approved calls sent at the same time both read the same open amount
 * and both passed, over-booking the document (security review 2026-11, finding 3). sevDesk itself
 * does not refuse an over-booking (see test/regressions/over-booking.test.ts).
 *
 * Scope: one server process (stdio, or one HTTP server; a deployment with several replicas would
 * need a shared lock). Keys are opaque strings the caller scopes to an account. Several keys are
 * taken in sorted order, so two calls that share more than one record cannot deadlock.
 */

/** Serializes work by record key. */
export interface RecordLocks {
  /** Runs `work` while holding every key in `keys` (none: runs it at once). */
  run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T>;
}

export function createRecordLocks(): RecordLocks {
  // The promise each key's next holder waits for; removed when the last holder is done.
  const tails = new Map<string, Promise<void>>();

  async function acquire(key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  }

  return {
    async run(keys, work) {
      const releases: (() => void)[] = [];
      try {
        for (const key of [...new Set(keys)].sort()) releases.push(await acquire(key));
        return await work();
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  };
}
