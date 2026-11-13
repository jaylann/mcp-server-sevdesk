/** ISO country codes for output addresses, resolved from the same table as country inputs. */
import { z } from "zod";

import { SevdeskError } from "../sevdesk/errors.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { listCountries } from "./reference-data.js";

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .optional()
  .describe("ISO 3166-1 alpha-2 country code; absent when the country cannot be resolved.");

const COUNTRY_CODES_TTL_MS = 15 * 60_000;

interface CountryCodesCacheOptions {
  /**
   * Tools pass `ctx.config`: it identifies the account and is shared by prepare and execute,
   * unlike their differently wrapped clients. Defaults to the client instance.
   */
  readonly cacheOwner?: object | undefined;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

const cache = new WeakMap<object, { expires: number; value: ReadonlyMap<number, string> }>();

/**
 * Optional display enrichment. A failed country lookup keeps the original ids, just as a failed
 * unit-name lookup does; cancellation and unexpected programming errors still propagate.
 * Successful reads are cached per owner for 15 minutes; the empty failure fallback is not.
 */
export async function loadCountryCodes(
  client: SevdeskClient,
  signal?: AbortSignal,
  options: CountryCodesCacheOptions = {},
): Promise<ReadonlyMap<number, string>> {
  const owner = options.cacheOwner ?? client;
  const now = options.now ?? Date.now;
  const hit = cache.get(owner);
  if (hit !== undefined && hit.expires > now()) return hit.value;
  try {
    const countries = await listCountries(client, signal);
    const codes = new Map<number, string>();
    for (const country of countries.items) {
      const code = country.code?.trim().toUpperCase();
      if (code !== undefined && /^[A-Z]{2}$/.test(code)) codes.set(country.id, code);
    }
    cache.set(owner, { expires: now() + COUNTRY_CODES_TTL_MS, value: codes });
    return codes;
  } catch (error) {
    if (!(error instanceof SevdeskError) || error.kind === "aborted") throw error;
    return new Map();
  }
}

interface CountryAddress {
  readonly countryId?: number | undefined;
  readonly country?: string | undefined;
}

/** Enrich a document's address without adding an address when none was returned. */
export async function withDocumentCountry<
  T extends { readonly address?: CountryAddress | undefined },
>(
  document: T,
  client: SevdeskClient,
  signal?: AbortSignal,
  cacheOwner: object = client,
): Promise<T> {
  const countryId = document.address?.countryId;
  if (countryId === undefined) return document;
  const countries = await loadCountryCodes(client, signal, { cacheOwner });
  const country = countries.get(countryId);
  return country === undefined
    ? document
    : { ...document, address: { ...document.address, country } };
}
