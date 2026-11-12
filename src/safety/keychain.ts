/**
 * The sevDesk API token in the operating system's keychain, so a local (stdio) install needs the
 * token neither in an MCP client's config file nor in a file on disk
 * (`SEVDESK_API_TOKEN_KEYCHAIN=<label>`, `mcp-server-sevdesk token set|check|delete <label>`).
 *
 * | Platform        | Read                                        | Store                              |
 * | --------------- | ------------------------------------------- | ---------------------------------- |
 * | macOS           | `/usr/bin/security find-generic-password -w` | `security -i`, command on stdin   |
 * | Linux and other | `secret-tool lookup` (libsecret)             | `secret-tool store`, token on stdin |
 * | Windows         | Windows PowerShell / WinRT PasswordVault    | token on stdin                     |
 *
 * Rules:
 * - Every item lives under the fixed service {@link KEYCHAIN_SERVICE}; configuration names only
 *   the label (the item's account), which must match `LOCAL_NAME`. A hostile configuration
 *   therefore cannot make the server read some other keychain item (a GitHub token, a password)
 *   and send it to a custom `SEVDESK_BASE_URL`.
 * - The helper is spawned with an argument array, never through a shell. When storing, the token
 *   travels on the helper's stdin, never in its argv (which other local users can see in the
 *   process list). On macOS that stdin line is parsed by `security -i`, so only tokens of
 *   `[A-Za-z0-9_-]` are stored (sevDesk tokens are hex), and no quoting is ever needed.
 * - stdout is capped at 4 KiB, stderr is discarded, and the helper is killed after a timeout.
 * - Errors ({@link KeychainError}) are fixed texts chosen by exit code. The helper's output, which
 *   may contain the token, is never echoed, logged or attached as a cause.
 *
 * What this protects: the token at rest (no plain-text config file that is synced, backed up,
 * committed or shown on screen). It does not protect against code that already runs as the same
 * user: such code may run the same helper (on macOS the item trusts `/usr/bin/security`, which
 * created it, so reading it shows no dialog).
 */
import { type ChildProcess, spawn as spawnProcess, type SpawnOptions } from "node:child_process";
import { win32 } from "node:path";

import { z } from "zod";

import { localNameProblem, sevdeskTokenProblem } from "../config.js";

/** The keychain service (macOS) or `service` attribute (libsecret) of every item. */
export const KEYCHAIN_SERVICE = "mcp-server-sevdesk";

/** Default time a helper may take; a person may have to answer a keychain dialog. */
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 15_000;

/** More than a token ever needs; a helper printing more is stopped. */
const MAX_OUTPUT_BYTES = 4 * 1024;

/** What may be stored: needs no quoting on the `security -i` command line. */
const STORABLE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

const SECURITY = "/usr/bin/security";
const SECRET_TOOL = "secret-tool";

