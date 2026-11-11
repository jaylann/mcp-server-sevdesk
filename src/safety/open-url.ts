/**
 * Opens a local approval page in the user's browser with the operating system's opener, so the
 * link never has to pass through the model (`SEVDESK_CONFIRM=browser`, `SEVDESK_CONFIRM_OPEN`).
 *
 * The opener is spawned with an argument array (no shell parsing of the URL), detached, with all
 * output discarded, and never throws: any failure yields `false`, and the caller falls back to
 * the link it wrote to the server log.
 *
 * A command line is readable by other local users (`ps`, `/proc/<pid>/cmdline`). So the only URL
 * that may reach the opener is a launch link, `http://127.0.0.1:<port>/open/<ticket>`, whose
 * ticket works once (`approval-local.ts`); the address of the approval page itself is refused
 * here (review 2026-11, round 3).
 */
import { type ChildProcess, spawn as spawnProcess, type SpawnOptions } from "node:child_process";

/** Opens `url`; resolves `true` when the opener started without reporting an error. */
export type OpenUrl = (url: string) => Promise<boolean>;

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface OpenInBrowserDeps {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `child_process.spawn`. */
  readonly spawn?: Spawn;
  /**
   * How long to wait for the opener to exit. Openers that are still running then (some
   * `xdg-open` setups wait for the browser) count as started.
   */
  readonly settleMs?: number;
}

const DEFAULT_SETTLE_MS = 3_000;

/** A launch link of the local approval server: the one shape {@link openInBrowser} opens. */
const LAUNCH_LINK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/open\/[A-Za-z0-9_-]{43}$/;

/**
 * The opener command for `platform`: `open` (macOS), `cmd /c start "" <url>` (Windows; the empty
 * string is the window title `start` expects first) or `xdg-open` (everything else). Only launch
 * links reach it ({@link LAUNCH_LINK}): `http://127.0.0.1:<port>/open/<base64url ticket>`, which
 * contains no character that `cmd` would interpret.
 */
export function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: readonly string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", '""', url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * The default {@link OpenUrl}: the OS opener for the current platform. Resolves `false` without
 * starting anything for a URL that is not a launch link, so neither a page address (a standing
 * capability) nor anything `cmd` could interpret ends up on a command line.
 */
export function openInBrowser(url: string, deps: OpenInBrowserDeps = {}): Promise<boolean> {
  if (!LAUNCH_LINK.test(url)) return Promise.resolve(false);
  const { command, args } = openerCommand(deps.platform ?? process.platform, url);
  const spawn = deps.spawn ?? spawnProcess;
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: command === "cmd",
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      resolve(true);
    }, deps.settleMs ?? DEFAULT_SETTLE_MS);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.unref();
  });
}
