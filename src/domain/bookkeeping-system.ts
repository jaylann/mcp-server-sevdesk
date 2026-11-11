/**
 * The account's bookkeeping system version (1.0, or 2.0 after sevDesk's "Update 2.0") for the
 * tool layer. The request, the parsing and the cache are the client layer's
 * (`src/sevdesk/system-version.ts`); tools reach them through this module, like every other
 * read, and not by importing the client layer (review 2026-11, round 3).
 */
import { getBookkeepingSystemVersion, type SystemVersion } from "../sevdesk/system-version.js";
import type { SevdeskClient } from "../sevdesk/types.js";

export type { SystemVersion };

/**
 * Reads the version (`GET /Tools/bookkeepingSystemVersion`), cached for 15 minutes once it
 * succeeded. The cache entry belongs to `cacheOwner`: tools pass `ctx.config`, which identifies
 * the account and lives as long as the server, so a read tool and the write tools' preparations
 * (each with its own client wrapper) share one entry.
 */
export function loadSystemVersion(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
  cacheOwner: object,
): Promise<SystemVersion> {
  return getBookkeepingSystemVersion(client, signal, { cacheOwner });
}
