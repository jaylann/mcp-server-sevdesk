/**
 * Where the customers and suppliers of an audit are established, from what sevDesk stores about
 * them: the VAT id (USt-IdNr.) of the contact and the countries of its addresses.
 *
 * Reads ({@link loadPartyDirectory}). Instead of one request per contact, the contact list
 * (`GET /Contact` with `depth=1`, as `sevdesk_contacts_search` reads it) and the address list
 * (`GET /ContactAddress` without a contact filter) are read once each, page by page up to
 * {@link REPORT_SCAN_MAX} rows: a few requests for a typical account however many contacts the
 * period touches, and no dependence on the undocumented contact filter of the address list
 * (D-032). Country ids become ISO codes through the StaticCountry table (`loadCountryCodes`).
 *
 * Classification ({@link locate}):
 * - **Germany**: a German VAT id (registered for VAT in Germany) or an address in Germany (which
 *   can be a German establishment; a business with one is not "established abroad" for § 13b,
 *   § 13b Abs. 7 UStG).
 * - **Abroad**: a VAT id of another state or an address outside Germany. Where abroad comes from
 *   the VAT id prefix when there is one (EL is Greece, XI Northern Ireland, EU a business from
 *   outside the EU in the non-Union OSS scheme), else from the address countries when they agree.
 *   The member states are those of the shared table (`src/domain/vat/eu.ts`); Monaco counts as
 *   France, as in the tax-rule helper (§ 1 Abs. 2a Satz 2 UStG).
 * - A contact with neither is not judged; one with both is judged only where the German data
 *   settles the question (the checks say which).
 * - A contact with an address whose country cannot be resolved (the country table could not be
 *   read, or it lacks the id) is marked `countriesUnknown`: that address might be German, so the
 *   checks do not judge where it is established.
 * - When a list stops at its cap, what sevDesk holds is incomplete: contacts beyond the contact
 *   list's cap are unknown, and beyond the address list's cap any contact may lack addresses. More
 *   data can only add a German or a foreign location, so the checks keep what such a contact's
 *   data already settles and do not judge what its missing data could change.
 *
 * A VAT id must look like one (two letters, then at least one digit), so text such as "keine"
 * typed into the field is not read as a country. Where a party is established, the prefix decides
 * whether the number is in its state's format or not; whether a customer's VAT id allows an
 * intra-EU sale is a stricter question ({@link customerVatIdOf}).
 */
import type { SevdeskClient } from "../../../sevdesk/types.js";
import { listContactAddressLocations, searchContacts } from "../../contacts.js";
import { loadCountryCodes } from "../../country-codes.js";
import { euMemberStateByVatPrefix, isEuMemberState, vatCountryOf } from "../../vat/eu.js";
import { checkVatIdFormat, type VatIdFormatCheck } from "../../vat/vat-id.js";
import { normalizeVatId } from "../positions-scan.js";
import { REPORT_SCAN_MAX, type ReportRunOptions, scanPages } from "../shared.js";

/** Where a party established abroad is: the EU, Northern Ireland (EU rules for goods only), outside. */
export type PartyArea = "eu" | "northern_ireland" | "non_eu";

/** What a VAT id's prefix says: Germany, or an area abroad. */
type VatIdArea = "germany" | PartyArea;

/** The country part of a VAT id: two letters followed by at least one digit. */
const VAT_ID_SHAPE = /^([A-Z]{2})[A-Z0-9+*]*\d[A-Z0-9+*]*$/;

/** The prefix of Northern Ireland's VAT ids (EU rules for goods, Windsor Framework). */
const NORTHERN_IRELAND = "XI";

/**
 * The area a normalized VAT id belongs to; `undefined` when it does not look like a VAT id. Only
 * the prefix counts: EL is Greece, and so is GR, which Greek numbers should not carry (they are
 * in the wrong format, see {@link customerVatIdOf}) but which never means outside the EU.
 */
