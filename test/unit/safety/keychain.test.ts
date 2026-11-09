import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createKeychain,
  KEYCHAIN_SERVICE,
  keychainCommands,
  KeychainError,
  type KeychainSpawn,
  keychainUnsupported,
} from "../../../src/safety/keychain.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** What a fake helper does once spawned: print, exit, fail or hang. */
type Script =
  | { readonly stdout?: string | readonly string[]; readonly code: number | null }
  | { readonly error: string }
  | { readonly hang: true };

interface FakeChild extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stdin: EventEmitter & { written: string; end(text: string): void };
  killedWith: string | undefined;
  kill(signal: string): boolean;
}

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeChild;
}

/** A fake `spawn` that runs `scripts` in order (the last one repeats) and records every call. */
function fakeSpawn(...scripts: Script[]) {
  const spawned: Spawned[] = [];
  const spawn: KeychainSpawn = (command, args, options) => {
    const script = scripts[Math.min(spawned.length, scripts.length - 1)] ?? { code: 0 };
    const stdin = Object.assign(new EventEmitter(), {
      written: "",
      end(text: string) {
        stdin.written += text;
      },
    });
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin,
      killedWith: undefined as string | undefined,
      kill(signal: string) {
        child.killedWith = signal;
        return true;
      },
    });
    spawned.push({ command, args, options, child });
    setImmediate(() => {
      if ("hang" in script) return;
      if ("error" in script) {
        child.emit(
          "error",
          Object.assign(new Error(`spawn ${command} ${script.error}`), {
            code: script.error,
          }),
        );
        return;
      }
      const out = script.stdout ?? [];
      for (const part of typeof out === "string" ? [out] : out) {
        child.stdout.emit("data", Buffer.from(part));
      }
      child.emit("close", script.code);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, spawned };
}

async function failure(promise: Promise<unknown>): Promise<KeychainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KeychainError) return error;
    throw error;
  }
  throw new Error("expected a KeychainError");
}

describe("keychainCommands", () => {
  it("reads and deletes with /usr/bin/security on macOS, storing through stdin", () => {
    const mac = keychainCommands("darwin");
    expect(mac.lookup("work")).toEqual({
      command: "/usr/bin/security",
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "work", "-w"],
    });
    expect(mac.remove("work")).toEqual({
      command: "/usr/bin/security",
      args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "work"],
    });
    const store = mac.store("work", TOKEN);
    expect(store.command).toBe("/usr/bin/security");
    expect(store.args).toEqual(["-i"]);
    expect(store.args.join(" ")).not.toContain(TOKEN);
    expect(store.input).toBe(`add-generic-password -U -s mcp-server-sevdesk -a work -w ${TOKEN}\n`);
  });

  it("uses secret-tool elsewhere, with the token on stdin only", () => {
    const linux = keychainCommands("linux");
    expect(linux.lookup("work")).toEqual({
      command: "secret-tool",
      args: ["lookup", "service", KEYCHAIN_SERVICE, "account", "work"],
    });
    expect(linux.remove("work").args).toEqual([
      "clear",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      "work",
    ]);
    const store = linux.store("work", TOKEN);
    expect(store.args).toEqual([
      "store",
      "--label=mcp-server-sevdesk (work)",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      "work",
    ]);
    expect(store.input).toBe(TOKEN);
    expect(keychainCommands("freebsd").platform).toBe("secret-service");
  });

  it("refuses Windows with a pointer to the token file and the .mcpb bundle", () => {
    expect(() => keychainCommands("win32")).toThrow(/SEVDESK_API_TOKEN_FILE.*\.mcpb/s);
    expect(keychainUnsupported("win32")).toMatch(/not supported on Windows/);
    expect(keychainUnsupported("darwin")).toBeUndefined();
    expect(keychainUnsupported("linux")).toBeUndefined();
  });
});

