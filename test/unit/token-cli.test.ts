import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  type AccountIdentity,
  IdentityError,
  type IdentityLookup,
} from "../../src/accounts/types.js";
import { type Keychain, KeychainError } from "../../src/safety/keychain.js";
import {
  readSecretInput,
  runTokenCommand,
  type SecretInputStream,
  type TokenCommand,
  type TokenCommandDeps,
  TokenInputError,
} from "../../src/token-cli.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const command = (action: TokenCommand["action"], label = "work"): TokenCommand => ({
  kind: "token",
  action,
  label,
});

/** A keychain double holding at most one token per label. */
function fakeKeychain(initial: Record<string, string> = {}, failStore?: KeychainError) {
  const items = new Map(Object.entries(initial));
  const calls: string[] = [];
  const keychain: Keychain = {
    read(label) {
      calls.push(`read ${label}`);
      const token = items.get(label);
      return token === undefined
        ? Promise.reject(new KeychainError("not_found", `No token is stored under "${label}".`))
        : Promise.resolve(token);
    },
    store(label, token) {
      calls.push(`store ${label}`);
      if (failStore !== undefined) return Promise.reject(failStore);
      items.set(label, token);
      return Promise.resolve();
    },
    remove(label) {
      calls.push(`remove ${label}`);
      return Promise.resolve(items.delete(label));
    },
  };
  return { keychain, items, calls };
}

function identifyAs(result: AccountIdentity | IdentityError): {
  identify: IdentityLookup;
  tokens: string[];
} {
  const tokens: string[] = [];
  return {
    tokens,
    identify: (token) => {
      tokens.push(token);
      return result instanceof IdentityError ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

/** Runs a command with captured output; asserts the token appears in none of it. */
async function run(
  cmd: TokenCommand,
  deps: TokenCommandDeps,
  input: string | Error = `${TOKEN}\n`,
  env: Record<string, string> = {},
) {
  let out = "";
  let err = "";
  const prompts: string[] = [];
  const code = await runTokenCommand(
    cmd,
    env,
    {
      out: (text) => (out += text),
      err: (text) => (err += text),
      readToken: (prompt) => {
        prompts.push(prompt);
        return input instanceof Error ? Promise.reject(input) : Promise.resolve(input);
      },
    },
    { platform: "darwin", ...deps },
  );
  expect(out).not.toContain(TOKEN);
  expect(err).not.toContain(TOKEN);
  return { code, out, err, prompts };
}

describe("token set", () => {
  it("checks the token with sevDesk, stores it and names the account", async () => {
    const { keychain, items, calls } = fakeKeychain();
    const { identify, tokens } = identifyAs({ accountId: "1319229" });

    const result = await run(command("set"), { keychain, identify });

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(['sevDesk API token for label "work" (input hidden): ']);
    expect(tokens).toEqual([TOKEN]);
    expect(items.get("work")).toBe(TOKEN);
    expect(calls).toEqual(["read work", "store work"]);
    expect(result.out).toBe(
      'Stored the token of sevDesk account 1319229 under keychain label "work".\n' +
        'Use it with SEVDESK_API_TOKEN_KEYCHAIN=work, or "token": {"keychain": "work"} in a ' +
        "profile.\n",
    );
    expect(result.err).toBe("");
  });

  it("says when it replaced a token", async () => {
    const { keychain, items } = fakeKeychain({ work: "ffffffffffffffffffffffffffffffff" });

    const result = await run(command("set"), {
      keychain,
      identify: identifyAs({ accountId: "7" }).identify,
    });

    expect(result.out).toMatch(/^Replaced the token of sevDesk account 7/);
    expect(items.get("work")).toBe(TOKEN);
  });

  it("stores nothing that sevDesk rejects, or that is no token", async () => {
    const rejected = new IdentityError(
      "unauthorized",
      "sevDesk rejected this API token (HTTP 401).",
    );
    for (const [input, identify] of [
      ["\n", identifyAs({ accountId: "1" }).identify],
      [`Bearer ${TOKEN}`, identifyAs({ accountId: "1" }).identify],
      [TOKEN, identifyAs(rejected).identify],
    ] as const) {
      const { keychain, calls } = fakeKeychain();
      const result = await run(command("set"), { keychain, identify }, input);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/[Nn]othing was stored|no token given/);
      expect(calls).toEqual([]);
    }
  });

  it("stores the token with a warning when sevDesk cannot be reached", async () => {
    const { keychain, items } = fakeKeychain();
    const unreachable = new IdentityError("unreachable", "Could not reach sevDesk.");

    const result = await run(command("set"), {
      keychain,
      identify: identifyAs(unreachable).identify,
    });

    expect(result.code).toBe(0);
    expect(result.err).toBe(
      "token: warning: the token could not be checked with sevDesk: Could not reach sevDesk.\n",
    );
    expect(result.out).toMatch(/^Stored the token under keychain label "work"\./);
    expect(items.get("work")).toBe(TOKEN);
  });

  it("reports keychain and input failures with their fixed text", async () => {
    const failing = fakeKeychain({}, new KeychainError("denied", "The keychain refused access."));
    const denied = await run(command("set"), {
      keychain: failing.keychain,
      identify: identifyAs({ accountId: "1" }).identify,
    });
    expect(denied).toMatchObject({ code: 1, err: "token: The keychain refused access.\n" });

    const cancelled = await run(
      command("set"),
      { keychain: fakeKeychain().keychain, identify: identifyAs({ accountId: "1" }).identify },
      new TokenInputError("cancelled; nothing was stored."),
    );
    expect(cancelled).toMatchObject({ code: 1, err: "token: cancelled; nothing was stored.\n" });
  });

  it("refuses an unusable SEVDESK_BASE_URL before asking for the token", async () => {
    const result = await run(command("set"), { keychain: fakeKeychain().keychain }, TOKEN, {
      SEVDESK_BASE_URL: "http://plain.test",
      SEVDESK_ALLOW: "bogus",
    });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/SEVDESK_BASE_URL must use https/);
    expect(result.err).not.toMatch(/SEVDESK_ALLOW/);
    expect(result.prompts).toEqual([]);
  });

  it("rethrows unexpected errors", async () => {
    const identify: IdentityLookup = () => Promise.reject(new TypeError("bug"));
    await expect(
      run(command("set"), { keychain: fakeKeychain().keychain, identify }),
    ).rejects.toThrow(TypeError);
  });
});

describe("token check", () => {
  it("names the account of a valid stored token", async () => {
    const { identify, tokens } = identifyAs({ accountId: "1319229" });

    const result = await run(command("check"), {
      keychain: fakeKeychain({ work: TOKEN }).keychain,
      identify,
    });

    expect(result).toMatchObject({
      code: 0,
      out: 'Keychain label "work": a valid token of sevDesk account 1319229.\n',
    });
    expect(tokens).toEqual([TOKEN]);
    expect(result.prompts).toEqual([]);
  });

  it("reports a missing token and one sevDesk refuses", async () => {
    const missing = await run(command("check"), { keychain: fakeKeychain().keychain });
    expect(missing).toMatchObject({ code: 1, err: 'token: No token is stored under "work".\n' });

    const rejected = await run(command("check"), {
      keychain: fakeKeychain({ work: TOKEN }).keychain,
      identify: identifyAs(new IdentityError("unauthorized", "sevDesk rejected this API token."))
        .identify,
    });
    expect(rejected).toMatchObject({
      code: 1,
      err: 'token: keychain label "work" holds a token, but: sevDesk rejected this API token.\n',
    });
  });
});

describe("token delete", () => {
  it("deletes a stored token and reports a missing one", async () => {
    const { keychain, items } = fakeKeychain({ work: TOKEN });

    expect(await run(command("delete"), { keychain })).toMatchObject({
      code: 0,
      out: 'Deleted the token stored under keychain label "work".\n',
    });
    expect(items.has("work")).toBe(false);
    expect(await run(command("delete"), { keychain })).toMatchObject({
      code: 1,
      err: 'token: no token is stored under keychain label "work".\n',
    });
  });
});

describe("on Windows", () => {
  it("refuses every action with a pointer, before asking for anything", async () => {
    for (const action of ["set", "check", "delete"] as const) {
      const result = await run(command(action), { platform: "win32" });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/^token: The OS keychain is not supported on Windows yet/);
      expect(result.prompts).toEqual([]);
    }
  });
});

