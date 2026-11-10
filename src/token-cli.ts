/**
 * The `token set|check|delete <label>` commands: keep the sevDesk API token in the OS keychain
 * (`src/safety/keychain.ts`) for `SEVDESK_API_TOKEN_KEYCHAIN=<label>` or a profile's
 * `{"token": {"keychain": "<label>"}}`.
 *
 * `set` reads the token from stdin, hidden on a terminal, never from the command line (shell
 * history, process list). It checks the token with sevDesk first (`GET /SevClient`) and stores
 * nothing that sevDesk rejects; when sevDesk cannot be reached it stores the token with a warning.
 * Output names the label and the account id, never the token.
 */
import { createIdentityLookup } from "./accounts/identity.js";
import { IdentityError, type IdentityLookup } from "./accounts/types.js";
import type { Command } from "./cli.js";
import { ConfigError, type Env, readSettings, sevdeskTokenProblem } from "./config.js";
import {
  createKeychain,
  type Keychain,
  KeychainError,
  keychainUnsupported,
} from "./safety/keychain.js";

export type TokenCommand = Extract<Command, { kind: "token" }>;

/** Where the command reads and writes; the defaults are the process's stdin, stdout and stderr. */
export interface TokenCommandIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Reads the token: hidden input after `prompt` on a terminal, else all of stdin. */
  readonly readToken: (prompt: string) => Promise<string>;
}

export interface TokenCommandDeps {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to the OS keychain of `platform` with {@link CLI_KEYCHAIN_TIMEOUT_MS}. */
  readonly keychain?: Keychain;
  /** Defaults to {@link createIdentityLookup} for the environment's base URL. */
  readonly identify?: IdentityLookup;
}

/**
 * A person runs these commands and may have to answer a keychain dialog or type the keychain
 * password, so the helpers get longer than at server startup.
 */
const CLI_KEYCHAIN_TIMEOUT_MS = 120_000;

/** Upper bound for the sevDesk check, as in `account-id`. */
const IDENTIFY_TIMEOUT_MS = 15_000;

/** Largest input accepted as a token. */
const MAX_INPUT = 4096;

/** Terminal escape sequences (arrow keys, …): ESC `[` parameters, final byte. */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z~]`, "g");

const defaultIo: TokenCommandIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  readToken: (prompt) =>
    readSecretInput(process.stdin, (text) => process.stderr.write(text), prompt),
};

/** Runs a `token` command; resolves to the process exit code. */
export async function runTokenCommand(
  command: TokenCommand,
  env: Env,
  io: TokenCommandIo = defaultIo,
  deps: TokenCommandDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const unsupported = keychainUnsupported(platform);
  if (unsupported !== undefined) {
    io.err(`token: ${unsupported}\n`);
    return 1;
  }
  const keychain =
    deps.keychain ?? createKeychain({ platform, timeoutMs: CLI_KEYCHAIN_TIMEOUT_MS });
  try {
    switch (command.action) {
      case "set":
        return await setToken(command.label, env, io, keychain, deps.identify);
      case "check":
        return await checkToken(command.label, env, io, keychain, deps.identify);
      case "delete":
        return await deleteToken(command.label, io, keychain);
    }
  } catch (error) {
    if (
      error instanceof KeychainError ||
      error instanceof ConfigError ||
      error instanceof TokenInputError
    ) {
      io.err(`token: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function setToken(
  label: string,
  env: Env,
  io: TokenCommandIo,
  keychain: Keychain,
  identify: IdentityLookup | undefined,
): Promise<number> {
  const lookup = identify ?? identityLookup(env);
  const token = (
    await io.readToken(`sevDesk API token for label "${label}" (input hidden): `)
  ).trim();
  if (token === "") {
    io.err("token: no token given; nothing was stored.\n");
    return 1;
  }
  const problem = sevdeskTokenProblem(token, "The token");
  if (problem !== undefined) {
    io.err(`token: ${problem} Nothing was stored.\n`);
    return 1;
  }
  let account: string | undefined;
  try {
    account = (await lookup(token, AbortSignal.timeout(IDENTIFY_TIMEOUT_MS))).accountId;
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    if (error.kind === "unauthorized") {
      io.err(`token: ${error.message} Nothing was stored.\n`);
      return 1;
    }
    io.err(`token: warning: the token could not be checked with sevDesk: ${error.message}\n`);
  }
  const existed = await keychain.read(label).then(
    () => true,
    () => false,
  );
  await keychain.store(label, token);
  io.out(
    `${existed ? "Replaced" : "Stored"} the token${account === undefined ? "" : ` of sevDesk account ${account}`} ` +
      `under keychain label "${label}".\n` +
      `Use it with SEVDESK_API_TOKEN_KEYCHAIN=${label}, or "token": {"keychain": "${label}"} in a ` +
      "profile.\n",
  );
  return 0;
}