export function vatIdArea(vatId: string | undefined): VatIdArea | undefined {
  const prefix = vatId === undefined ? undefined : VAT_ID_SHAPE.exec(vatId)?.[1];
  if (prefix === undefined) return undefined;
  if (prefix === "DE") return "germany";
  if (prefix === NORTHERN_IRELAND) return "northern_ireland";
  if (prefix === "GR") return "eu";
  return euMemberStateByVatPrefix(prefix) === undefined ? "non_eu" : "eu";
}

/**
 * What a customer's VAT id shows for a sale, judged as the tax-rule helper judges it (only a
 * number in the valid format of a member state, or of Northern Ireland, shows one):
 * `eu` a valid VAT id of another member state, `northern_ireland` a valid XI number, `germany` a
 * valid German one, `wrong_format` such a prefix (GR included) with the wrong characters,
 * `non_eu` another country's number, `unreadable` no VAT id at all, `none` nothing stored.
 */
export type CustomerVatId =
  "none" | "germany" | "eu" | "northern_ireland" | "wrong_format" | "non_eu" | "unreadable";

/**
 * Classifies a normalized VAT id with the shared format check (`checkVatIdFormat`). A trailing EX
 * (the EU small-business scheme, see {@link PartyLocation.smallBusinessScheme}) is not part of
 * any state's format: the number is checked without it.
 */
export function customerVatIdOf(vatId: string | undefined): CustomerVatId {
  if (vatId === undefined) return "none";
  const check = formatCheck(vatId);
  switch (check.status) {
    case "valid_format":
      if (check.country === "DE") return "germany";
      return check.country === NORTHERN_IRELAND ? "northern_ireland" : "eu";
    case "invalid_format":
      return "wrong_format";
    case "not_eu":
    case "unreadable": {
      // Too long for the check, or another country's number: the prefix still tells which.
      const area = vatIdArea(vatId);
      if (area === undefined) return "unreadable";
      return area === "non_eu" ? "non_eu" : "wrong_format";
    }
  }
}

function formatCheck(vatId: string): VatIdFormatCheck {
  const check = checkVatIdFormat(vatId);
  if (check.status === "valid_format" || !vatId.endsWith("EX")) return check;
  const withoutSuffix = checkVatIdFormat(vatId.slice(0, -2));
  return withoutSuffix.status === "valid_format" ? withoutSuffix : check;
}

/** What the audit knows about one contact. */
export interface PartyFacts {
  readonly id?: number | undefined;
  /** Display name (text from sevDesk, sanitized). */
  readonly name?: string | undefined;
  /** Normalized USt-IdNr. */
  readonly vatId?: string | undefined;
  /** ISO codes of its addresses (and of the document address), upper case, without repeats. */
  readonly countries: readonly string[];
  /** An address has a country that could not be resolved to an ISO code (see the module doc). */
  readonly countriesUnknown?: boolean | undefined;
}

/** Where a party is established, as far as its data tells (see the module doc). */
export interface PartyLocation {
  /** A German VAT id or an address in Germany. */
  readonly germany: boolean;
  /** A VAT id of another state or an address outside Germany. */
  readonly abroad: boolean;
  /** Where abroad, when it is abroad and the data agrees. */
  readonly area?: PartyArea | undefined;
  /**
   * The VAT id ends in EX: the number of a small business in the EU small-business scheme for
   * other member states (Directive (EU) 2020/285), which charges no VAT.
   */
  readonly smallBusinessScheme: boolean;
}

/** Locates a party from its facts; see the module doc. */
export function locate(facts: Pick<PartyFacts, "vatId" | "countries">): PartyLocation {
  const fromVatId = vatIdArea(facts.vatId);
  const foreignCountries = facts.countries.filter((country) => country !== "DE");
  const germany = fromVatId === "germany" || facts.countries.includes("DE");
  const vatAbroad = fromVatId !== undefined && fromVatId !== "germany" ? fromVatId : undefined;
  const abroad = vatAbroad !== undefined || foreignCountries.length > 0;
  return {
    germany,
    abroad,
    area: vatAbroad ?? areaOfCountries(foreignCountries),
    smallBusinessScheme: vatAbroad === "eu" && facts.vatId?.endsWith("EX") === true,
  };
}

