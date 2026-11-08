/**
 * Where sevDesk's Update 2.0 tax rules (Steuerregeln) land in the German VAT return for 2026
 * (Umsatzsteuer-Voranmeldung, form USt 1 A 2026), in the Zusammenfassende Meldung (ZM) and in
 * the One-Stop-Shop (OSS) return. Pure data plus lookups; `vat.ts` does the arithmetic.
 *
 * Versioned: the table is for {@link USTVA_FORM} (form year 2026). The Kennzahlen (Kz) have been
 * stable for years, but the line numbers (Zeilen) change with the form; a new form year needs a
 * new check against the BMF letter of that year.
 *
 * Sources (checked 2026-11-08):
 * - BMF letter of 29 December 2025, III C 3 - S 7344/00039/007/036, "Muster der Vordrucke im
 *   Umsatzsteuer-Voranmeldungs- und -Vorauszahlungsverfahren für das Kalenderjahr 2026", with the
 *   form USt 1 A 2026 and its instructions USt 1 E 2026 (Anleitung). Copy read:
 *   https://www.ihk.de/blueprint/servlet/resource/blob/6936592/fccd966702cb382459b0ed0ecb38cd94/voranmeldung-2026-data.pdf
 * - § 18a UStG (Zusammenfassende Meldung): https://www.gesetze-im-internet.de/ustg_1980/__18a.html
 * - sevDesk help "Kennzahlen der Umsatzsteuervoranmeldung" (2024-12-20, old line numbers):
 *   https://hilfe.sevdesk.de/de/articles/9886922-kennzahlen-der-umsatzsteuervoranmeldung
 * - sevDesk help "Umsatzsteuervoranmeldung" (Soll/Ist, which date counts):
 *   https://intercom.help/sevdesk/de/articles/9310598-umsatzsteuervoranmeldung
 * - Tax rule ids, names and allowed rates: `TAX_RULES` (`reference-data.ts`) and the recorded
 *   ReceiptGuidance (`test/fixtures/recorded/2026-11-07/meta/receipt-guidance-all.json`).
 *
 * Decisions taken from these sources:
 * - OSS sales (rules 18–20) are not taxable in Germany; the instructions put "innergemeinschaft-
 *   liche Fernverkäufe" and electronic and other B2C services taxed at the place of consumption
 *   into Kz 45 (Zeile 36), and sevDesk's help names OSS sales there too. The tax itself goes into
 *   the separate OSS return (by country), never into Kz 81/86.
 * - Small-business turnover (§ 19 Abs. 1 UStG, rule 11) is tax-exempt without input VAT deduction
 *   since 2025: Kz 48 (Zeile 23). It shows up on a regular account only in the year of a switch;
 *   a Kleinunternehmer account files no UStVA at all (the report says so instead of boxes).
 * - Intra-EU acquisitions (rule 8) and §13b purchases (rules 12–14) are booked at 0 % in sevDesk
 *   (ReceiptGuidance allows only ZERO for them; the rule names say "0% (19%)"): the recipient owes
 *   the tax at the regular rate, so a 0 % position counts at {@link RECIPIENT_TAX_DEFAULT_RATE}
 *   (an assumption the report states). Positions with a real rate use it. Kz 90 (0 % acquisitions,
 *   § 12 Abs. 3 UStG) therefore cannot be told apart in sevDesk data and is never filled.
 * - Rule 4 ("Steuerfreie Umsätze §4 UStG") goes to Kz 48 (§ 4 Nr. 8–29, without input VAT);
 *   § 4 Nr. 2–7 supplies belong to Kz 43 and cannot be told apart either (said in a note).
 * - Rule 13 (§13b without input VAT deduction) goes to Kz 84/85 without Kz 67; sevDesk does not
 *   say whether the service came from an EU business (Kz 46/47) or not.
 * - Rule 1 at 0 % is not placed in Kz 87: that rate applies only to solar installations
 *   (§ 12 Abs. 3 UStG), and a 0 % position under rule 1 is more often a wrong rate or rule. It is
 *   reported as unmapped with that explanation, and Kz 87 is not in the table.
 */
import { compare } from "../money.js";

