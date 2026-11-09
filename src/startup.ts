import { IdentityError, type IdentityLookup } from "./accounts/types.js";
import type { Config } from "./config.js";
import { SevdeskError } from "./sevdesk/errors.js";
import { getBookkeepingSystemVersion } from "./sevdesk/system-version.js";
import type { SevdeskClient } from "./sevdesk/types.js";

/** Upper bound for the startup check, independent of the per-request timeout. */
const STARTUP_CHECK_TIMEOUT_MS = 15_000;

export type StartupCheckResult =
  | { readonly ok: true; readonly systemVersion: "1.0" | "2.0" }
  | { readonly ok: false; readonly message: string };

/**
 * Verifies the token and reachability once at startup by reading the bookkeeping system version.
 *
 * Deliberately non-fatal: the server keeps serving so the MCP client shows actionable tool errors
 * instead of a crashed process, and works offline in tests. The outcome is reported through `log`
 * (stderr), never stdout. Never throws, never includes the token.
 */
export async function checkConnection(
  client: SevdeskClient,
  config: Pick<Config, "readOnly" | "allowedTiers" | "dryRun">,
  log: (line: string) => void,
): Promise<StartupCheckResult> {
  try {
    const systemVersion = await getBookkeepingSystemVersion(
      client,
      AbortSignal.timeout(STARTUP_CHECK_TIMEOUT_MS),
    );
    const tiers = [...config.allowedTiers].join(", ");
    log(
      `connected to sevDesk (bookkeeping system ${systemVersion}); tiers: ${tiers}` +
        (config.dryRun ? "; dry-run" : ""),
    );
    return { ok: true, systemVersion };
  } catch (error) {
    const message =
      error instanceof SevdeskError
        ? error.message
        : "unexpected error while contacting sevDesk; tools will report details when called.";
    log(`warning: startup check failed: ${message}`);
    return { ok: false, message };
  }
}

/** Upper bound for the startup account lookup (bearer mode). */
const IDENTIFY_TIMEOUT_MS = 10_000;

/**
 * Bearer mode: names the account of the configured token, so approvals and audit lines carry
 * its id. Returns `config` with `account` set, or `config` unchanged when the lookup fails (the
 * server still starts; approvals are then scoped to `bearer`). Logs one line through `log`; never
 * throws, never includes the token (`IdentityError` messages are fixed text).
 */
export async function identifyAccount(
  config: Config,
  lookup: IdentityLookup,
  log: (line: string) => void,
): Promise<Config> {
  try {
    const identity = await lookup(config.token, AbortSignal.timeout(IDENTIFY_TIMEOUT_MS));
    log(`serving sevDesk account ${identity.accountId}`);
    return { ...config, account: { id: identity.accountId } };
  } catch (error) {
    const message =
      error instanceof IdentityError
        ? error.message
        : "unexpected error during the account lookup.";
    log(`warning: could not identify the sevDesk account: ${message}`);
    return config;
  }
}
