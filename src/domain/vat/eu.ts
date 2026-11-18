/**
 * The EU member states as VAT law sees them, in one table: ISO 3166-1 alpha-2 code, the prefix
 * of their VAT identification numbers (EL for Greece), their English and German short names and
 * their standard VAT rate. Every EU list of this server comes from here: the e-invoice voucher
 * suggestion, the tax-rule helper, the VAT-ID check and the account audit.
 *
 * **Standard rates.** Source: European Commission, Your Europe (Business), "VAT rules and rates"
 * (https://europa.eu/youreurope/business/taxation/vat/vat-rules-rates/index_en.htm), table of
 * standard rates per country; the page says "Last checked: 13/07/2026" and was read for this
 * table on 2026-11-16 ({@link EU_STANDARD_RATES_AS_OF}). The rates of the mainland: regions with
 * their own rates (the Azores, Madeira, …) and territories outside the EU VAT area (the Canary
 * Islands, Åland, …) are not covered. A rate that could not be checked against that source is
 * left out (`standardRate` undefined), and the tax-rule helper then says so instead of guessing;
 * all 27 were checked. Rates change: update the table and the date together.
 */

/** One member state. */
export interface EuMemberState {
  /** ISO 3166-1 alpha-2, upper case (GR for Greece). */
  readonly code: string;
  /** The two letters VAT IDs of this state start with (EL for Greece, else the ISO code). */
  readonly vatPrefix: string;
  /** English short name. */
  readonly name: string;
  /** German short name, for German previews. */
  readonly nameDe: string;
  /**
   * Standard VAT rate in percent as a decimal string (e.g. "25.5"), from the dated source above;
   * undefined when it could not be checked there.
   */
  readonly standardRate: string | undefined;
}

/** The day the standard rates were read from their source (see the module doc). */
export const EU_STANDARD_RATES_AS_OF = "2026-11-16";

/** Where the standard rates come from, for results that show a rate. */
export const EU_STANDARD_RATES_SOURCE =
  "European Commission, Your Europe: VAT rules and rates (page last checked 13/07/2026)";

/** The 27 member states, by ISO code. */
export const EU_MEMBER_STATES: readonly EuMemberState[] = [
  { code: "AT", vatPrefix: "AT", name: "Austria", nameDe: "Österreich", standardRate: "20" },
  { code: "BE", vatPrefix: "BE", name: "Belgium", nameDe: "Belgien", standardRate: "21" },
  { code: "BG", vatPrefix: "BG", name: "Bulgaria", nameDe: "Bulgarien", standardRate: "20" },
  { code: "CY", vatPrefix: "CY", name: "Cyprus", nameDe: "Zypern", standardRate: "19" },
  { code: "CZ", vatPrefix: "CZ", name: "Czechia", nameDe: "Tschechien", standardRate: "21" },
  { code: "DE", vatPrefix: "DE", name: "Germany", nameDe: "Deutschland", standardRate: "19" },
  { code: "DK", vatPrefix: "DK", name: "Denmark", nameDe: "Dänemark", standardRate: "25" },
  { code: "EE", vatPrefix: "EE", name: "Estonia", nameDe: "Estland", standardRate: "24" },
  { code: "ES", vatPrefix: "ES", name: "Spain", nameDe: "Spanien", standardRate: "21" },
  { code: "FI", vatPrefix: "FI", name: "Finland", nameDe: "Finnland", standardRate: "25.5" },
  { code: "FR", vatPrefix: "FR", name: "France", nameDe: "Frankreich", standardRate: "20" },
  { code: "GR", vatPrefix: "EL", name: "Greece", nameDe: "Griechenland", standardRate: "24" },
  { code: "HR", vatPrefix: "HR", name: "Croatia", nameDe: "Kroatien", standardRate: "25" },
  { code: "HU", vatPrefix: "HU", name: "Hungary", nameDe: "Ungarn", standardRate: "27" },
  { code: "IE", vatPrefix: "IE", name: "Ireland", nameDe: "Irland", standardRate: "23" },
  { code: "IT", vatPrefix: "IT", name: "Italy", nameDe: "Italien", standardRate: "22" },
  { code: "LT", vatPrefix: "LT", name: "Lithuania", nameDe: "Litauen", standardRate: "21" },
  { code: "LU", vatPrefix: "LU", name: "Luxembourg", nameDe: "Luxemburg", standardRate: "17" },
  { code: "LV", vatPrefix: "LV", name: "Latvia", nameDe: "Lettland", standardRate: "21" },
  { code: "MT", vatPrefix: "MT", name: "Malta", nameDe: "Malta", standardRate: "18" },
  { code: "NL", vatPrefix: "NL", name: "Netherlands", nameDe: "Niederlande", standardRate: "21" },
  { code: "PL", vatPrefix: "PL", name: "Poland", nameDe: "Polen", standardRate: "23" },
  { code: "PT", vatPrefix: "PT", name: "Portugal", nameDe: "Portugal", standardRate: "23" },
  { code: "RO", vatPrefix: "RO", name: "Romania", nameDe: "Rumänien", standardRate: "21" },
  { code: "SE", vatPrefix: "SE", name: "Sweden", nameDe: "Schweden", standardRate: "25" },
  { code: "SI", vatPrefix: "SI", name: "Slovenia", nameDe: "Slowenien", standardRate: "22" },
  { code: "SK", vatPrefix: "SK", name: "Slovakia", nameDe: "Slowakei", standardRate: "23" },
];

const BY_CODE: ReadonlyMap<string, EuMemberState> = new Map(
  EU_MEMBER_STATES.map((state) => [state.code, state]),
);
const BY_PREFIX: ReadonlyMap<string, EuMemberState> = new Map(
  EU_MEMBER_STATES.map((state) => [state.vatPrefix, state]),
);

/** The member state with ISO code `code` (any case), or undefined outside the EU. */
export function euMemberState(code: string | undefined): EuMemberState | undefined {
  return code === undefined ? undefined : BY_CODE.get(code.trim().toUpperCase());
}

/** Whether `code` (ISO 3166-1 alpha-2, any case) is an EU member state. */
export function isEuMemberState(code: string | undefined): boolean {
  return euMemberState(code) !== undefined;
}

/** The member state whose VAT IDs start with `prefix` (upper case), e.g. EL → Greece. */
export function euMemberStateByVatPrefix(prefix: string): EuMemberState | undefined {
  return BY_PREFIX.get(prefix);
}

/**
 * The country whose VAT a place with ISO code `country` (any case) comes under, upper case:
 * Monaco counts as France (§ 1 Abs. 2a Satz 2 UStG, Art. 7 MwStSystRL); any other code stands for
 * itself.
 */
export function vatCountryOf(country: string): string {
  const code = country.trim().toUpperCase();
  return code === "MC" ? "FR" : code;
}
