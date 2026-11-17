/**
 * Offline format check of EU VAT identification numbers (USt-IdNr.): the two-letter prefix of a
 * member state followed by the characters that state issues. It says whether a number *can* be a
 * VAT ID of that state, not whether it was issued or is still valid: that is what VIES
 * (`vies.ts`) or the BZSt confirm.
 *
 * Source of the formats: the VIES FAQ of the European Commission, question "format of VAT
 * numbers" (https://ec.europa.eu/taxation_customs/vies/#/faq), whose table is served as the VIES
 * web app's `assets/i18n/en.json` (keys `faq_label_<prefix>format`, `faq_lbl_<prefix>formatdesc`,
 * the legend `faq_lbl_remarks` and the footnotes `faq_txt_notes`); read on 2026-11-16. Legend: 9 a
 * digit, L a letter, X a letter or a digit, S a letter, a digit, "+" or "*". Footnotes used: AT
 * starts with "U"; ES has letters or digits first and last, but not digits in both; the tenth
 * character of a Dutch number is "B". Ireland's second format is written "9999999WI" (seven
 * digits and two letters). Check digits are not verified: a wrong digit passes as a valid format.
 *
 * **Northern Ireland (XI).** Under the Windsor Framework (Art. 8 of the Protocol on
 * Ireland/Northern Ireland) Northern Ireland follows the EU VAT rules for goods, and its traders
 * use their UK VAT number with the prefix XI, which VIES checks like a member state's. The format
 * is that of UK VAT numbers: 9 digits, 12 digits (a branch), or GD or HA and 3 digits (government
 * departments, health authorities). Such a number is reported with `country` XI, which is not an
 * ISO 3166-1 code but the code VAT law uses for Northern Ireland.
 *
 * Normalization is the e-invoice reader's (`normalizeVatId`): spaces, dots and dashes removed,
 * upper case. Only a number made of the characters a VAT ID can contain is ever echoed back.
 */
import { z } from "zod";

import { normalizeVatId } from "../einvoice/fields.js";
import { euMemberStateByVatPrefix } from "./eu.js";

/** The format of each member state's VAT IDs after the prefix, with a readable description. */
interface VatIdFormat {
  readonly pattern: RegExp;
  readonly description: string;
}

/** By VAT prefix; see the module doc for the source. */
const VAT_ID_FORMATS: Readonly<Record<string, VatIdFormat>> = {
  AT: { pattern: /^U\d{8}$/, description: "ATU and 8 digits" },
  BE: { pattern: /^[01]\d{9}$/, description: "BE and 10 digits, starting with 0 or 1" },
  BG: { pattern: /^\d{9,10}$/, description: "BG and 9 or 10 digits" },
  CY: { pattern: /^\d{8}[A-Z]$/, description: "CY, 8 digits and a letter" },
  CZ: { pattern: /^\d{8,10}$/, description: "CZ and 8, 9 or 10 digits" },
  DE: { pattern: /^\d{9}$/, description: "DE and 9 digits" },
  DK: { pattern: /^\d{8}$/, description: "DK and 8 digits" },
  EE: { pattern: /^\d{9}$/, description: "EE and 9 digits" },
  EL: { pattern: /^\d{9}$/, description: "EL and 9 digits" },
  ES: {
    pattern: /^(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])$/,
    description:
      "ES and 9 characters: a letter or digit, 7 digits, a letter or digit (not digits at both ends)",
  },
  FI: { pattern: /^\d{8}$/, description: "FI and 8 digits" },
  FR: { pattern: /^[A-Z0-9]{2}\d{9}$/, description: "FR, 2 letters or digits and 9 digits" },
  HR: { pattern: /^\d{11}$/, description: "HR and 11 digits" },
  HU: { pattern: /^\d{8}$/, description: "HU and 8 digits" },
  IE: {
    pattern: /^(?:\d[A-Z0-9+*]\d{5}[A-Z]|\d{7}[A-Z]{2})$/,
    description: "IE and 8 or 9 characters (e.g. 1234567T or 1234567WA)",
  },
  IT: { pattern: /^\d{11}$/, description: "IT and 11 digits" },
  LT: { pattern: /^(?:\d{9}|\d{12})$/, description: "LT and 9 or 12 digits" },
  LU: { pattern: /^\d{8}$/, description: "LU and 8 digits" },
  LV: { pattern: /^\d{11}$/, description: "LV and 11 digits" },
  MT: { pattern: /^\d{8}$/, description: "MT and 8 digits" },
  NL: {
    pattern: /^[A-Z0-9+*]{9}B[A-Z0-9+*]{2}$/,
    description: "NL and 12 characters, the tenth a B (e.g. NL123456789B01)",
  },
  PL: { pattern: /^\d{10}$/, description: "PL and 10 digits" },
  PT: { pattern: /^\d{9}$/, description: "PT and 9 digits" },
  RO: { pattern: /^\d{2,10}$/, description: "RO and 2 to 10 digits" },
  SE: { pattern: /^\d{12}$/, description: "SE and 12 digits" },
  SI: { pattern: /^\d{8}$/, description: "SI and 8 digits" },
  SK: { pattern: /^\d{10}$/, description: "SK and 10 digits" },
  XI: {
    pattern: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    description: "XI and 9 or 12 digits, or XIGD or XIHA and 3 digits",
  },
};