/** The form this table was checked against. */
export const USTVA_FORM = {
  year: 2026,
  name: "Umsatzsteuer-Voranmeldung 2026 (USt 1 A)",
  checked: "2026-11-08",
  sources: [
    "BMF-Schreiben vom 29.12.2025 (III C 3 - S 7344/00039/007/036): Vordruckmuster USt 1 A 2026 " +
      "und Anleitung USt 1 E 2026",
    "§ 18a UStG (Zusammenfassende Meldung)",
    "sevDesk-Hilfe: Kennzahlen der Umsatzsteuervoranmeldung; Umsatzsteuervoranmeldung",
  ],
} as const;

/**
 * Rate a 0 % reverse-charge or acquisition position is taxed at by its recipient (sevDesk's rule
 * names say "0% (19%)"). An assumption, stated in the report's notes.
 */
export const RECIPIENT_TAX_DEFAULT_RATE = "19";

/**
 * One line of the form that this server can fill. `baseKz` is the Kennzahl of the base
 * (Bemessungsgrundlage), `taxKz` the Kennzahl of the tax when the form has one; `taxOnForm` says
 * how the tax column works: `computed` (the form computes it from the base at `rate`: Kz 81, 86,
 * 89, 93), `entered` (its own Kennzahl), `none` (no tax column) or `tax_only` (input VAT lines).
 */
export interface UstvaLine {
  readonly key: UstvaLineKey;
  /** Line (Zeile) on the 2026 form. */
  readonly line: number;
  readonly baseKz?: string;
  readonly taxKz?: string;
  readonly taxOnForm: "computed" | "entered" | "none" | "tax_only";
  /** Fixed rate of a `computed` line, in percent. */
  readonly rate?: string;
  /** Output VAT (Umsatzsteuer, adds to Kz 83) or input VAT (Vorsteuer, subtracts). */
  readonly side: "output" | "input" | "none";
  readonly section: "A" | "B" | "C" | "D" | "E" | "F";
  readonly labelDe: string;
  readonly label: string;
}

export const USTVA_LINE_KEYS = [
  "81",
  "86",
  "35",
  "41",
  "43",
  "48",
  "89",
  "93",
  "95",
  "46",
  "84",
  "60",
  "21",
  "45",
  "66",
  "61",
  "67",
] as const;
export type UstvaLineKey = (typeof USTVA_LINE_KEYS)[number];

