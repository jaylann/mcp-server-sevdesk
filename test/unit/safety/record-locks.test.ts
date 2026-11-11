import { describe, expect, it } from "vitest";

import { createRecordLocks } from "../../../src/safety/record-locks.js";

/** A promise with its resolve function, to hold work open until a test lets it finish. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("record locks", () => {
  it("runs work on the same key one after the other", async () => {
    const locks = createRecordLocks();
    const order: string[] = [];
    const first = gate();

    const a = locks.run(["Invoice:1"], async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
    });
    const b = locks.run(["Invoice:1"], () => {
      order.push("b");
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["a start"]);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });

  it("runs work on different keys at the same time", async () => {
    const locks = createRecordLocks();
    const held = gate();
    let other = false;

    const a = locks.run(["Invoice:1"], () => held.promise);
    await locks.run(["Invoice:2"], () => {
      other = true;
      return Promise.resolve();
    });

    expect(other).toBe(true);
    held.open();
    await a;
  });

  it("takes several keys in a fixed order, so overlapping calls cannot deadlock", async () => {
    const locks = createRecordLocks();
    const results = await Promise.all([
      locks.run(["Transaction:5", "Invoice:1"], () => Promise.resolve("a")),
      locks.run(["Invoice:1", "Transaction:5"], () => Promise.resolve("b")),
      locks.run(["Invoice:1", "Invoice:1"], () => Promise.resolve("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("releases the keys when the work fails", async () => {
    const locks = createRecordLocks();
    await expect(locks.run(["Invoice:1"], () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(locks.run(["Invoice:1"], () => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("runs work without keys at once", async () => {
    const locks = createRecordLocks();
    await expect(locks.run([], () => Promise.resolve(1))).resolves.toBe(1);
  });
});
