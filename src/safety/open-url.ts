/**
 * Opens a local approval page in the user's browser with the operating system's opener, so the
 * page's capability URL never has to pass through the model (`SEVDESK_CONFIRM=browser`,
 * `SEVDESK_CONFIRM_OPEN`).
 *
 * The opener is spawned with an argument array (no shell parsing of the URL), detached, with all
 * output discarded, and never throws: any failure yields `false`, and the caller falls back to
 * the link it wrote to the server log.
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

/**
 * The opener command for `platform`: `open` (macOS), `cmd /c start "" <url>` (Windows; the empty
 * string is the window title `start` expects first) or `xdg-open` (everything else). Only URLs of
 * the approval server reach it: `http://127.0.0.1:<port>/approve/<base64url id>`, which contains no
 * character that `cmd` would interpret.
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

/** The default {@link OpenUrl}: the OS opener for the current platform. */
export function openInBrowser(url: string, deps: OpenInBrowserDeps = {}): Promise<boolean> {
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