function areaOfCountries(countries: readonly string[]): PartyArea | undefined {
  if (countries.length === 0) return undefined;
  const inEu = (country: string): boolean => isEuMemberState(vatCountryOf(country));
  if (countries.every(inEu)) return "eu";
  if (!countries.some(inEu)) return "non_eu";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------------------------

/** The contacts of the account with their VAT ids and address countries. */
export interface PartyDirectory {
  /** By contact id. */
  readonly parties: ReadonlyMap<number, PartyFacts>;
  /** StaticCountry id → ISO code (empty when the table could not be read). */
  readonly countryCodes: ReadonlyMap<number, string>;
  readonly coverage: {
    readonly read: number;
    readonly addressesRead: number;
    /** A cap stopped one of the two lists (see the two below). */
    readonly truncated: boolean;
    /** The contact list stopped at its cap: contacts beyond it are not in `parties`. */
    readonly contactsTruncated: boolean;
    /** The address list stopped at its cap: any contact in `parties` may lack addresses. */
    readonly addressesTruncated: boolean;
  };
  /** True when addresses or documents had countries but the country table could not be read. */
  readonly countriesUnread: boolean;
}

export interface PartyDirectoryOptions extends ReportRunOptions {
  /** Object the country table cache belongs to (tools pass `ctx.config`). */
  readonly cacheOwner: object;
  /** Rows per list; defaults to {@link REPORT_SCAN_MAX}. */
  readonly maxRows?: number | undefined;
  /**
   * The documents to judge carry address countries of their own (invoices): read the country
   * table for them even when no contact address has a country.
   */
  readonly documentsHaveCountries?: boolean | undefined;
}

/** Reads the contact and address lists once each; see the module doc. */
export async function loadPartyDirectory(
  client: SevdeskClient,
  options: PartyDirectoryOptions,
): Promise<PartyDirectory> {
  const max = options.maxRows ?? REPORT_SCAN_MAX;
  const run = { signal: options.signal, onProgress: options.onProgress };
  const contacts = await scanPages(
    (offset, limit) => searchContacts(client, { limit, offset }, options.signal),
    { ...run, max, noun: "contacts" },
  );
  const addresses = await scanPages(
    async (offset, limit) => {
      const page = await listContactAddressLocations(client, { limit, offset }, options.signal);
      return {
        items: page.items,
        received: page.window.received,
        total: page.window.total,
        hasMore: page.state.hasMore,
        nextOffset: page.state.nextOffset,
      };
    },
    { ...run, max, noun: "contact addresses" },
  );
  const withCountry =
    options.documentsHaveCountries === true ||
    addresses.items.some((address) => address.countryId !== undefined);
  const countryCodes = withCountry
    ? await loadCountryCodes(client, { cacheOwner: options.cacheOwner, signal: options.signal })
    : new Map<number, string>();

  const countries = new Map<number, Set<string>>();
  const unresolved = new Set<number>();
  for (const address of addresses.items) {
    if (address.contactId === undefined || address.countryId === undefined) continue;
    const code = countryCodes.get(address.countryId);
    if (code === undefined) {
      unresolved.add(address.contactId);
      continue;
    }
    const set = countries.get(address.contactId) ?? new Set<string>();
    set.add(code);
    countries.set(address.contactId, set);
  }
  const parties = new Map<number, PartyFacts>();
  for (const contact of contacts.items) {
    parties.set(contact.id, {
      id: contact.id,
      name: contact.displayName,
      vatId: normalizeVatId(contact.vatNumber),
      countries: [...(countries.get(contact.id) ?? [])].sort(),
      ...(unresolved.has(contact.id) ? { countriesUnknown: true } : {}),
    });
  }
  return {
    parties,
    countryCodes,
    coverage: {
      read: contacts.scanned,
      addressesRead: addresses.scanned,
      truncated: contacts.truncated || addresses.truncated,
      contactsTruncated: contacts.truncated,
      addressesTruncated: addresses.truncated,
    },
    countriesUnread: withCountry && countryCodes.size === 0,
  };
}