describe("read", () => {
  it("spawns the helper without a shell, discarding stderr, and trims the output", async () => {
    const { spawn, spawned } = fakeSpawn({ stdout: `${TOKEN}\n`, code: 0 });

    const token = await createKeychain({ platform: "darwin", spawn }).read("work");

    expect(token).toBe(TOKEN);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.options).toMatchObject({
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  });

  it("joins output that arrives in several chunks", async () => {
    const { spawn } = fakeSpawn({ stdout: [TOKEN.slice(0, 10), TOKEN.slice(10)], code: 0 });

    expect(await createKeychain({ platform: "linux", spawn }).read("work")).toBe(TOKEN);
  });

  it.each([
    ["darwin", 44, "not_found", /No token is stored under keychain label "work"\. Store one/],
    ["darwin", 128, "denied", /refused access/],
    ["darwin", 51, "denied", /refused access/],
    ["darwin", 36, "unavailable", /security unlock-keychain/],
    ["darwin", 9, "failed", /security exited with 9/],
    ["linux", 1, "not_found", /or the Secret Service .* is locked or not running/],
    ["linux", 2, "failed", /secret-tool could not read the token \(exit code 2\)/],
  ] as const)("on %s maps exit code %i to %s", async (platform, code, kind, message) => {
    const { spawn } = fakeSpawn({ code });

    const error = await failure(createKeychain({ platform, spawn }).read("work"));

    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(message);
  });

  it("treats empty output as not found", async () => {
    const { spawn } = fakeSpawn({ stdout: "\n", code: 0 });

    expect((await failure(createKeychain({ platform: "linux", spawn }).read("w"))).kind).toBe(
      "not_found",
    );
  });

  it("explains how to install secret-tool when it is missing", async () => {
    const { spawn } = fakeSpawn({ error: "ENOENT" });

    const error = await failure(createKeychain({ platform: "linux", spawn }).read("work"));

    expect(error.kind).toBe("unavailable");
    expect(error.message).toMatch(/apt install libsecret-tools/);
  });

  it("points to the token file when /usr/bin/security is missing", async () => {
    const { spawn } = fakeSpawn({ error: "ENOENT" });

    const error = await failure(createKeychain({ platform: "darwin", spawn }).read("work"));

    expect(error.message).toMatch(/\/usr\/bin\/security was not found.*SEVDESK_API_TOKEN_FILE/);
  });

  it.each([
    ["a spawn error other than ENOENT", { error: "EACCES" }],
    ["a helper killed by a signal", { code: null }],
  ] as const)("reports %s as a failure", async (_label, script) => {
    const { spawn } = fakeSpawn(script);

    const error = await failure(createKeychain({ platform: "linux", spawn }).read("work"));

    expect(error).toMatchObject({
      kind: "failed",
      message: "The keychain helper could not be run.",
    });
  });

  it("reports a spawn that throws synchronously", async () => {
    const spawn: KeychainSpawn = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    expect((await failure(createKeychain({ platform: "linux", spawn }).read("w"))).kind).toBe(
      "unavailable",
    );
    const throwing: KeychainSpawn = () => {
      throw new Error("EPERM");
    };
    expect(
      (await failure(createKeychain({ platform: "linux", spawn: throwing }).read("w"))).kind,
    ).toBe("failed");
  });

  it("kills a helper that does not answer in time", async () => {
    const { spawn, spawned } = fakeSpawn({ hang: true });

    const error = await failure(
      createKeychain({ platform: "darwin", spawn, timeoutMs: 5 }).read("work"),
    );

    expect(error.kind).toBe("timeout");
    expect(error.message).toMatch(/did not answer in time/);
    expect(spawned[0]?.child.killedWith).toBe("SIGKILL");
  });

  it("stops a helper that prints more than 4 KiB", async () => {
    const { spawn, spawned } = fakeSpawn({ stdout: ["a".repeat(3000), "b".repeat(3000)], code: 0 });

    const error = await failure(createKeychain({ platform: "linux", spawn }).read("work"));

    expect(error.kind).toBe("failed");
    expect(error.message).toMatch(/more than a token/);
    expect(spawned[0]?.child.killedWith).toBe("SIGKILL");
  });

  it("checks the stored value like any token", async () => {
    const { spawn } = fakeSpawn({ stdout: `Bearer ${TOKEN}`, code: 0 });

    const error = await failure(createKeychain({ platform: "darwin", spawn }).read("work"));

    expect(error.kind).toBe("invalid");
    expect(error.message).toBe(
      "The token stored under keychain label \"work\" must be the raw token, without a 'Bearer ' " +
        "prefix. Store it again with `mcp-server-sevdesk token set work`.",
    );
    expect(error.message).not.toContain(TOKEN);
  });

  it("refuses invalid labels before running anything", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 });
    const keychain = createKeychain({ platform: "darwin", spawn });

    for (const label of ["", "a b", "-s", "x".repeat(65), "läbel", TOKEN]) {
      expect((await failure(keychain.read(label))).kind).toBe("invalid");
    }
    expect(spawned).toHaveLength(0);
  });

  it("refuses Windows without running anything", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 });

    const error = await failure(createKeychain({ platform: "win32", spawn }).read("work"));

    expect(error.kind).toBe("unsupported");
    expect(spawned).toHaveLength(0);
  });
});