/** The form lines this server fills, in form order (USt 1 A 2026). */
export const USTVA_LINES: readonly UstvaLine[] = [
  {
    key: "81",
    line: 13,
    baseKz: "81",
    taxOnForm: "computed",
    rate: "19",
    side: "output",
    section: "A",
    labelDe: "Steuerpflichtige Umsätze zum Steuersatz von 19 %",
    label: "Taxable supplies at 19 %",
  },
  {
    key: "86",
    line: 14,
    baseKz: "86",
    taxOnForm: "computed",
    rate: "7",
    side: "output",
    section: "A",
    labelDe: "Steuerpflichtige Umsätze zum Steuersatz von 7 %",
    label: "Taxable supplies at 7 %",
  },
  {
    key: "35",
    line: 16,
    baseKz: "35",
    taxKz: "36",
    taxOnForm: "entered",
    side: "output",
    section: "A",
    labelDe: "Steuerpflichtige Umsätze zu anderen Steuersätzen",
    label: "Taxable supplies at other rates",
  },
  {
    key: "41",
    line: 19,
    baseKz: "41",
    taxOnForm: "none",
    side: "none",
    section: "B",
    labelDe: "Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.",
    label: "Intra-EU supplies to buyers with a VAT id",
  },
  {
    key: "43",
    line: 22,
    baseKz: "43",
    taxOnForm: "none",
    side: "none",
    section: "B",
    labelDe: "Weitere steuerfreie Umsätze mit Vorsteuerabzug (z. B. Ausfuhrlieferungen)",
    label: "Other tax-exempt supplies with input VAT deduction (e.g. exports)",
  },
  {
    key: "48",
    line: 23,
    baseKz: "48",
    taxOnForm: "none",
    side: "none",
    section: "B",
    labelDe: "Steuerfreie Umsätze ohne Vorsteuerabzug (§ 4 Nr. 8 bis 29, § 19 Abs. 1 UStG)",
    label: "Tax-exempt supplies without input VAT deduction",
  },
  {
    key: "89",
    line: 25,
    baseKz: "89",
    taxOnForm: "computed",
    rate: "19",
    side: "output",
    section: "C",
    labelDe: "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 19 %",
    label: "Taxable intra-EU acquisitions at 19 %",
  },
  {
    key: "93",
    line: 26,
    baseKz: "93",
    taxOnForm: "computed",
    rate: "7",
    side: "output",
    section: "C",
    labelDe: "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 7 %",
    label: "Taxable intra-EU acquisitions at 7 %",
  },
  {
    key: "95",
    line: 28,
    baseKz: "95",
    taxKz: "98",
    taxOnForm: "entered",
    side: "output",
    section: "C",
    labelDe: "Steuerpflichtige innergemeinschaftliche Erwerbe zu anderen Steuersätzen",
    label: "Taxable intra-EU acquisitions at other rates",
  },
  {
    key: "46",
    line: 30,
    baseKz: "46",
    taxKz: "47",
    taxOnForm: "entered",
    side: "output",
    section: "D",
    labelDe:
      "Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers " +
      "(§ 13b Abs. 1 UStG)",
    label: "Services from businesses in other EU states (recipient owes the VAT, § 13b(1))",
  },
  {
    key: "84",
    line: 32,
    baseKz: "84",
    taxKz: "85",
    taxOnForm: "entered",
    side: "output",
    section: "D",
    labelDe: "Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 12 UStG)",
    label: "Other supplies where the recipient owes the VAT (§ 13b(2))",
  },
  {
    key: "60",
    line: 34,
    baseKz: "60",
    taxOnForm: "none",
    side: "none",
    section: "E",
    labelDe:
      "Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer nach § 13b " +
      "Abs. 5 UStG schuldet",
    label: "Own supplies where the recipient owes the VAT (§ 13b(5))",
  },
  {
    key: "21",
    line: 35,
    baseKz: "21",
    taxOnForm: "none",
    side: "none",
    section: "E",
    labelDe: "Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nr. 2 UStG",
    label: "Services to businesses in other EU states (taxed there)",
  },
  {
    key: "45",
    line: 36,
    baseKz: "45",
    taxOnForm: "none",
    side: "none",
    section: "E",
    labelDe: "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)",
    label: "Other supplies not taxable in Germany (incl. OSS sales)",
  },
  {
    key: "66",
    line: 38,
    taxKz: "66",
    taxOnForm: "tax_only",
    side: "input",
    section: "F",
    labelDe: "Vorsteuerbeträge aus Rechnungen von anderen Unternehmern",
    label: "Input VAT from other businesses' invoices",
  },
  {
    key: "61",
    line: 39,
    taxKz: "61",
    taxOnForm: "tax_only",
    side: "input",
    section: "F",
    labelDe: "Vorsteuerbeträge aus dem innergemeinschaftlichen Erwerb von Gegenständen",
    label: "Input VAT from intra-EU acquisitions",
  },
  {
    key: "67",
    line: 41,
    taxKz: "67",
    taxOnForm: "tax_only",
    side: "input",
    section: "F",
    labelDe: "Vorsteuerbeträge aus Leistungen im Sinne des § 13b UStG",
    label: "Input VAT from § 13b services",
  },
];

/** The line of `key`. */
export function ustvaLine(key: UstvaLineKey): UstvaLine {
  const line = USTVA_LINES.find((candidate) => candidate.key === key);
  // Every key has a line (checked by the unit tests).
  if (line === undefined) throw new Error(`No UStVA line ${key}`);
  return line;
}

/**
 * When the tax of a position falls due under accrual (Sollversteuerung), from the document's
 * dates; `vat.ts` turns it into a date:
 * - `supply`: the end of the supply or service (`deliveryDateUntil`, else `deliveryDate`, else the
 *   document date), as sevDesk's own UStVA does ("zum letzten Tag des Zeitraumes");
 * - `invoice_or_next_month`: the document date, but no later than the last day of the month after
 *   the supply (§ 18b for intra-EU supplies and § 18b services, § 13 Abs. 1 Nr. 6 for intra-EU
 *   acquisitions, § 13b Abs. 2 for reverse-charge purchases);
 * - `supply_and_invoice`: input VAT needs both the invoice and the supply (§ 15), so the later of
 *   the document date and the end of the supply.
 */
