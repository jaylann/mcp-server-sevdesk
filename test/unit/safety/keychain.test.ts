import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLocalConfig } from "../../../src/accounts/local-config.js";
import {
  createKeychain,
  KEYCHAIN_SERVICE,
  keychainCommands,
  KeychainError,
  type KeychainSpawn,
} from "../../../src/safety/keychain.js";
import { runTokenCommand } from "../../../src/token-cli.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SYSTEM_ROOT = String.raw`C:\Windows`;

afterEach(() => vi.unstubAllEnvs());

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

  it("uses one constant Windows script, with all data on stdin and no PATH lookup", () => {
    vi.stubEnv("PATH", String.raw`C:\attacker`);
    vi.stubEnv("SystemRoot", SYSTEM_ROOT);
    const windows = keychainCommands("win32");
    const commands = [
      windows.lookup("work"),
      windows.store("client-a", TOKEN),
      windows.remove("old"),
    ];
    for (const command of commands) {
      expect(command.command).toBe(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      expect(command.args).toEqual(commands[0]?.args);
      expect(command.args.slice(0, 4)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      expect(command.args.join(" ")).not.toContain(TOKEN);
    }
    const script = commands[0]?.args[4];
    expect(script).toContain("Windows.Security.Credentials.PasswordVault");
    expect(script).toContain(`'${KEYCHAIN_SERVICE}'`);
    expect(script).not.toMatch(/Add-Type|Invoke-Expression|ExecutionPolicy|RetrieveAll|FindAll/);
    expect(script).not.toContain("client-a");
    expect(commands.map((command) => command.input)).toEqual([
      "read\nwork\n\n",
      `store\nclient-a\n${TOKEN}\n`,
      "delete\nold\n\n",
    ]);
    expect(keychainCommands("win32", String.raw`D:\Windows Install`).lookup("work").command).toBe(
      String.raw`D:\Windows Install\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
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

  it.each(["darwin", "win32"] as const)(
    "kills a %s helper that does not answer in time",
    async (platform) => {
      const { spawn, spawned } = fakeSpawn({ hang: true });

      const error = await failure(
        createKeychain({ platform, systemRoot: SYSTEM_ROOT, spawn, timeoutMs: 5 }).read("work"),
      );

      expect(error.kind).toBe("timeout");
      expect(error.message).toMatch(/did not answer in time/);
      expect(spawned[0]?.child.killedWith).toBe("SIGKILL");
    },
  );

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
});

describe("Windows PasswordVault", () => {
  it.each(["0", "x".repeat(512)])(
    "preserves accepted token bounds and a 64-character label",
    async (token) => {
      const label = `0${"x".repeat(60)}._-`;
      const { spawn, spawned } = fakeSpawn(
        { code: 0, stdout: "OK\n" },
        { code: 0, stdout: `TOKEN:${token}\n` },
      );
      await createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn }).store(
        label,
        token,
      );
      expect(spawned[0]?.child.stdin.written).toBe(`store\n${label}\n${token}\n`);
    },
  );

  it("reads through the real configuration path with an injected helper", async () => {
    const { spawn, spawned } = fakeSpawn({ stdout: ["TOKEN:", TOKEN, "\r\n"], code: 0 });
    const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
    const { config } = await loadLocalConfig(
      { SEVDESK_API_TOKEN_KEYCHAIN: "work" },
      { platform: "win32", keychain },
    );
    expect(config.token).toBe(TOKEN);
    expect(spawned[0]?.options).toEqual({
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(spawned[0]?.child.stdin.written).toBe("read\nwork\n\n");
  });

  it("stores via stdin and verifies the value, then deletes without exposing a password", async () => {
    const { spawn, spawned } = fakeSpawn(
      { stdout: "OK\r\n", code: 0 },
      { stdout: `TOKEN:${TOKEN}\r\n`, code: 0 },
      { stdout: "OK\r\n", code: 0 },
      { code: 2 },
    );
    const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
    await keychain.store("work", TOKEN);
    expect(await keychain.remove("work")).toBe(true);
    expect(await keychain.remove("work")).toBe(false);
    expect(spawned.map((call) => call.child.stdin.written)).toEqual([
      `store\nwork\n${TOKEN}\n`,
      "read\nwork\n\n",
      "delete\nwork\n\n",
      "delete\nwork\n\n",
    ]);
    for (const { command, args, options } of spawned) {
      expect(inspect({ command, args, options })).not.toContain(TOKEN);
    }
  });

  it.each([
    [2, "not_found", /No token is stored/],
    [3, "denied", /refused access/],
    [4, "unavailable", /Constrained Language Mode.*SEVDESK_API_TOKEN_FILE/],
    [5, "invalid", /refused its input/],
    [1, "failed", /PowerShell exited with 1/],
    [99, "failed", /PowerShell exited with 99/],
  ] as const)(
    "maps exit %i to %s for reads and writes without echoing diagnostics",
    async (code, kind, message) => {
      const { spawn } = fakeSpawn({ code, stdout: TOKEN });
      const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
      const operations: (() => Promise<unknown>)[] = [
        () => keychain.read("work"),
        () => keychain.store("work", TOKEN),
      ];
      if (code !== 2) operations.push(() => keychain.remove("work"));
      for (const operation of operations) {
        const error = await failure(operation());
        expect(error.kind).toBe(kind);
        expect(error.message).toMatch(message);
        expect(inspect(error)).not.toContain(TOKEN);
      }
    },
  );

  it("reports missing PowerShell with a usable fallback", async () => {
    const { spawn } = fakeSpawn({ error: "ENOENT" });
    const error = await failure(
      createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn }).read("work"),
    );
    expect(error.kind).toBe("unavailable");
    expect(error.message).toMatch(
      /Windows PowerShell was not found.*SEVDESK_API_TOKEN_FILE.*\.mcpb/s,
    );
  });

  it.each([
    undefined,
    "",
    "Windows",
    String.raw`C:Windows`,
    String.raw`\Windows`,
    String.raw`\\host\share`,
    String.raw`\\?\C:\Windows`,
    String.raw`C:\Windows\..\evil`,
    "C:/Windows",
    "C:\\Windows\n",
    String.raw`C:\Windows.`,
    String.raw`C:\Windows\\`,
  ])("refuses an unsafe installation directory before spawning (%s)", async (systemRoot) => {
    vi.stubEnv("SystemRoot", systemRoot);
    const { spawn, spawned } = fakeSpawn({ code: 0 });
    const error = await failure(createKeychain({ platform: "win32", spawn }).read("work"));
    expect(error.kind).toBe("unavailable");
    expect(error.message).toMatch(/needs SystemRoot/);
    expect(spawned).toHaveLength(0);
  });

  it("refuses hostile labels and tokens before PowerShell receives them", async () => {
    const { spawn, spawned } = fakeSpawn({ code: 0 });
    const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
    for (const label of [
      "",
      "x".repeat(65),
      "läbel",
      "-x",
      "work\n",
      "a b",
      "x';exit 0;#",
      "$(whoami)",
      TOKEN,
    ]) {
      for (const operation of [
        () => keychain.read(label),
        () => keychain.store(label, TOKEN),
        () => keychain.remove(label),
      ]) {
        expect((await failure(operation())).kind).toBe("invalid");
      }
    }
    for (const token of ["", "x\n", "a".repeat(513), "abc def", "$(whoami)", 'abc"']) {
      expect((await failure(keychain.store("work", token))).kind).toBe("invalid");
    }
    expect(spawned).toHaveLength(0);
  });

  it.each([
    "",
    "OK\r\n",
    TOKEN,
    `TOKEN:Bearer ${TOKEN}\r\n`,
    `TOKEN:${TOKEN}\nextra`,
    "TOKEN:\r\n",
    `TOKEN:${"x".repeat(513)}\n`,
  ])("rejects malformed successful reads without echoing output", async (stdout) => {
    const { spawn } = fakeSpawn({ code: 0, stdout });
    const error = await failure(
      createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn }).read("work"),
    );
    expect(error.kind).toBe("invalid");
    expect(inspect(error)).not.toContain(TOKEN);
  });

  it("requires an exact acknowledgement for store and delete", async () => {
    for (const stdout of ["", `OK\r\n${TOKEN}`, `TOKEN:${TOKEN}\r\n`]) {
      const { spawn, spawned } = fakeSpawn({ code: 0, stdout });
      const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
      expect((await failure(keychain.store("work", TOKEN))).kind).toBe("invalid");
      expect((await failure(keychain.remove("work"))).kind).toBe("invalid");
      expect(spawned).toHaveLength(2);
    }
  });

  it("fails when a stored token is lost or replaced before verification", async () => {
    for (const script of [{ code: 2 }, { code: 0, stdout: "TOKEN:different\r\n" }]) {
      const { spawn } = fakeSpawn({ code: 0, stdout: "OK\n" }, script);
      const error = await failure(
        createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn }).store("work", TOKEN),
      );
      expect(error.kind).toBe("failed");
      expect(error.message).toMatch(/reading it back failed/);
      expect(inspect(error)).not.toContain(TOKEN);
    }
  });

  it("keeps secrets out of captured CLI output on success and helper failures", async () => {
    const scenarios: Script[][] = [
      [{ code: 2 }, { code: 0, stdout: "OK\r\n" }, { code: 0, stdout: `TOKEN:${TOKEN}\r\n` }],
      [{ code: 3, stdout: TOKEN }],
      [{ code: 0, stdout: TOKEN }],
      [{ error: TOKEN }],
    ];
    for (const scripts of scenarios) {
      const { spawn, spawned } = fakeSpawn(...scripts);
      const keychain = createKeychain({ platform: "win32", systemRoot: SYSTEM_ROOT, spawn });
      const output: string[] = [];
      const code = await runTokenCommand(
        { kind: "token", action: "set", label: "work" },
        {},
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
          readToken: (prompt) => {
            output.push(prompt);
            return Promise.resolve(TOKEN);
          },
        },
        { platform: "win32", keychain, identify: () => Promise.resolve({ accountId: "123" }) },
      );
      expect(code).toBe(scripts.length === 3 ? 0 : 1);
      expect(output.join("")).not.toContain(TOKEN);
      expect(
        inspect(spawned.map(({ command, args, options }) => ({ command, args, options }))),
      ).not.toContain(TOKEN);
    }
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
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const script of scripts) {
        const { spawn } = fakeSpawn(script);
        const error = await failure(
          createKeychain({ platform, spawn, systemRoot: SYSTEM_ROOT }).read("work"),
        );
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