describe("store", () => {
  it("writes the token to stdin only and reads it back (macOS)", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 }, { stdout: `${TOKEN}\n`, code: 0 });

    await createKeychain({ platform: "darwin", spawn }).store("work", TOKEN);

    expect(spawned).toHaveLength(2);
    const [store, check] = spawned;
    expect(store?.args).toEqual(["-i"]);
    expect(store?.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    expect(store?.child.stdin.written).toBe(
      `add-generic-password -U -s mcp-server-sevdesk -a work -w ${TOKEN}\n`,
    );
    for (const call of spawned) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(check?.args).toContain("find-generic-password");
  });

  it("writes the bare token to secret-tool's stdin (Linux)", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 }, { stdout: TOKEN, code: 0 });

    await createKeychain({ platform: "linux", spawn }).store("work", TOKEN);

    expect(spawned[0]?.child.stdin.written).toBe(TOKEN);
  });

  it("refuses tokens that would need quoting, before running anything", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 });
    const keychain = createKeychain({ platform: "darwin", spawn });

    for (const token of ["abc def", "abc\n-A", 'abc"', "a".repeat(513), ""]) {
      const error = await failure(keychain.store("work", token));
      expect(error.kind).toBe("invalid");
      expect(error.message).toMatch(/letters, digits, '_' and '-'/);
    }
    expect(spawned).toHaveLength(0);
  });

  it("fails when the helper fails, or the token cannot be read back", async () => {
    const failing = fakeSpawn({ code: 5 });
    expect(
      (
        await failure(
          createKeychain({ platform: "darwin", spawn: failing.spawn }).store("w", TOKEN),
        )
      ).message,
    ).toMatch(/could not store the token \(security exited with 5\)/);

    const lost = fakeSpawn({ code: 0 }, { code: 44 });
    const error = await failure(
      createKeychain({ platform: "darwin", spawn: lost.spawn }).store("w", TOKEN),
    );
    expect(error.kind).toBe("failed");
    expect(error.message).toMatch(/did not keep the token/);

    const linux = fakeSpawn({ code: 3 });
    expect(
      (await failure(createKeychain({ platform: "linux", spawn: linux.spawn }).store("w", TOKEN)))
        .message,
    ).toMatch(/secret-tool could not store the token \(exit code 3\)/);

    const timeout = fakeSpawn({ hang: true });
    expect(
      (
        await failure(
          createKeychain({ platform: "linux", spawn: timeout.spawn, timeoutMs: 5 }).store(
            "w",
            TOKEN,
          ),
        )
      ).kind,
    ).toBe("timeout");
  });

  it("fails when a different value comes back", async () => {
    const { spawn } = fakeSpawn(
      { code: 0 },
      { stdout: "ffffffffffffffffffffffffffffffff", code: 0 },
    );

    expect(
      (await failure(createKeychain({ platform: "linux", spawn }).store("w", TOKEN))).kind,
    ).toBe("failed");
  });
});