async function checkToken(
  label: string,
  env: Env,
  io: TokenCommandIo,
  keychain: Keychain,
  identify: IdentityLookup | undefined,
): Promise<number> {
  const lookup = identify ?? identityLookup(env);
  const token = await keychain.read(label);
  try {
    const identity = await lookup(token, AbortSignal.timeout(IDENTIFY_TIMEOUT_MS));
    io.out(`Keychain label "${label}": a valid token of sevDesk account ${identity.accountId}.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    io.err(`token: keychain label "${label}" holds a token, but: ${error.message}\n`);
    return 1;
  }
}

async function deleteToken(label: string, io: TokenCommandIo, keychain: Keychain): Promise<number> {
  if (await keychain.remove(label)) {
    io.out(`Deleted the token stored under keychain label "${label}".\n`);
    return 0;
  }
  io.err(`token: no token is stored under keychain label "${label}".\n`);
  return 1;
}

/** The identity lookup for the environment's `SEVDESK_BASE_URL` (other settings are not needed). */
function identityLookup(env: Env): IdentityLookup {
  const problems: string[] = [];
  const settings = readSettings({ SEVDESK_BASE_URL: env["SEVDESK_BASE_URL"] }, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return createIdentityLookup(settings);
}

/** The parts of a readable stream {@link readSecretInput} uses (`process.stdin` in production). */
export interface SecretInputStream {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The user ended the input with Ctrl-C, or it was longer than any token. */
export class TokenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenInputError";
  }
}

/**
 * Reads one secret line. On a terminal: writes `prompt`, switches to raw mode so nothing is
 * echoed, and returns at Enter (Backspace edits, Ctrl-C aborts). Otherwise (a pipe or file):
 * returns everything until the end of the input. Rejects with {@link TokenInputError} when the
 * input is aborted or longer than 4 KiB.
 */
export function readSecretInput(
  input: SecretInputStream,
  write: (text: string) => void,
  prompt: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const tty = input.isTTY === true && typeof input.setRawMode === "function";
    let value = "";
    let done = false;
    const finish = (error?: TokenInputError): void => {
      if (done) return;
      done = true;
      if (tty) {
        input.setRawMode?.(false);
        write("\n");
      }
      input.removeAllListeners("data");
      input.removeAllListeners("end");
      input.removeAllListeners("error");
      input.pause();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const tooLong = (): TokenInputError =>
      new TokenInputError(
        `the input is longer than ${MAX_INPUT} characters, so it is no token; nothing was stored.`,
      );

    input.setEncoding("utf8");
    if (tty) {
      write(prompt);
      input.setRawMode?.(true);
      input.on("data", (chunk) => {
        // Arrow keys and other escape sequences are not part of a token.
        for (const char of chunk.replace(ESCAPE_SEQUENCE, "")) {
          if (char === "\r" || char === "\n" || char === "\u0004") {
            finish();
            return;
          }
          if (char === "\u0003") {
            finish(new TokenInputError("cancelled; nothing was stored."));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
          } else if (char >= " ") {
            value += char;
            if (value.length > MAX_INPUT) {
              finish(tooLong());
              return;
            }
          }
        }
      });
    } else {
      input.on("data", (chunk) => {
        value += chunk;
        if (value.length > MAX_INPUT) finish(tooLong());
      });
    }
    input.on("end", () => {
      finish();
    });
    input.on("error", () => {
      finish(new TokenInputError("the token could not be read from stdin; nothing was stored."));
    });
    input.resume();
  });
}
