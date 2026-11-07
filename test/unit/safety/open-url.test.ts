import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { openerCommand, openInBrowser } from "../../../src/safety/open-url.js";

const URL = `http://127.0.0.1:51234/approve/${"A".repeat(43)}`;

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: EventEmitter & { unrefCalled: boolean };
}

/** A fake `spawn` that records its calls and lets the test drive the child's events. */
function fakeSpawn(behavior: (child: EventEmitter) => void = () => undefined) {
  const spawned: Spawned[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), {
      unrefCalled: false,
      unref() {
        child.unrefCalled = true;
      },
    });
    spawned.push({ command, args, options, child });
    queueMicrotask(() => {
      behavior(child);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, spawned };
}

describe("openerCommand", () => {
  it.each([
    ["darwin", "open", [URL]],
    ["linux", "xdg-open", [URL]],
    ["freebsd", "xdg-open", [URL]],
    ["win32", "cmd", ["/c", "start", '""', URL]],
  ] as const)("uses the %s opener", (platform, command, args) => {
    expect(openerCommand(platform, URL)).toEqual({ command, args });
  });
});

describe("openInBrowser", () => {
  it("spawns the opener with an argument array, detached, without a shell", async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.emit("exit", 0));

    const opened = await openInBrowser(URL, { platform: "darwin", spawn });

    expect(opened).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: "open",
      args: [URL],
      options: { detached: true, stdio: "ignore", shell: false, windowsVerbatimArguments: false },
    });
    expect(spawned[0]?.child.unrefCalled).toBe(true);
  });

  it("passes the Windows start arguments verbatim", async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.emit("exit", 0));

    await openInBrowser(URL, { platform: "win32", spawn });

    expect(spawned[0]?.options).toMatchObject({ shell: false, windowsVerbatimArguments: true });
  });

  it.each([
    ["exits with an error code", (child: EventEmitter) => child.emit("exit", 3)],
    ["is missing (spawn error)", (child: EventEmitter) => child.emit("error", new Error("ENOENT"))],
  ])("reports false when the opener %s", async (_label, behavior) => {
    const { spawn } = fakeSpawn(behavior);

    expect(await openInBrowser(URL, { platform: "linux", spawn })).toBe(false);
  });

  it("reports false when spawn itself throws", async () => {
    const spawn = () => {
      throw new Error("EPERM");
    };

    expect(await openInBrowser(URL, { platform: "linux", spawn })).toBe(false);
  });

  it("counts an opener that is still running after the settle time as started", async () => {
    const { spawn } = fakeSpawn();

    expect(await openInBrowser(URL, { platform: "linux", spawn, settleMs: 5 })).toBe(true);
  });
});