describe("remove", () => {
  it("deletes directly on macOS and reports a missing item as false", async () => {
    const deleted = fakeSpawn({ code: 0 });
    expect(await createKeychain({ platform: "darwin", spawn: deleted.spawn }).remove("w")).toBe(
      true,
    );
    expect(deleted.spawned[0]?.args[0]).toBe("delete-generic-password");

    const missing = fakeSpawn({ code: 44 });
    expect(await createKeychain({ platform: "darwin", spawn: missing.spawn }).remove("w")).toBe(
      false,
    );

    const denied = fakeSpawn({ code: 128 });
    expect(
      (await failure(createKeychain({ platform: "darwin", spawn: denied.spawn }).remove("w"))).kind,
    ).toBe("denied");
  });

  it("looks the item up first on Linux, since secret-tool clear always succeeds", async () => {
    const present = fakeSpawn({ stdout: TOKEN, code: 0 }, { code: 0 });
    expect(await createKeychain({ platform: "linux", spawn: present.spawn }).remove("w")).toBe(
      true,
    );
    expect(present.spawned.map((call) => call.args[0])).toEqual(["lookup", "clear"]);

    const absent = fakeSpawn({ code: 1 });
    expect(await createKeychain({ platform: "linux", spawn: absent.spawn }).remove("w")).toBe(
      false,
    );
    expect(absent.spawned).toHaveLength(1);

    const broken = fakeSpawn({ stdout: TOKEN, code: 0 }, { code: 4 });
    expect(
      (await failure(createKeychain({ platform: "linux", spawn: broken.spawn }).remove("w")))
        .message,
    ).toMatch(/could not delete the token \(exit code 4\)/);

    const missing = fakeSpawn({ error: "ENOENT" });
    expect(
      (await failure(createKeychain({ platform: "linux", spawn: missing.spawn }).remove("w"))).kind,
    ).toBe("unavailable");

    const hung = fakeSpawn({ stdout: TOKEN, code: 0 }, { hang: true });
    expect(
      (
        await failure(
          createKeychain({ platform: "linux", spawn: hung.spawn, timeoutMs: 5 }).remove("w"),
        )
      ).kind,
    ).toBe("timeout");
  });
});

describe("secrets", () => {
  it("never puts helper output into errors, even when the helper printed the token", async () => {
    const scripts: Script[] = [
      { stdout: `${TOKEN}\n`, code: 1 },
      { stdout: `${TOKEN}\n`, code: 2 },
      { stdout: `${TOKEN}\n`, code: 44 },
      { stdout: `${TOKEN}\n`, code: null },
      { stdout: [`${TOKEN}\n`, "x".repeat(5000)], code: 0 },
    ];
    for (const platform of ["darwin", "linux"] as const) {
      for (const script of scripts) {
        const { spawn } = fakeSpawn(script);
        const error = await failure(createKeychain({ platform, spawn }).read("work"));
        expect(error.message).not.toContain(TOKEN);
        expect(error.stack ?? "").not.toContain(TOKEN);
        expect(inspect(error)).not.toContain(TOKEN);
        expect(JSON.stringify(error)).not.toContain(TOKEN);
        expect(error.cause).toBeUndefined();
      }
    }
  });

  it("never puts the token being stored into errors", async () => {
    for (const script of [{ code: 7 }, { code: 0 }] as const) {
      const { spawn } = fakeSpawn(script, { stdout: `${TOKEN}x`, code: 0 });
      const error = await failure(createKeychain({ platform: "darwin", spawn }).store("w", TOKEN));
      expect(error.message).not.toContain(TOKEN);
      expect(inspect(error)).not.toContain(TOKEN);
    }
  });
});
