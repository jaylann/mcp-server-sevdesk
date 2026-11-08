/**
 * Code lists used by the e-invoice parser and its consumers: invoice type codes (BT-3, UNTDID
 * 1001), the profile behind a specification identifier (BT-24), VAT category codes (UNTDID 5305
 * subset of EN 16931) and a small table of unit codes (UN/ECE Recommendation 20 and 21) for
 * display.
 *
 * Sources: the EN 16931 code lists (CEF eInvoicing "EN16931 code lists", version 14, UNTDID 1001
 * invoice and credit note subsets; UNTDID 5305 VAT categories), the Factur-X 1.07 / ZUGFeRD 2.3
 * specification (guideline identifiers of the profiles), the XRechnung 3.0 specification (KoSIT,
 * `urn:xeinkauf.de:kosit:xrechnung_3.0`), and UN/ECE Recommendation 20 rev. 17 / 21.
 */
import {
  type EInvoiceDocumentKind,
  type EInvoiceProfile,
  VAT_CATEGORY_CODES,
  type VatCategoryCode,
} from "./model.js";

/**
 * BT-3 codes EN 16931 accepts as credit notes (UNTDID 1001 credit note subset): 81 credit note
 * related to goods or services, 83 credit note related to financial adjustments, 261 self billed
 * credit note, 262 consolidated credit note goods and services, 296 credit note for price
 * reduction, 308 Delcredere credit note, 381 credit note, 396 factored credit note, 420 optical
 * character reading (OCR) payment credit note, 458 reversal of debit, 532 forwarder's credit note.
 */
const CREDIT_NOTE_TYPE_CODES: ReadonlySet<string> = new Set([
  "81",
  "83",
  "261",
  "262",
  "296",
  "308",
  "381",
  "396",
  "420",
  "458",
  "532",
]);

/**
 * BT-3 codes EN 16931 accepts as invoices (UNTDID 1001 invoice subset), among them 326 partial
 * invoice, 380 commercial invoice, 383 debit note, 384 corrected invoice, 386 prepayment invoice,
 * 389 self-billed invoice, 751 invoice information for accounting purposes, 875–877 partial
 * construction invoices (XRechnung 3.0).
 */
const INVOICE_TYPE_CODES: ReadonlySet<string> = new Set([
  "80",
  "82",
  "84",
  "130",
  "202",
  "203",
  "204",
  "211",
  "218",
  "219",
  "295",
  "325",
  "326",
  "331",
  "380",
  "382",
  "383",
  "384",
  "385",
  "386",
  "387",
  "388",
  "389",
  "390",
  "393",
  "394",
  "395",
  "456",
  "457",
  "527",
  "553",
  "575",
  "623",
  "633",
  "751",
  "780",
  "817",
  "870",
  "875",
  "876",
  "877",
  "935",
]);

/** What the server does with a BT-3 code: an invoice, a credit note, or something else. */
export function documentKindOf(typeCode: string): EInvoiceDocumentKind {
  if (CREDIT_NOTE_TYPE_CODES.has(typeCode)) return "credit_note";
  if (INVOICE_TYPE_CODES.has(typeCode)) return "invoice";
  return "other";
}

/** A trusted label for the most common BT-3 codes (others: "type code <n>"). */
export function typeCodeLabel(typeCode: string): string {
  const labels: Readonly<Record<string, string>> = {
    "326": "partial invoice (Teilrechnung)",
    "380": "commercial invoice (Rechnung)",
    "381": "credit note (Gutschrift)",
    "383": "debit note (Belastungsanzeige)",
    "384": "corrected invoice (Rechnungskorrektur)",
    "386": "prepayment invoice (Vorauszahlungsrechnung)",
    "389": "self-billed invoice (Gutschriftsverfahren)",
    "751": "invoice information for accounting purposes",
    "875": "partial construction invoice (Abschlagsrechnung Bau)",
    "876": "partial final construction invoice (Teilschlussrechnung Bau)",
    "877": "final construction invoice (Schlussrechnung Bau)",
  };
  return (
    labels[typeCode] ?? (/^\d{1,4}$/.test(typeCode) ? `type code ${typeCode}` : "unknown type")
  );
}

