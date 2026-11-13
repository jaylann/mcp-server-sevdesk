/** D-082: rate inputs, currency previews and reconciliation of the stored foreign/EUR sums. */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { isoDateInput } from "../common.js";
import { compare, decimal, format, isCurrencyCode, multiply, subtract } from "../money.js";
import { dateText, numberText, type PreviewLanguage } from "../preview-text.js";
import type { VoucherDetails } from "../vouchers.js";
import { wireDocumentDate } from "./fields.js";
import { type Amounts, divideRounded } from "./positions.js";
import { fact, type PreviewFact, totalsText } from "./preview.js";

export const voucherCurrencyInput = z
  .string()
  .refine(isCurrencyCode, "Use an uppercase ISO 4217 currency code.");
export const exchangeRateInput = z
  .string()
  .max(32)
  .regex(/^\d+(?:\.\d+)?$/, "Use an exact decimal string.")
  .refine((value) => {
    try {
      return compare(value, 0) > 0;
    } catch {
      return false;
    }
  }, "exchangeRate must be positive.");

export const exchangeInputs = {
  exchangeRate: exchangeRateInput
    .optional()
    .describe(
      'EUR per 1 unit of the voucher currency, as a positive decimal string: "0.9" means 1 USD = 0.9 EUR. For non-EUR, pass this or foreignCurrencyDeadline, never both.',
    ),
  foreignCurrencyDeadline: isoDateInput
    .optional()
    .describe(
      "Exchange-rate date, YYYY-MM-DD. sevDesk selects the rate; EUR totals are known after saving. For non-EUR only, instead of exchangeRate.",
    ),
};

export interface ExchangeArgs {
  readonly exchangeRate?: string | undefined;
  readonly foreignCurrencyDeadline?: string | undefined;
}

export interface VoucherCurrency extends ExchangeArgs {
  readonly currency: string;
}

