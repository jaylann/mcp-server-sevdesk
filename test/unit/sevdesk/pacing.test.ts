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
