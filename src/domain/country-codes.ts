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

/**
 * Optional display enrichment. A failed country lookup keeps the original ids, just as a failed
 * unit-name lookup does; cancellation and unexpected programming errors still propagate.
 */
export async function loadCountryCodes(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, string>> {
  try {
    const countries = await listCountries(client, signal);
    const codes = new Map<number, string>();
    for (const country of countries.items) {
      const code = country.code?.trim().toUpperCase();
      if (code !== undefined && /^[A-Z]{2}$/.test(code)) codes.set(country.id, code);
    }
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
>(document: T, client: SevdeskClient, signal?: AbortSignal): Promise<T> {
  const countryId = document.address?.countryId;
  if (countryId === undefined) return document;
  const countries = await loadCountryCodes(client, signal);
  const country = countries.get(countryId);
  return country === undefined
    ? document
    : { ...document, address: { ...document.address, country } };
}
