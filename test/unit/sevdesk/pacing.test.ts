import { describe, expect, it } from "vitest";

import { abortReason, createPacer, realSleep } from "../../../src/sevdesk/pacing.js";
import { createFakeClock, FAKE_EPOCH } from "../../helpers/fake-fetch.js";

async function settled(promise: Promise<unknown>): Promise<"resolved" | "pending" | "rejected"> {
  let state: "resolved" | "pending" | "rejected" = "pending";
  promise.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  // Let queued microtasks run.
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  return state;
}

describe("token bucket", () => {
  it("spaces acquisitions at the configured rate", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 4, ...clock });

    for (let index = 0; index < 4; index += 1) (await pacer.acquire())();

    expect(clock.sleeps).toEqual([250, 250, 250]);
    expect(clock.now() - FAKE_EPOCH).toBe(750);
  });

  it("does not wait after an idle period", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 4, ...clock });
    (await pacer.acquire())();
    await clock.sleep(10_000);
    (await pacer.acquire())();
    expect(clock.sleeps).toEqual([10_000]);
  });

  it("allows a configured burst", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 2, burst: 3, ...clock });

    for (let index = 0; index < 4; index += 1) (await pacer.acquire())();

    expect(clock.sleeps).toEqual([500]);
  });

  it("gives concurrent callers distinct start times", async () => {
    const sleeps: number[] = [];
    const pacer = createPacer({
      requestsPerSecond: 10,
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    await Promise.all([pacer.acquire(), pacer.acquire(), pacer.acquire()]);

    expect(sleeps).toEqual([100, 200]);
  });

  it("rejects a non-positive rate", () => {
    const clock = createFakeClock();
    expect(() => createPacer({ requestsPerSecond: 0, ...clock })).toThrow(RangeError);
    expect(() => createPacer({ requestsPerSecond: Number.NaN, ...clock })).toThrow(RangeError);
  });

  it("releases the slot when aborted while waiting for a token", async () => {
    const controller = new AbortController();
    let now = 0;
    const pacer = createPacer({
      requestsPerSecond: 1,
      maxConcurrency: 1,
      now: () => now,
      // The caller is cancelled while it waits for its token.
      sleep: (_ms, signal) => {
        controller.abort();
        return signal?.aborted === true ? Promise.reject(abortReason(signal)) : Promise.resolve();
      },
    });
    (await pacer.acquire())();

    await expect(pacer.acquire(controller.signal)).rejects.toThrow();

    now = 10_000;
    const next = pacer.acquire();
    expect(await settled(next)).toBe("resolved");
  });
});