/** Validate again at the domain boundary, including direct callers and the e-invoice import. */
export function resolveVoucherCurrency(currency: string, args: ExchangeArgs): VoucherCurrency {
  if (!voucherCurrencyInput.safeParse(currency).success)
    refuse("Use an uppercase ISO 4217 currency code.");
  const rate = args.exchangeRate !== undefined;
  const deadline = args.foreignCurrencyDeadline !== undefined;
  if (rate && !exchangeRateInput.safeParse(args.exchangeRate).success) {
    refuse("exchangeRate must be a positive exact decimal string; zero is not a positive rate.");
  }
  if (deadline && !isoDateInput.safeParse(args.foreignCurrencyDeadline).success) {
    refuse("foreignCurrencyDeadline must be a valid date in YYYY-MM-DD format.");
  }
  if (currency === "EUR" && (rate || deadline))
    refuse("EUR vouchers take neither exchangeRate nor foreignCurrencyDeadline.");
  if (currency !== "EUR" && rate === deadline) {
    refuse(
      "A non-EUR voucher requires exactly one of exchangeRate or foreignCurrencyDeadline. Stored rates are not reused.",
    );
  }
  return {
    currency,
    exchangeRate: args.exchangeRate,
    foreignCurrencyDeadline: args.foreignCurrencyDeadline,
  };
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

export function currencyPayload(value: VoucherCurrency) {
  return {
    currency: value.currency,
    ...(value.exchangeRate === undefined ? {} : { propertyExchangeRate: value.exchangeRate }),
    ...(value.foreignCurrencyDeadline === undefined
      ? {}
      : {
          propertyForeignCurrencyDeadline: wireDocumentDate(value.foreignCurrencyDeadline),
        }),
  };
}

function eurTotals(totals: Amounts, rate: string): Amounts {
  return {
    net: format(multiply(totals.net, rate), 2),
    tax: format(multiply(totals.tax, rate), 2),
    gross: format(multiply(totals.gross, rate), 2),
  };
}

export function currencyFacts(
  value: VoucherCurrency,
  totals: Amounts | undefined,
  lang: PreviewLanguage,
): PreviewFact[] {
  const de = lang === "de";
  const facts = [fact(de ? "Währung" : "Currency", value.currency)];
  if (value.exchangeRate !== undefined) {
    facts.push(
      fact(
        de ? "Wechselkurs" : "Exchange rate",
        `1 ${value.currency} = ${numberText(value.exchangeRate, lang)} EUR`,
      ),
    );
    if (totals !== undefined)
      facts.push(
        fact(
          de ? "EUR-Gegenwert (vom Server berechnet)" : "EUR equivalent (computed by this server)",
          totalsText(eurTotals(totals, value.exchangeRate), "EUR", lang),
        ),
      );
  } else if (value.foreignCurrencyDeadline !== undefined) {
    facts.push(
      fact(
        de ? "Wechselkursdatum" : "Exchange-rate date",
        dateText(value.foreignCurrencyDeadline, lang),
      ),
    );
  }
  return facts;
}

export function currencyWarnings(value: VoucherCurrency, lang: PreviewLanguage): string[] {
  if (value.currency === "EUR") return [];
  const de = lang === "de";
  return [
    value.exchangeRate !== undefined
      ? de
        ? "Der Server berechnet den EUR-Gegenwert aus den Gesamtsummen und rundet auf Cent; sevDesk kann je Position runden. Fremdwährungsbelege können hier nicht fertiggestellt werden."
        : "This server computes the EUR equivalent from the totals, rounded to cents; sevDesk may round per position. Foreign-currency vouchers cannot be finalized here."
      : de
        ? `sevDesk verwendet seinen Wechselkurs für den ${dateText(value.foreignCurrencyDeadline ?? "", lang)}; die EUR-Beträge stehen erst nach dem Speichern fest. Fremdwährungsbelege können hier nicht fertiggestellt werden.`
        : `sevDesk applies its exchange rate for ${value.foreignCurrencyDeadline ?? ""}; EUR amounts are known after saving. Foreign-currency vouchers cannot be finalized here.`,
  ];
}

/**
 * GET omits the rate (D-082). Reconcile sums instead, never treat an implied rate as exact.
 * The live deadline example returns cent amounts (90.18/17.13/107.31); the exact rounding order
 * is unknown. Allow one cent per sent position for each EUR sum, conservatively covering
 * aggregate versus per-position rounding. Foreign sums must match exactly.
 */
export function foreignReadBackNotes(
  details: VoucherDetails,
  expected: Amounts,
  value: VoucherCurrency,
  positionCount: number,
  lang: PreviewLanguage,
): string[] {
  const de = lang === "de";
  const { voucher } = details;
  const notes: string[] = [];
  const actual = voucher.totals;
  const eur = voucher.totalsEur;
  const fields = ["net", "tax", "gross"] as const;
  const labels = de
    ? { net: "netto", tax: "USt.", gross: "brutto" }
    : { net: "net", tax: "tax", gross: "gross" };
  const tolerance = multiply("0.01", positionCount);
  let mismatch = false;
  for (const key of fields) {
    const foreign = actual[key];
    // Without totalsEur the read mapper may have fallen back to plain EUR sums (D-043).
    if (
      eur === undefined ||
      foreign === undefined ||
      foreign.currency !== value.currency ||
      compare(foreign.amount, expected[key]) !== 0
    ) {
      mismatch = true;
      notes.push(
        de
          ? `Die gespeicherte Fremdwährungssumme (${labels[key]}) fehlt oder weicht von ${numberText(expected[key], lang)} ${value.currency} ab. Prüfen Sie den Beleg; wiederholen Sie das Speichern nicht ungeprüft.`
          : `The stored foreign ${labels[key]} total is missing or differs from ${expected[key]} ${value.currency}. Check the voucher; do not repeat the save blindly.`,
      );
    }
    if (value.exchangeRate !== undefined) {
      const calculated = eurTotals(expected, value.exchangeRate)[key];
      const stored = eur?.[key]?.amount;
      const difference = stored === undefined ? undefined : subtract(stored, calculated);
      if (
        difference === undefined ||
        compare(difference, tolerance) > 0 ||
        compare(difference, multiply(tolerance, -1)) < 0
      ) {
        mismatch = true;
        notes.push(
          de
            ? `Die gespeicherte EUR-Summe (${labels[key]}) fehlt oder weicht vom berechneten Wert ${numberText(calculated, lang)} EUR um mehr als ${numberText(format(tolerance, 2), lang)} EUR ab (ein Cent je Position). Prüfen Sie Wechselkurs und Positionen.`
            : `The stored EUR ${labels[key]} total is missing or differs from the computed ${calculated} EUR by more than ${format(tolerance, 2)} EUR (one cent per position). Check the exchange rate and positions.`,
        );
      }
    }
  }
  const foreignGross =
    voucher.currency === value.currency && actual.gross?.currency === value.currency
      ? actual.gross.amount
      : undefined;
  const eurGross = eur?.gross?.amount;
  const implied =
    foreignGross === undefined || eurGross === undefined || compare(foreignGross, 0) <= 0
      ? undefined
      : format(divideRounded(decimal(eurGross), decimal(foreignGross), 6), 6);
  if (
    value.exchangeRate === undefined ||
    mismatch ||
    (implied !== undefined && compare(implied, value.exchangeRate) !== 0)
  ) {
    const amounts = fields
      .map(
        (key) =>
          `${labels[key]} ${eur?.[key]?.amount === undefined ? (de ? "nicht gemeldet" : "not reported") : `${numberText(eur[key].amount, lang)} EUR`}`,
      )
      .join(", ");
    notes.push(de ? `Gespeicherte EUR-Summen: ${amounts}.` : `Stored EUR totals: ${amounts}.`);
    notes.push(
      implied === undefined
        ? de
          ? "Aus den gespeicherten Bruttosummen lässt sich kein Wechselkurs ableiten."
          : "An implied exchange rate cannot be calculated from the stored gross totals."
        : de
          ? `Aus den gerundeten Bruttosummen abgeleiteter Kurs: ungefähr 1 ${value.currency} = ${numberText(implied, lang)} EUR; kein exakt gespeicherter Kurs.`
          : `Implied rate from rounded gross totals: approximately 1 ${value.currency} = ${implied} EUR; this is not the exact stored rate.`,
    );
  }
  return notes;
}