export type TaxPointRule = "supply" | "invoice_or_next_month" | "supply_and_invoice";

/** Section of the Zusammenfassende Meldung: L goods (Lieferungen), S services (§ 3a Abs. 2). */
export type ZmKind = "L" | "S";

/** Where one position's amounts go, by tax rule, direction and rate. */
export type UstvaTarget =
  | {
      readonly kind: "line";
      /** Line for the base; its tax (if any) goes with it. */
      readonly line: UstvaLineKey;
      /** Input VAT line the same tax is deducted on (acquisitions, § 13b with deduction). */
      readonly inputTax?: UstvaLineKey;
      /**
       * Tax owed by the recipient: computed here as base × `recipientRate` (the position itself
       * carries 0 % in sevDesk). Absent for documents that carry their own VAT.
       */
      readonly recipientRate?: string;
      /** True when `recipientRate` is the assumed regular rate, not the position's own rate. */
      readonly assumedRate?: boolean;
      readonly zm?: ZmKind;
      /** OSS sales: also listed per destination country. */
      readonly oss?: boolean;
      /** Under cash accounting (Istversteuerung) this revenue counts when it is paid. */
      readonly cashBasis: boolean;
      readonly timing: TaxPointRule;
    }
  | {
      /** Input VAT only (rule 9): the base is not reported. */
      readonly kind: "input_tax";
      readonly line: UstvaLineKey;
      readonly timing: TaxPointRule;
    }
  | {
      /** Not part of the UStVA (no deduction, not taxable); `reason` is trusted text. */
      readonly kind: "excluded";
      readonly reason: string;
    }
  | {
      /** No mapping: unknown rule, or a rule used in the wrong direction. */
      readonly kind: "unmapped";
      readonly reason: string;
    };

/** Direction of a position: revenue (Einnahme) or expense (Ausgabe). */
export type VatDirection = "revenue" | "expense";

const NOT_IN_USTVA = {
  10: "Expenses without input VAT deduction (Nicht vorsteuerabziehbare Aufwendungen): no UStVA box.",
  15: "Not taxable: VAT payments and refunds themselves (Nicht steuerbar, Steuer).",
  16: "Not taxable: e.g. private withdrawals or deposits (Nicht steuerbar, Ausgabe).",
  22: "Not taxable: e.g. transitory items (Nicht steuerbar, Einnahme, durchlaufende Posten).",
} as const satisfies Readonly<Record<number, string>>;

/**
 * Where a position with tax rule `ruleId`, `direction` and VAT `rate` (percent, exact decimal
 * string, e.g. "19") goes. Rules used in a direction they are not made for are `unmapped`, so
 * the report lists them instead of guessing.
 */
export function ustvaTarget(
  ruleId: number | undefined,
  direction: VatDirection,
  rate: string,
): UstvaTarget {
  if (ruleId === undefined) {
    return { kind: "unmapped", reason: "The document has no tax rule (Steuerregel)." };
  }
  const excluded = (NOT_IN_USTVA as Readonly<Record<number, string>>)[ruleId];
  if (excluded !== undefined) return { kind: "excluded", reason: excluded };
  const revenue = REVENUE_TARGETS[ruleId];
  const expense = EXPENSE_TARGETS[ruleId];
  if (direction === "revenue" && revenue !== undefined) return revenue(rate);
  if (direction === "expense" && expense !== undefined) return expense(rate);
  if (revenue === undefined && expense === undefined) {
    return { kind: "unmapped", reason: `Tax rule ${String(ruleId)} is not known to this server.` };
  }
  return {
    kind: "unmapped",
    reason:
      `Tax rule ${String(ruleId)} is a${direction === "revenue" ? "n expense" : " revenue"} ` +
      `rule but was used on ${direction === "revenue" ? "revenue" : "an expense"}.`,
  };
}

type TargetOf = (rate: string) => UstvaTarget;

