/**
 * Finds the sevDesk account behind an API token: the consent page and the approvals login use it
 * to check a pasted token against the account allowlist, the token endpoint re-checks a grant's
 * token on refresh, and bearer mode names its account at startup.
 *
 * Source: `GET /SevClient` (undocumented, recorded 2026-11-08: one object, or a list whose first
 * row wins, as `account-settings.ts` reads it) for the account id and company name. A token whose
 * user may not read the account settings (403) still identifies its account through its users:
 * `GET /SevUser` rows carry `sevClient: {id, objectName: "SevClient"}` (recorded 2026-02-19).
 *
 * Each lookup has its own read-only client and one overall time budget (8 s by default, retries
 * included). Rejects only with {@link IdentityError}, whose messages are fixed, trusted text: the
 * token is never logged, echoed or put into an error.
 */
import { z } from "zod";

import type { Settings } from "../config.js";
import { cleanText } from "../domain/common.js";
import { createSevdeskClient, type SevdeskClientDeps } from "../sevdesk/client.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { zId, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { type AccountIdentity, IdentityError, type IdentityLookup } from "./types.js";

export interface IdentityLookupDeps extends Pick<
  SevdeskClientDeps,
  "fetch" | "sleep" | "now" | "monotonicNow" | "random"
> {
  /** Budget of one lookup, retries included (default 8 s). */
  readonly timeoutMs?: number;
  /** Creates the budget signal (default `AbortSignal.timeout`); tests abort it by hand. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** Company names are shown on the consent page; longer ones are cut. */
const NAME_MAX = 200;
/** Anything a header can carry without whitespace; real tokens are 32 hex characters. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;

const sevClientSchema = z.object({ id: zId, name: zText.catch(undefined) });
const sevUserSchema = z.object({ sevClient: z.object({ id: zId }) });

const MESSAGES = {
  malformed:
    "This is not a sevDesk API token. Paste only the token itself (32 characters from sevDesk " +
    "under Settings → Users → API token), without spaces or a 'Bearer ' prefix.",
  rejected:
    "sevDesk rejected this API token (HTTP 401). Check that you copied the whole token from " +
    "sevDesk (Settings → Users → API token) and that it is still valid.",
  forbidden:
    "sevDesk accepted this API token but did not reveal its account (HTTP 403). Use the token of " +
    "a sevDesk user who may see the account settings or the user list (ideally an administrator).",
  unreachable:
    "Could not reach sevDesk to check the API token (network error, timeout or rate limit). Try " +
    "again in a moment.",
  unexpected:
    "sevDesk answered the account check in an unexpected format, so the account could not be " +
    "identified. Try again later; if it keeps failing, report it at " +
    "https://github.com/jaylann/mcp-server-sevdesk/issues.",
} as const;

/** Creates the lookup for `settings.baseUrl` (see the module comment). */
export function createIdentityLookup(
  settings: Pick<Settings, "baseUrl" | "userAgent" | "requestsPerSecond">,
  deps: IdentityLookupDeps = {},
): IdentityLookup {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const { timeoutMs: _budget, timeoutSignal: _signal, ...clientDeps } = deps;
  return async (token, signal) => {
    if (!TOKEN_SHAPE.test(token) || /^bearer$/i.test(token)) {
      throw new IdentityError("unauthorized", MESSAGES.malformed);
    }
    const client = createSevdeskClient(
      {
        token,
        baseUrl: settings.baseUrl,
        allowedTiers: new Set(["read"]),
        readOnly: true,
        dryRun: false,
        requestsPerSecond: settings.requestsPerSecond,
        timeoutMs,
        userAgent: settings.userAgent,
      },
      clientDeps,
    );
    const budget = AbortSignal.any([signal, timeoutSignal(timeoutMs)]);
    try {
      return await identify(client, budget);
    } catch (error) {
      throw identityError(error);
    }
  };
}

async function identify(client: SevdeskClient, signal: AbortSignal): Promise<AccountIdentity> {
  let payload: unknown;
  try {
    payload = await client.request({ method: "GET", path: "/SevClient", signal });
  } catch (error) {
    if (isForbidden(error)) return { accountId: await accountOfUsers(client, signal) };
    throw error;
  }
  const row: unknown = Array.isArray(payload) ? (payload as unknown[])[0] : payload;
  const parsed = sevClientSchema.safeParse(row);
  if (!parsed.success) throw new IdentityError("unexpected", MESSAGES.unexpected);
  const name = cleanText(parsed.data.name, NAME_MAX);
  return { accountId: String(parsed.data.id), ...(name === undefined ? {} : { name }) };
}

/** The account id from the token's users (`GET /SevUser`), for tokens refused `/SevClient`. */
async function accountOfUsers(client: SevdeskClient, signal: AbortSignal): Promise<string> {
  let page;
  try {
    page = await client.list("/SevUser", undefined, { limit: 1, signal });
  } catch (error) {
    if (isForbidden(error)) throw new IdentityError("unauthorized", MESSAGES.forbidden);
    throw error;
  }
  const parsed = sevUserSchema.safeParse(page.items[0]);
  if (!parsed.success) throw new IdentityError("unexpected", MESSAGES.unexpected);
  return String(parsed.data.sevClient.id);
}

function isForbidden(error: unknown): boolean {
  return error instanceof SevdeskError && error.kind === "auth" && error.status === 403;
}

/** Maps any failure to an {@link IdentityError} with fixed text (never the upstream message). */
function identityError(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error;
  if (error instanceof SevdeskError) {
    switch (error.kind) {
      case "auth":
        return new IdentityError("unauthorized", MESSAGES.rejected);
      case "network":
      case "timeout":
      case "rate_limited":
      case "server":
      case "aborted":
        return new IdentityError("unreachable", MESSAGES.unreachable);
      default:
        return new IdentityError("unexpected", MESSAGES.unexpected);
    }
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new IdentityError("unreachable", MESSAGES.unreachable);
  }
  return new IdentityError("unexpected", MESSAGES.unexpected);
}