/** A stdin double: a TTY in raw mode, or a pipe. */
function fakeStdin(tty: boolean) {
  const stream = Object.assign(new EventEmitter(), {
    isTTY: tty,
    raw: [] as boolean[],
    paused: false,
    setRawMode(mode: boolean) {
      stream.raw.push(mode);
    },
    setEncoding() {
      return stream;
    },
    resume() {
      stream.paused = false;
    },
    pause() {
      stream.paused = true;
    },
  });
  return stream as typeof stream & SecretInputStream;
}

describe("readSecretInput", () => {
  it("reads a pipe to its end", async () => {
    const stdin = fakeStdin(false);
    const written: string[] = [];
    const reading = readSecretInput(stdin, (text) => written.push(text), "prompt: ");

    stdin.emit("data", TOKEN.slice(0, 8));
    stdin.emit("data", `${TOKEN.slice(8)}\n`);
    stdin.emit("end");

    expect(await reading).toBe(`${TOKEN}\n`);
    expect(written).toEqual([]);
    expect(stdin.paused).toBe(true);
  });

  it("hides typed input on a terminal and edits with Backspace", async () => {
    const stdin = fakeStdin(true);
    const written: string[] = [];
    const reading = readSecretInput(stdin, (text) => written.push(text), "Token: ");

    stdin.emit("data", "abX\u007f");
    stdin.emit("data", "\x1b[Dc\bC");
    stdin.emit("data", "d\rignored");

    expect(await reading).toBe("abCd");
    expect(written).toEqual(["Token: ", "\n"]);
    expect(stdin.raw).toEqual([true, false]);
  });

  it("ends at Ctrl-D and aborts at Ctrl-C", async () => {
    const ended = fakeStdin(true);
    const reading = readSecretInput(ended, () => undefined, "");
    ended.emit("data", "abc\u0004");
    expect(await reading).toBe("abc");

    const aborted = fakeStdin(true);
    const cancelled = readSecretInput(aborted, () => undefined, "");
    aborted.emit("data", "ab\u0003");
    await expect(cancelled).rejects.toThrow(new TokenInputError("cancelled; nothing was stored."));
    expect(aborted.raw).toEqual([true, false]);
  });

  it("refuses input longer than 4 KiB, and read errors", async () => {
    const tty = fakeStdin(true);
    const longTyped = readSecretInput(tty, () => undefined, "");
    tty.emit("data", "a".repeat(5000));
    await expect(longTyped).rejects.toThrow(/longer than 4096 characters/);

    const pipe = fakeStdin(false);
    const longPiped = readSecretInput(pipe, () => undefined, "");
    pipe.emit("data", "a".repeat(5000));
    await expect(longPiped).rejects.toThrow(/longer than 4096 characters/);

    const broken = fakeStdin(false);
    const failed = readSecretInput(broken, () => undefined, "");
    broken.emit("error", new Error("EIO"));
    await expect(failed).rejects.toThrow(/could not be read from stdin/);
  });
});