const WINDOWS_ROOT = z
  .string()
  .regex(/^[A-Za-z]:\\[^<>:"|?*/\p{Cc}]+$/u)
  .refine((value) =>
    value
      .split("\\")
      .slice(1)
      .every((part) => part !== "" && !/[. ]$/.test(part)),
  );

/** Private exit protocol of WINDOWS_SCRIPT, never PowerShell's error text. */
const WINDOWS_EXIT = { notFound: 2, denied: 3, unavailable: 4, invalid: 5 } as const;

/**
 * Constant code: operation, label and token are three ASCII lines on stdin, never script text.
 * FullLanguage is required: avoiding Add-Type does not make WinRT types available under CLM.
 * No execution-policy override, profile, dynamic code, or enumeration of unrelated credentials.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 4 }
try {
  $operation = [Console]::ReadLine()
  $label = [Console]::ReadLine()
  $token = [Console]::ReadLine()
  if ($operation -cnotmatch '\A(read|store|delete)\z' -or
      $label -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\z' -or
      $label -match '\A[0-9a-f]{32}\z' -or
      [Console]::In.ReadToEnd() -ne '') { exit 5 }
  if ($operation -eq 'store') {
    if ($token -cnotmatch '\A[A-Za-z0-9_-]{1,512}\z') { exit 5 }
  } elseif ($token -ne '') { exit 5 }
  $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
  switch ($operation) {
    'read' {
      $credential = $vault.Retrieve('mcp-server-sevdesk', $label)
      $credential.RetrievePassword()
      [Console]::WriteLine('TOKEN:' + $credential.Password)
    }
    'store' {
      $credential = [Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new('mcp-server-sevdesk', $label, $token)
      $vault.Add($credential)
      [Console]::WriteLine('OK')
    }
    'delete' {
      $credential = $vault.Retrieve('mcp-server-sevdesk', $label)
      $vault.Remove($credential)
      [Console]::WriteLine('OK')
    }
  }
  exit 0
} catch {
  $exception = $_.Exception
  while ($null -ne $exception) {
    if ($exception.HResult -eq -2147023728) { exit 2 }
    if ($exception.HResult -eq -2147024891) { exit 3 }
    $exception = $exception.InnerException
  }
  exit 1
}
`;

/** `security` exits with the low byte of the OSStatus. */
const MAC_EXIT = {
  /** errSecItemNotFound (-25300). */
  notFound: 44,
  /** errSecInteractionNotAllowed (-25308): locked, and no dialog possible (e.g. over SSH). */
  interactionNotAllowed: 36,
  /** errSecAuthFailed (-25293). */
  authFailed: 51,
  /** userCanceledErr (-128): "Deny" in the dialog. */
  userCanceled: 128,
} as const;

export type KeychainErrorKind =
  "not_found" | "unsupported" | "unavailable" | "denied" | "timeout" | "invalid" | "failed";

/** Why a keychain operation failed. Messages are fixed, trusted text without the token. */
export class KeychainError extends Error {
  readonly kind: KeychainErrorKind;

  constructor(kind: KeychainErrorKind, message: string) {
    super(message);
    this.name = "KeychainError";
    this.kind = kind;
  }
}

/** The OS keychain, restricted to items of {@link KEYCHAIN_SERVICE}. */
export interface Keychain {
  /**
   * The token stored under `label`, checked with `sevdeskTokenProblem`. Rejects with
   * {@link KeychainError} (`not_found` when there is none).
   */
  read(label: string): Promise<string>;
  /** Stores or replaces the token under `label`, then reads it back to confirm. */
  store(label: string, token: string): Promise<void>;
  /** Deletes the token under `label`; resolves `false` when there was none. */
  remove(label: string): Promise<boolean>;
}

/** The subset of `child_process.spawn` the keychain uses. */
export type KeychainSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface KeychainDeps {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `child_process.spawn`. Tests inject a fake; they never run the real helpers. */
  readonly spawn?: KeychainSpawn;
  /** Per helper run (default {@link DEFAULT_KEYCHAIN_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Windows installation directory; defaults to the inherited SystemRoot, never PATH or cwd. */
  readonly systemRoot?: string;
}

/** One helper run: the program, its arguments, and what to write to its stdin. */
interface KeychainCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin, which is then closed. Secret when storing: never log it. */
  readonly input?: string;
}

interface Commands {
  readonly platform: "macos" | "secret-service" | "windows";
  lookup(label: string): KeychainCommand;
  store(label: string, token: string): KeychainCommand;
  /** macOS deletes directly; libsecret's `clear` does not report whether anything matched. */
  remove(label: string): KeychainCommand;
}

/** The helper commands for `platform`; exported for tests and documentation. */
export function keychainCommands(
  platform: NodeJS.Platform,
  systemRoot: string | undefined = process.env["SystemRoot"],
): Commands {
  if (platform === "win32") {
    // Require a local, drive-absolute installation directory. No relative/UNC/device paths,
    // traversal or fallback to a bare executable name. SystemRoot is trusted OS configuration.
    const root = WINDOWS_ROOT.safeParse(systemRoot);
    if (!root.success) {
      throw new KeychainError(
        "unavailable",
        "Windows Credential Manager needs SystemRoot to name the absolute Windows installation " +
          "directory. Restore that environment variable, or use SEVDESK_API_TOKEN_FILE.",
      );
    }
    const command = win32.join(
      root.data,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT];
    return {
      platform: "windows",
      lookup: (label) => ({ command, args, input: `read\n${label}\n\n` }),
      store: (label, token) => ({ command, args, input: `store\n${label}\n${token}\n` }),
      remove: (label) => ({ command, args, input: `delete\n${label}\n\n` }),
    };
  }
  if (platform === "darwin") {
    return {
      platform: "macos",
      lookup: (label) => ({
        command: SECURITY,
        args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", label, "-w"],
      }),
      store: (label, token) => ({
        command: SECURITY,
        args: ["-i"],
        input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${label} -w ${token}\n`,
      }),
      remove: (label) => ({
        command: SECURITY,
        args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", label],
      }),
    };
  }
  return {
    platform: "secret-service",
    lookup: (label) => ({
      command: SECRET_TOOL,
      args: ["lookup", "service", KEYCHAIN_SERVICE, "account", label],
    }),
    store: (label, token) => ({
      command: SECRET_TOOL,
      args: [
        "store",
        `--label=${KEYCHAIN_SERVICE} (${label})`,
        "service",
        KEYCHAIN_SERVICE,
        "account",
        label,
      ],
      // No trailing newline: secret-tool stores everything it reads from a pipe.
      input: token,
    }),
    remove: (label) => ({
      command: SECRET_TOOL,
      args: ["clear", "service", KEYCHAIN_SERVICE, "account", label],
    }),
  };
}

/** Creates the keychain for the current (or injected) platform. */
export function createKeychain(deps: KeychainDeps = {}): Keychain {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? spawnProcess;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
  const systemRoot = deps.systemRoot ?? process.env["SystemRoot"];
  const exec = (command: KeychainCommand): Promise<RunResult> => run(spawn, command, timeoutMs);

  async function read(label: string): Promise<string> {
    const commands = prepare(platform, label, systemRoot);
    const result = await exec(commands.lookup(label));
    if (result.kind !== "exit") throw runFailure(result, commands, label);
    if (result.code !== 0) throw exitFailure("read", result.code, commands, label);
    const token =
      commands.platform === "windows" ? windowsToken(result.stdout) : result.stdout.trim();
    if (token === "") throw notFound(commands, label);
    const problem = sevdeskTokenProblem(token, `The token stored under keychain label "${label}"`);
    if (problem !== undefined) {
      throw new KeychainError(
        "invalid",
        `${problem} Store it again with \`mcp-server-sevdesk token set ${label}\`.`,
      );
    }
    return token;
  }

  async function store(label: string, token: string): Promise<void> {
    const commands = prepare(platform, label, systemRoot);
    if (!STORABLE_TOKEN.test(token)) {
      throw new KeychainError(
        "invalid",
        "Only tokens made of letters, digits, '_' and '-' can be stored (a sevDesk API token is " +
          "32 hex characters). Paste only the token itself.",
      );
    }
    const result = await exec(commands.store(label, token));
    if (result.kind !== "exit") throw runFailure(result, commands, label);
    if (result.code !== 0) throw exitFailure("store", result.code, commands, label);
    if (commands.platform === "windows") windowsAck(result.stdout);
    let stored: string;
    try {
      stored = await read(label);
    } catch {
      stored = "";
    }
    if (stored !== token) {
      throw new KeychainError(
        "failed",
        `The keychain did not keep the token under label "${label}" (reading it back failed). ` +
          "Try again; if it keeps failing, use SEVDESK_API_TOKEN_FILE instead.",
      );
    }
  }

  async function remove(label: string): Promise<boolean> {
    const commands = prepare(platform, label, systemRoot);
    if (commands.platform === "secret-service") {
      // `secret-tool clear` succeeds whether or not an item matched: look first.
      const found = await exec(commands.lookup(label));
      if (found.kind !== "exit") throw runFailure(found, commands, label);
      if (found.code !== 0 || found.stdout.trim() === "") return false;
    }
    const result = await exec(commands.remove(label));
    if (result.kind !== "exit") throw runFailure(result, commands, label);
    if (result.code === 0) {
      if (commands.platform === "windows") windowsAck(result.stdout);
      return true;
    }
    if (commands.platform === "macos" && result.code === MAC_EXIT.notFound) return false;
    if (commands.platform === "windows" && result.code === WINDOWS_EXIT.notFound) return false;
    throw exitFailure("delete", result.code, commands, label);
  }

  return { read, store, remove };
}

/** Validates the label (a programming error in callers, which validate first) and the platform. */
function prepare(
  platform: NodeJS.Platform,
  label: string,
  systemRoot: string | undefined,
): Commands {
  const problem = localNameProblem(label, "The keychain label");
  if (problem !== undefined) throw new KeychainError("invalid", problem);
  return keychainCommands(platform, systemRoot);
}

/** A successful helper must return exactly one protocol line, with no diagnostics or extra data. */
function windowsToken(output: string): string {
  const token = /^TOKEN:([A-Za-z0-9_-]{1,512})\r?\n$/.exec(output)?.[1];
  if (token === undefined) throw malformedWindowsOutput();
  return token;
}

function windowsAck(output: string): void {
  if (output !== "OK\r\n" && output !== "OK\n") throw malformedWindowsOutput();
}

function malformedWindowsOutput(): KeychainError {
  return new KeychainError("invalid", "Windows Credential Manager returned an invalid response.");
}

function notFound(commands: Commands, label: string): KeychainError {
  return new KeychainError(
    "not_found",
    commands.platform !== "secret-service"
      ? `No token is stored under keychain label "${label}". Store one with ` +
          `\`mcp-server-sevdesk token set ${label}\`.`
      : `No token is stored under keychain label "${label}", or the Secret Service (GNOME ` +
          "Keyring, KWallet) is locked or not running. Unlock it, or store a token with " +
          `\`mcp-server-sevdesk token set ${label}\`.`,
  );
}

function exitFailure(
  operation: "read" | "store" | "delete",
  code: number,
  commands: Commands,
  label: string,
): KeychainError {
  if (commands.platform === "windows") {
    switch (code) {
      case WINDOWS_EXIT.notFound:
        return notFound(commands, label);
      case WINDOWS_EXIT.denied:
        return new KeychainError(
          "denied",
          "Windows Credential Manager refused access. Check your Windows account and credential " +
            "access policy, or use SEVDESK_API_TOKEN_FILE.",
        );
      case WINDOWS_EXIT.unavailable:
        return new KeychainError(
          "unavailable",
          "Windows Credential Manager requires Windows PowerShell in FullLanguage mode; " +
            "Constrained Language Mode cannot use PasswordVault. Use SEVDESK_API_TOKEN_FILE " +
            "or the Claude Desktop .mcpb bundle instead.",
        );
      case WINDOWS_EXIT.invalid:
        return new KeychainError("invalid", "The Windows keychain helper refused its input.");
    }
    return new KeychainError(
      "failed",
      `Windows Credential Manager could not ${operation} the token (PowerShell exited with ${code}). ` +
        "Check that Windows PowerShell and PasswordVault are available for your Windows account, " +
        "or use SEVDESK_API_TOKEN_FILE.",
    );
  }
  if (commands.platform === "macos") {
    switch (code) {
      case MAC_EXIT.notFound:
        return notFound(commands, label);
      case MAC_EXIT.userCanceled:
      case MAC_EXIT.authFailed:
        return new KeychainError(
          "denied",
          "The macOS keychain refused access (the dialog was denied or the password was wrong). " +
            "Try again and choose Allow.",
        );
      case MAC_EXIT.interactionNotAllowed:
        return new KeychainError(
          "unavailable",
          "The macOS keychain is locked and cannot ask for its password here (for example over " +
            "SSH). Unlock it with `security unlock-keychain` and try again.",
        );
    }
    return new KeychainError(
      "failed",
      `The macOS keychain could not ${operation} the token (security exited with ${code}).`,
    );
  }
  if (operation === "read" && code === 1) return notFound(commands, label);
  return new KeychainError(
    "failed",
    `secret-tool could not ${operation} the token (exit code ${code}). Check that a Secret ` +
      "Service (GNOME Keyring, KWallet) is running and unlocked.",
  );
}

function runFailure(
  result: Exclude<RunResult, { kind: "exit" }>,
  commands: Commands,
  label: string,
): KeychainError {
  switch (result.kind) {
    case "missing":
      if (commands.platform === "windows") {
        return new KeychainError(
          "unavailable",
          "Windows PowerShell was not found in SystemRoot\\System32\\WindowsPowerShell\\v1.0. " +
            "Windows Credential Manager requires Windows PowerShell; use SEVDESK_API_TOKEN_FILE " +
            "or the Claude Desktop .mcpb bundle instead.",
        );
      }
      return new KeychainError(
        "unavailable",
        commands.platform === "macos"
          ? `${SECURITY} was not found, so the macOS keychain cannot be used. Set ` +
              "SEVDESK_API_TOKEN_FILE instead."
          : "secret-tool was not found. Install it (Debian/Ubuntu: `sudo apt install " +
              "libsecret-tools`, Fedora: `sudo dnf install libsecret`, Arch: `sudo pacman -S " +
              "libsecret`) with a Secret Service such as GNOME Keyring or KWallet, or set " +
              "SEVDESK_API_TOKEN_FILE instead.",
      );
    case "timeout":
      return new KeychainError(
        "timeout",
        "The keychain did not answer in time. If a dialog asks for access, allow it and try " +
          "again; on Linux, check that the Secret Service is running and unlocked.",
      );
    case "overflow":
      return new KeychainError(
        "failed",
        `The keychain returned more than a token for label "${label}", so nothing was used. ` +
          `Store the token again with \`mcp-server-sevdesk token set ${label}\`.`,
      );
    case "failed":
      return new KeychainError("failed", "The keychain helper could not be run.");
  }
}

type RunResult =
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string }
  | { readonly kind: "missing" }
  | { readonly kind: "timeout" }
  | { readonly kind: "overflow" }
  | { readonly kind: "failed" };

/**
 * Runs one helper without a shell. Resolves (never rejects) once it closed, failed to start, was
 * killed after `timeoutMs`, or printed more than {@link MAX_OUTPUT_BYTES}.
 */
function run(
  spawn: KeychainSpawn,
  { command, args, input }: KeychainCommand,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve(isMissing(error) ? { kind: "missing" } : { kind: "failed" });
      return;
    }
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (result: RunResult): void => {
      child.kill("SIGKILL");
      finish(result);
    };
    const timer = setTimeout(() => {
      stop({ kind: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        stop({ kind: "overflow" });
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => {
      finish(isMissing(error) ? { kind: "missing" } : { kind: "failed" });
    });
    child.once("close", (code: number | null) => {
      finish(
        code === null
          ? { kind: "failed" }
          : { kind: "exit", code, stdout: Buffer.concat(chunks).toString("utf8") },
      );
    });
    if (input !== undefined) {
      // A helper that exits early closes the pipe; the write error is not ours to report.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