/** Who issues the numbers with a prefix that is not a member state's but that VIES checks. */
const NORTHERN_IRELAND = { code: "XI", name: "Northern Ireland" } as const;

/** What a VAT ID may consist of at all: a two-letter prefix and up to 14 more characters. */
const SAFE_VAT_ID = /^[A-Z]{2}[A-Z0-9+*]{1,14}$/;

const VAT_ID_FORMAT_STATUSES = ["valid_format", "invalid_format", "not_eu", "unreadable"] as const;

/** The result of {@link checkVatIdFormat} (also part of tool outputs). */
export const vatIdFormatSchema = z.object({
  status: z
    .enum(VAT_ID_FORMAT_STATUSES)
    .describe(
      "valid_format: fits the format of its member state, or of Northern Ireland (XI) (not " +
        "proof that it exists); invalid_format: such a prefix with the wrong characters; not_eu: " +
        "no EU member state's prefix (e.g. CHE, GB); unreadable: not a VAT ID at all.",
    ),
  vatId: z
    .string()
    .optional()
    .describe("Normalized: no spaces, dots or dashes, upper case. Absent when unreadable."),
  country: z
    .string()
    .optional()
    .describe("ISO 3166-1 alpha-2 of the issuing state (GR for EL); XI for Northern Ireland."),
  countryName: z.string().optional(),
  expectedFormat: z.string().optional().describe("The format of that member state's VAT IDs."),
});
export type VatIdFormatCheck = z.output<typeof vatIdFormatSchema>;

/**
 * Checks the format of `value` as an EU VAT ID, or one of Northern Ireland (see the module doc).
 * Pure; never throws for any input. Greek numbers must start with EL: a GR prefix is reported as
 * `invalid_format`.
 */
export function checkVatIdFormat(value: string): VatIdFormatCheck {
  const vatId = normalizeVatId(value);
  if (vatId === undefined || !SAFE_VAT_ID.test(vatId)) return { status: "unreadable" };
  const prefix = vatId.slice(0, 2);
  if (prefix === "GR") {
    const greece = euMemberStateByVatPrefix("EL");
    return {
      status: "invalid_format",
      vatId,
      country: "GR",
      ...(greece === undefined ? {} : { countryName: greece.name }),
      expectedFormat: "EL and 9 digits (Greek VAT IDs start with EL, not GR)",
    };
  }
  const issuer =
    euMemberStateByVatPrefix(prefix) ??
    (prefix === NORTHERN_IRELAND.code ? NORTHERN_IRELAND : undefined);
  const format = VAT_ID_FORMATS[prefix];
  if (issuer === undefined || format === undefined) return { status: "not_eu", vatId };
  return {
    status: format.pattern.test(vatId.slice(2)) ? "valid_format" : "invalid_format",
    vatId,
    country: issuer.code,
    countryName: issuer.name,
    expectedFormat: format.description,
  };
}