describe("cancelled callers leave no reservation (review 2026-11, round 3)", () => {
  /** A clock whose sleeps end only when the test advances it, or reject when aborted. */
  function manualClock() {
    let time = 0;
    const timers: { at: number; resolve: () => void }[] = [];
    const sleeps: number[] = [];
    const flush = async (): Promise<void> => {
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    };
    return {
      now: () => time,
      sleeps,
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(abortReason(signal));
            return;
          }
          sleeps.push(ms);
          const timer = { at: time + ms, resolve };
          timers.push(timer);
          signal?.addEventListener(
            "abort",
            () => {
              timers.splice(timers.indexOf(timer), 1);
              reject(abortReason(signal));
            },
            { once: true },
          );
        }),
      flush,
      /** Moves the time on by `ms`, ending the sleeps that fall due on the way, in order. */
      async advance(ms: number): Promise<void> {
        const end = time + ms;
        for (;;) {
          await flush();
          const [next] = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
          if (next === undefined) break;
          timers.splice(timers.indexOf(next), 1);
          time = next.at;
          next.resolve();
        }
        time = end;
        await flush();
      },
    };
  }

  it("starts the next request without the delay of 40 cancelled ones", async () => {
    const clock = manualClock();
    const pacer = createPacer({ requestsPerSecond: 4, now: clock.now, sleep: clock.sleep });
    (await pacer.acquire())();

    for (let index = 0; index < 40; index += 1) {
      const controller = new AbortController();
      const cancelled = pacer.acquire(controller.signal);
      expect(await settled(cancelled)).toBe("pending");
      controller.abort();
      await expect(cancelled).rejects.toThrow();
    }

    // The 40 calls were given up while they waited: none took a token. With a start time
    // reserved for each, this request waited 10,250 ms.
    const next = pacer.acquire();
    await clock.flush();
    expect(clock.sleeps.at(-1)).toBe(250);
    expect(await settled(next)).toBe("pending");
    await clock.advance(250);
    expect(await settled(next)).toBe("resolved");
    expect(clock.now()).toBe(250);
  });

  it("gives a cancelled caller's start time to the one behind it, in arrival order", async () => {
    const clock = manualClock();
    const pacer = createPacer({ requestsPerSecond: 4, now: clock.now, sleep: clock.sleep });
    const granted: string[] = [];
    const acquire = (name: string, signal?: AbortSignal): Promise<void> =>
      pacer.acquire(signal).then(() => {
        granted.push(`${name}@${String(clock.now())}`);
      });
    const second = new AbortController();
    const fourth = new AbortController();

    const all = [
      acquire("first"),
      acquire("second", second.signal),
      acquire("third"),
      acquire("fourth", fourth.signal),
    ];
    // `fifth` waits for a concurrency slot (4 by default), behind the four that wait for tokens.
    all.push(acquire("fifth"));
    await clock.flush();
    expect(granted).toEqual(["first@0"]);

    // `second` is being timed, `fourth` waits behind `third`: both give up.
    second.abort();
    fourth.abort();
    await expect(all[1]).rejects.toThrow();
    await expect(all[3]).rejects.toThrow();

    await clock.advance(250);
    expect(granted).toEqual(["first@0", "third@250"]);
    await clock.advance(250);
    expect(granted).toEqual(["first@0", "third@250", "fifth@500"]);
    await Promise.all([all[0], all[2], all[4]]);
  });

  it("keeps the rate with cancelled callers in between: granted requests stay an interval apart", async () => {
    const clock = manualClock();
    const pacer = createPacer({
      requestsPerSecond: 10,
      maxConcurrency: 2,
      now: clock.now,
      sleep: clock.sleep,
    });
    const starts: number[] = [];
    const pending: Promise<void>[] = [];
    const controllers: AbortController[] = [];
    for (let index = 0; index < 12; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const acquired = pacer.acquire(controller.signal).then((release) => {
        starts.push(clock.now());
        release();
      });
      // Every third caller will give up.
      pending.push(index % 3 === 1 ? acquired.catch(() => undefined) : acquired);
    }
    // Two give up at once, two after 150 ms (while they still wait).
    await clock.flush();
    controllers[1]?.abort();
    controllers[7]?.abort();
    await clock.advance(150);
    controllers[4]?.abort();
    controllers[10]?.abort();
    await clock.advance(5_000);
    await Promise.all(pending);

    expect(starts).toHaveLength(8);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(100);
    }
    // No gaps either: eight requests at 10 per second take 700 ms, not the 1,100 ms of twelve.
    expect(starts.at(-1)).toBe(700);
  });
});

describe("concurrency limit", () => {
  it("holds callers beyond the limit until a slot is released", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 1000, maxConcurrency: 2, ...clock });

    const first = await pacer.acquire();
    await pacer.acquire();
    const third = pacer.acquire();
    expect(await settled(third)).toBe("pending");

    first();
    first(); // Idempotent: a second call must not free another slot.
    expect(await settled(third)).toBe("resolved");

    const fourth = pacer.acquire();
    expect(await settled(fourth)).toBe("pending");
  });

  it("defaults to four requests in flight", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 1000, ...clock });
    for (let index = 0; index < 4; index += 1) await pacer.acquire();
    expect(await settled(pacer.acquire())).toBe("pending");
  });

  it("removes an aborted waiter from the queue", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 1000, maxConcurrency: 1, ...clock });
    const controller = new AbortController();

    const held = await pacer.acquire();
    const aborted = pacer.acquire(controller.signal);
    const waiting = pacer.acquire();
    controller.abort();

    await expect(aborted).rejects.toThrow();
    expect(await settled(waiting)).toBe("pending");
    held();
    expect(await settled(waiting)).toBe("resolved");
  });

  it("rejects immediately for an already aborted signal", async () => {
    const clock = createFakeClock();
    const pacer = createPacer({ requestsPerSecond: 1, ...clock });
    await expect(pacer.acquire(AbortSignal.abort())).rejects.toThrow();
    expect(clock.sleeps).toEqual([]);
  });
});

describe("realSleep", () => {
  it("resolves after the delay", async () => {
    const started = Date.now();
    await realSleep(15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it("rejects when aborted before or during the wait", async () => {
    await expect(realSleep(10, AbortSignal.abort())).rejects.toThrow();
    const controller = new AbortController();
    const pending = realSleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("abortReason", () => {
  it("keeps Error reasons and wraps others as AbortError", () => {
    const reason = new Error("why");
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortReason(controller.signal)).toBe(reason);

    const other = new AbortController();
    other.abort("plain string");
    expect(abortReason(other.signal).name).toBe("AbortError");
    expect(abortReason(undefined).name).toBe("AbortError");
  });
});