/**
 * The profile behind a specification identifier (BT-24). Matching is on the documented
 * identifiers (lower-cased), from the most specific to the least:
 * - `…xeinkauf.de:kosit:xrechnung…` → XRechnung (any version, also inside ZUGFeRD 2.x);
 * - `urn:factur-x.eu:1p0:minimum` / `urn:zugferd.de:2p0:minimum` → MINIMUM;
 * - `…:basicwl` → BASIC WL; `…:basic` → BASIC; `…:extended` → EXTENDED;
 * - anything else starting with `urn:cen.eu:en16931:2017` (the EN 16931 core, ZUGFeRD/Factur-X
 *   EN 16931 alias COMFORT, and CIUS such as Peppol BIS 3) → `en16931`;
 * - otherwise `unknown`.
 */
export function profileOf(specificationId: string | undefined): EInvoiceProfile {
  const id = specificationId?.trim().toLowerCase();
  if (id === undefined || id === "") return "unknown";
  if (id.includes("xeinkauf.de:kosit:xrechnung")) return "xrechnung";
  if (/:(?:1p0|2p0):minimum\b/.test(id)) return "minimum";
  if (/:(?:1p0|2p0):basicwl\b/.test(id)) return "basic_wl";
  if (/:(?:1p0|2p0):basic\b/.test(id)) return "basic";
  if (/:(?:1p0|2p0):extended\b/.test(id) || id.includes(":extended")) return "extended";
  if (id.startsWith("urn:cen.eu:en16931:2017")) return "en16931";
  return "unknown";
}

/** Trusted label of a profile. */
export const PROFILE_LABELS: Readonly<Record<EInvoiceProfile, string>> = {
  xrechnung: "XRechnung",
  en16931: "EN 16931 (ZUGFeRD/Factur-X EN 16931, COMFORT)",
  extended: "ZUGFeRD/Factur-X EXTENDED",
  basic: "ZUGFeRD/Factur-X BASIC",
  basic_wl: "ZUGFeRD/Factur-X BASIC WL",
  minimum: "ZUGFeRD/Factur-X MINIMUM",
  unknown: "unknown profile",
};

/** Whether a code is one of the VAT category codes EN 16931 defines. */
export function isVatCategoryCode(code: string): code is VatCategoryCode {
  return (VAT_CATEGORY_CODES as readonly string[]).includes(code);
}

/**
 * Display names of common unit codes (UN/ECE Recommendation 20, plus the package codes `X…` of
 * Recommendation 21 that EN 16931 allows). Used for display only: any code is passed through.
 */
const UNIT_CODE_LABELS: Readonly<Record<string, string>> = {
  C62: "piece (Stück)",
  H87: "piece (Stück)",
  EA: "each (Stück)",
  XPP: "piece, package (Stück)",
  XPK: "package (Packung)",
  XBX: "box (Karton)",
  SET: "set (Satz)",
  LS: "lump sum (Pauschale)",
  E48: "service unit (Leistungseinheit)",
  P1: "percent (Prozent)",
  SEC: "second (Sekunde)",
  MIN: "minute (Minute)",
  HUR: "hour (Stunde)",
  DAY: "day (Tag)",
  WEE: "week (Woche)",
  MON: "month (Monat)",
  ANN: "year (Jahr)",
  GRM: "gram (Gramm)",
  KGM: "kilogram (Kilogramm)",
  TNE: "tonne (Tonne)",
  MTR: "metre (Meter)",
  KMT: "kilometre (Kilometer)",
  MTK: "square metre (Quadratmeter)",
  MTQ: "cubic metre (Kubikmeter)",
  LTR: "litre (Liter)",
  KWH: "kilowatt hour (Kilowattstunde)",
  KWT: "kilowatt (Kilowatt)",
};

/** The display name of a unit code; `undefined` for codes not in {@link UNIT_CODE_LABELS}. */
export function unitLabel(code: string | undefined): string | undefined {
  return code === undefined ? undefined : UNIT_CODE_LABELS[code.toUpperCase()];
}

/**
 * Payment means codes (BT-81, UNTDID 4461) that are credit transfers and therefore need the
 * payee's account (BG-17): 30 credit transfer, 58 SEPA credit transfer.
 */
export const CREDIT_TRANSFER_MEANS: ReadonlySet<string> = new Set(["30", "58"]);
