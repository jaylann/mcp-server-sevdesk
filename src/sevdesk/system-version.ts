/**
 * sevDesk "Update 2.0" detection. Accounts moved from the legacy bookkeeping system (1.0:
 * `taxType` on documents, `accountingType` on positions) to 2.0 (`taxRule`, `accountDatev`). The
 * account-level version decides how new documents must be written, but one account can still hold
 * objects of both generations, so reads detect the generation per object.
 */
import { expectSingle } from "./envelope.js";
import { SevdeskError } from "./errors.js";
import type { SevdeskClient } from "./types.js";

export type SystemVersion = "1.0" | "2.0";

const cache = new WeakMap<SevdeskClient, SystemVersion>();

/**
 * The account's bookkeeping system version from `GET /Tools/bookkeepingSystemVersion`, memoized
 * per client instance once it succeeded (failures are not cached). Throws an
 * `unexpected_response` error for any value other than 1.0 or 2.0 rather than guessing.
 */
export async function getBookkeepingSystemVersion(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<SystemVersion> {
  const cached = cache.get(client);
  if (cached !== undefined) return cached;

  const payload = await client.request({
    method: "GET",
    path: "/Tools/bookkeepingSystemVersion",
    ...(signal === undefined ? {} : { signal }),
  });
  const record = expectSingle(payload, "bookkeeping system version");
  const version = parseSystemVersion((record as Record<string, unknown>)["version"]);
  cache.set(client, version);
  return version;
}

/** Normalizes `"2.0"`, `"2"`, `2` (and the 1.0 equivalents); throws for anything else. */
export function parseSystemVersion(value: unknown): SystemVersion {
  if (value === "1.0" || value === "1" || value === 1) return "1.0";
  if (value === "2.0" || value === "2" || value === 2) return "2.0";
  throw new SevdeskError({
    kind: "unexpected_response",
    message:
      "sevDesk reported an unknown bookkeeping system version (expected 1.0 or 2.0). " +
      "This server does not know how to write to such an account.",
  });
}

/**
 * Generation of a document record (invoice, voucher, credit note, order): `"2.0"` when it
 * carries a `taxRule`, `"1.0"` when it has a `taxType` but no `taxRule`, else `undefined`.
 */
export function detectGeneration(record: unknown): SystemVersion | undefined {
  if (hasValue(record, "taxRule")) return "2.0";
  if (hasValue(record, "taxType")) return "1.0";
  return undefined;
}

/**
 * Generation of a position (voucher/invoice position): `"2.0"` when it carries an
 * `accountDatev`, `"1.0"` when it has an `accountingType` but no `accountDatev`, else
 * `undefined`.
 */
export function detectPositionGeneration(position: unknown): SystemVersion | undefined {
  if (hasValue(position, "accountDatev")) return "2.0";
  if (hasValue(position, "accountingType")) return "1.0";
  return undefined;
}

/** Whether `record[key]` is present and not `null`/`""` (sevDesk sends `null` for unset refs). */
function hasValue(record: unknown, key: string): boolean {
  if (typeof record !== "object" || record === null) return false;
  const value: unknown = (record as Record<string, unknown>)[key];
  return value !== undefined && value !== null && value !== "";
}