/** The line for taxable domestic revenue (rule 1) at a rate above 0 %. */
function domesticLine(rate: string): UstvaLineKey {
  if (sameRate(rate, "19")) return "81";
  if (sameRate(rate, "7")) return "86";
  return "35";
}

/** Rule 1 at 0 %: only solar installations qualify (Kz 87), which sevDesk cannot tell. */
const DOMESTIC_ZERO_RATE =
  "Taxable domestic revenue (rule 1) at 0 %: only solar installations are taxed at 0 % " +
  "(§ 12 Abs. 3 UStG, Kz 87); anything else needs another rate or tax rule. Check and place it " +
  "by hand.";

/** Line for the recipient's tax on an intra-EU acquisition at `rate`. */
function acquisitionLine(rate: string): UstvaLineKey {
  if (sameRate(rate, "19")) return "89";
  if (sameRate(rate, "7")) return "93";
  return "95";
}

/** The rate a recipient owes on a position booked at `rate` (0 % → the assumed regular rate). */
function recipientRate(rate: string): { recipientRate: string; assumedRate?: true } {
  return sameRate(rate, "0")
    ? { recipientRate: RECIPIENT_TAX_DEFAULT_RATE, assumedRate: true }
    : { recipientRate: rate };
}

const REVENUE_TARGETS: Readonly<Record<number, TargetOf>> = {
  1: (rate) =>
    sameRate(rate, "0")
      ? { kind: "unmapped", reason: DOMESTIC_ZERO_RATE }
      : { kind: "line", line: domesticLine(rate), cashBasis: true, timing: "supply" },
  2: () => ({ kind: "line", line: "43", cashBasis: false, timing: "supply" }),
  3: () => ({
    kind: "line",
    line: "41",
    zm: "L",
    cashBasis: false,
    timing: "invoice_or_next_month",
  }),
  4: () => ({ kind: "line", line: "48", cashBasis: false, timing: "supply" }),
  5: () => ({ kind: "line", line: "60", cashBasis: false, timing: "supply" }),
  11: () => ({ kind: "line", line: "48", cashBasis: false, timing: "supply" }),
  17: () => ({ kind: "line", line: "45", cashBasis: false, timing: "supply" }),
  18: () => ({ kind: "line", line: "45", oss: true, cashBasis: false, timing: "supply" }),
  19: () => ({ kind: "line", line: "45", oss: true, cashBasis: false, timing: "supply" }),
  20: () => ({ kind: "line", line: "45", oss: true, cashBasis: false, timing: "supply" }),
  21: () => ({
    kind: "line",
    line: "21",
    zm: "S",
    cashBasis: false,
    timing: "invoice_or_next_month",
  }),
};

const EXPENSE_TARGETS: Readonly<Record<number, TargetOf>> = {
  8: (rate) => {
    const owed = recipientRate(rate);
    return {
      kind: "line",
      line: acquisitionLine(owed.recipientRate),
      inputTax: "61",
      ...owed,
      cashBasis: false,
      timing: "invoice_or_next_month",
    };
  },
  9: () => ({ kind: "input_tax", line: "66", timing: "supply_and_invoice" }),
  12: (rate) => ({
    kind: "line",
    line: "84",
    inputTax: "67",
    ...recipientRate(rate),
    cashBasis: false,
    timing: "invoice_or_next_month",
  }),
  13: (rate) => ({
    kind: "line",
    line: "84",
    ...recipientRate(rate),
    cashBasis: false,
    timing: "invoice_or_next_month",
  }),
  14: (rate) => ({
    kind: "line",
    line: "46",
    inputTax: "67",
    ...recipientRate(rate),
    cashBasis: false,
    timing: "supply",
  }),
};

/** Tax rules this table knows (mapped or deliberately excluded). */
export const MAPPED_TAX_RULE_IDS: readonly number[] = [
  ...new Set([
    ...Object.keys(REVENUE_TARGETS),
    ...Object.keys(EXPENSE_TARGETS),
    ...Object.keys(NOT_IN_USTVA),
  ]),
]
  .map(Number)
  .sort((a, b) => a - b);

/** Whether two percent rates are equal as decimals ("19" = "19.0" = "19.00"). */
export function sameRate(a: string, b: string): boolean {
  return compare(a, b) === 0;
}
