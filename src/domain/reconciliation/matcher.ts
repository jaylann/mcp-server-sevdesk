/**
 * Matching one bank transaction (Kontoumsatz) to open items (offene Posten): a pure, deterministic
 * scorer behind `sevdesk_reconcile_suggest`. No I/O; every amount is an exact decimal.
 *
 * Signals, each worth fixed points ({@link POINTS}):
 * - amount: the transaction's unassigned amount equals the item's open amount (strongest), is a
 *   little less (possibly Skonto), or less (a partial payment);
 * - document number in the purpose (Verwendungszweck): the whole number ("RE-1042", "RE 1042",
 *   "re1042"), or its numeric part after an invoice keyword ("Re.-Nr. 1042", "Rechnung 1042") or
 *   alone ("1042"); never inside a longer number, an IBAN, a date, an amount or after a customer
 *   number keyword ("Kd-Nr. 1042");
 * - counterparty name against the contact name, normalized (case, umlauts, accents, legal forms
 *   such as GmbH, UG (haftungsbeschränkt), GmbH & Co. KG stripped), or the contact name in the
 *   purpose; the counterparty's IBAN against the contact's, when known;
 * - date distance between the value date and the document date.
 *
 * Hard rules: the direction must fit (money in ↔ invoices and revenue vouchers, money out ↔
 * credit note payouts and expense vouchers) and the currency must be the transaction's (sevDesk
 * links only documents in the check account's currency, `checkPaymentTransaction`).
 *
 * Splits: a bounded subset search finds 2–4 items whose open amounts add up exactly to the
 * transaction amount, trying items of the best-matching contact and items named in the purpose
 * first, and stopping after a fixed number of combinations.
 *
 * Reasons are trusted text written here: they quote no purpose, name or number, only our own
 * amounts and counts.
 */
import { compare, decimal, type DecimalLike, money, subtract, toDecimalString } from "../money.js";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/** The document kinds an open item can be. */
type CandidateKind = "invoice" | "creditNote" | "voucher";

/** The transaction side of a match. Text fields are untrusted (cleaned) upstream text. */
export interface MatchTransaction {
  readonly id: number;
  /** Amount still free to assign, positive exact decimal (the remaining amount). */
  readonly available: string;
  readonly direction: "in" | "out";
  readonly currency: string;
  readonly valueDate: string | undefined;
  readonly counterparty: string | undefined;
  readonly purpose: string | undefined;
  /** Counterparty IBAN (letters and digits), when sevDesk has it. */
  readonly iban?: string | undefined;
}

/** One open item that could be paid by the transaction. */
export interface OpenItemCandidate {
  readonly kind: CandidateKind;
  readonly id: number;
  /** Document number, or a voucher's Belegnummer (cleaned upstream text). */
  readonly number: string | undefined;
  readonly contactId: number | undefined;
  /** Customer or supplier name (cleaned upstream text). */
  readonly contactName: string | undefined;
  /** Positive exact open amount (gross minus paid) in `currency`. */
  readonly open: string;
  readonly currency: string;
  /** How a payment moves money: in for invoices and revenue, out for payouts and expenses. */
  readonly direction: "in" | "out";
  readonly date: string | undefined;
  readonly dueDate: string | undefined;
  /** IBANs of the contact, letters and digits, when known. */
  readonly ibans?: readonly string[] | undefined;
}

type Confidence = "high" | "medium" | "low";

export type NumberSignal = "full" | "keyword" | "bare";
type AmountSignal = "exact" | "skonto" | "partial" | "larger";

/** A single open item matched to the transaction. */
export interface SingleMatch {
  readonly type: "single";
  readonly candidate: OpenItemCandidate;
  /** Proposed allocation: the open amount, or the transaction's free amount if less. */
  readonly amount: string;
  readonly score: number;
  readonly confidence: Confidence;
  readonly reasons: readonly string[];
  readonly signals: {
    readonly amount: AmountSignal;
    readonly number: NumberSignal | undefined;
    /** Name similarity 0–1 (two decimals). */
    readonly name: number;
    readonly iban: boolean;
  };
}

/** Several open items whose open amounts add up exactly to the transaction's free amount. */
export interface SplitMatch {
  readonly type: "split";
  readonly parts: readonly OpenItemCandidate[];
  readonly score: number;
  readonly confidence: Confidence;
  readonly reasons: readonly string[];
}

export type Match = SingleMatch | SplitMatch;

export interface MatchOptions {
  /** Most single matches returned (default 5). */
  readonly maxSingles?: number;
  /** Most split matches returned (default 3). */
  readonly maxSplits?: number;
  /** Most subsets the split search examines (default {@link MAX_SPLIT_COMBINATIONS}). */
  readonly maxCombinations?: number;
  /** Most items the split search draws from (default 24). */
  readonly splitPool?: number;
}

export interface MatchResult {
  /** Singles and splits together, best first (score, then kind and id). */
  readonly matches: readonly Match[];
  /** Candidates left out by the hard rules. */
  readonly excluded: { readonly direction: number; readonly currency: number };
  readonly splitSearch: { readonly combinations: number; readonly capped: boolean };
}

/** Points per signal. A single needs {@link MIN_SINGLE_SCORE} to be listed. */
export const POINTS = {
  amountExact: 50,
  amountSkonto: 15,
  amountPartial: 5,
  numberFull: 40,
  numberKeyword: 35,
  numberBare: 25,
  nameStrong: 25,
  namePartial: 12,
  nameInPurpose: 8,
  iban: 30,
  dateClose: 5,
  dateBefore: -10,
  dateFar: -5,
  splitBase: 40,
  splitNumber: 10,
  splitSameContact: 15,
  splitNameMatch: 10,
} as const;

export const MIN_SINGLE_SCORE = 20;
const MAX_SPLIT_COMBINATIONS = 20_000;
/** Name similarity from which a name counts as matching (strong) or similar (partial). */
const NAME_STRONG = 0.85;
const NAME_PARTIAL = 0.5;
/** A shortfall up to this share of the open amount reads as a possible cash discount. */
const SKONTO_SHARE = "0.03";
const DATE_CLOSE_DAYS = 60;
const DATE_FAR_DAYS = 365;
/** Payments a few days before the document date happen (prepayment, booking delays). */
const DATE_BEFORE_TOLERANCE = 3;

const KIND_ORDER: Readonly<Record<CandidateKind, number>> = {
  invoice: 0,
  creditNote: 1,
  voucher: 2,
};

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/**
 * Scores every candidate against the transaction and searches splits. Deterministic: the same
 * inputs give the same matches in the same order, whatever the order of `candidates`.
 */
export function matchTransaction(
  transaction: MatchTransaction,
  candidates: readonly OpenItemCandidate[],
  options: MatchOptions = {},
): MatchResult {
  const maxSingles = options.maxSingles ?? 5;
  const maxSplits = options.maxSplits ?? 3;
  const excluded = { direction: 0, currency: 0 };
  const eligible: OpenItemCandidate[] = [];
  for (const candidate of [...candidates].sort(byKindAndId)) {
    if (candidate.direction !== transaction.direction) excluded.direction += 1;
    else if (candidate.currency !== transaction.currency) excluded.currency += 1;
    else if (compare(candidate.open, 0) > 0) eligible.push(candidate);
  }
  if (compare(transaction.available, 0) <= 0) {
    return { matches: [], excluded, splitSearch: { combinations: 0, capped: false } };
  }

  const purpose = preparePurpose(transaction.purpose);
  const counterparty = nameTokens(transaction.counterparty);
  const scored = eligible.map((candidate) =>
    scoreSingle(transaction, candidate, purpose, counterparty),
  );
  const singles = scored
    .filter((match) => match.score >= MIN_SINGLE_SCORE)
    .sort(byScore)
    .slice(0, maxSingles);
  markAmbiguity(singles);

  const search = searchSplits(transaction, scored, options);
  const splits = search.splits.sort(byScore).slice(0, maxSplits);

  const matches: Match[] = [...singles, ...splits].sort(byScore);
  return {
    matches,
    excluded,
    splitSearch: { combinations: search.combinations, capped: search.capped },
  };
}

function scoreSingle(
  transaction: MatchTransaction,
  candidate: OpenItemCandidate,
  purpose: PreparedPurpose,
  counterparty: readonly string[],
): SingleMatch {
  const reasons: string[] = [];
  let score = 0;
  const show = (value: DecimalLike): string =>
    `${money(value, candidate.currency).amount} ${candidate.currency}`;

  // Amount.
  const versus = compare(transaction.available, candidate.open);
  let amountSignal: AmountSignal;
  if (versus === 0) {
    amountSignal = "exact";
    score += POINTS.amountExact;
    reasons.push(`Exact open amount (${show(candidate.open)}).`);
  } else if (versus < 0) {
    const shortfall = subtract(candidate.open, transaction.available);
    const limit = decimal(roundUpCents(multiplyShare(candidate.open)));
    if (compare(shortfall, limit) <= 0) {
      amountSignal = "skonto";
      score += POINTS.amountSkonto;
      reasons.push(
        `${show(shortfall)} less than the open amount of ${show(candidate.open)}: possibly ` +
          `Skonto (cash discount); if so, book it with paymentType cash_discount.`,
      );
    } else {
      amountSignal = "partial";
      score += POINTS.amountPartial;
      reasons.push(
        `Would be a partial payment: ${show(transaction.available)} of ${show(candidate.open)} open.`,
      );
    }
  } else {
    amountSignal = "larger";
    reasons.push(
      `The transaction is ${show(subtract(transaction.available, candidate.open))} more than ` +
        `the open amount; that rest would stay unassigned.`,
    );
  }

  // Document number in the purpose.
  const numberSignal = findDocumentNumber(purpose, candidate.number);
  if (numberSignal === "full") {
    score += POINTS.numberFull;
    reasons.push("The document number appears in the purpose.");
  } else if (numberSignal === "keyword") {
    score += POINTS.numberKeyword;
    reasons.push(
      "The digits of the document number appear in the purpose after an invoice keyword.",
    );
  } else if (numberSignal === "bare") {
    score += POINTS.numberBare;
    reasons.push("The digits of the document number appear in the purpose.");
  }

  // Counterparty name, contact name in the purpose, IBAN.
  const contact = nameTokens(candidate.contactName);
  const similarity = nameSimilarity(counterparty, contact);
  if (similarity >= NAME_STRONG) {
    score += POINTS.nameStrong;
    reasons.push(
      `The counterparty's name matches the contact (similarity ${similarity.toFixed(2)}).`,
    );
  } else if (similarity >= NAME_PARTIAL) {
    score += POINTS.namePartial;
    reasons.push(
      `The counterparty's name is similar to the contact's (similarity ${similarity.toFixed(2)}).`,
    );
  } else if (contactNameInPurpose(contact, purpose)) {
    score += POINTS.nameInPurpose;
    reasons.push("The contact's name appears in the purpose.");
  }
  const iban =
    transaction.iban !== undefined &&
    transaction.iban !== "" &&
    (candidate.ibans ?? []).some((value) => value === transaction.iban);
  if (iban) {
    score += POINTS.iban;
    reasons.push("The counterparty's IBAN is a bank account of the contact.");
  }

  // Date distance.
  const reference = candidate.date ?? candidate.dueDate;
  if (transaction.valueDate !== undefined && reference !== undefined) {
    const days = daysBetween(reference, transaction.valueDate);
    if (days < -DATE_BEFORE_TOLERANCE) {
      score += POINTS.dateBefore;
      reasons.push(`The value date is ${-days} days before the document date.`);
    } else if (days > DATE_FAR_DAYS) {
      score += POINTS.dateFar;
      reasons.push("The value date is more than a year after the document date.");
    } else if (days <= DATE_CLOSE_DAYS) {
      score += POINTS.dateClose;
      reasons.push(
        days < 0
          ? `The value date is ${-days} days before the document date.`
          : `The value date is ${days} days after the document date.`,
      );
    }
  }

  const amount =
    versus >= 0 ? toDecimalString(candidate.open) : toDecimalString(transaction.available);
  const strongName = similarity >= NAME_STRONG;
  let confidence: Confidence;
  if (amountSignal === "exact" && (numberSignal !== undefined || strongName || iban)) {
    confidence = "high";
  } else if (
    amountSignal === "exact" ||
    numberSignal === "full" ||
    numberSignal === "keyword" ||
    (amountSignal === "skonto" && (numberSignal !== undefined || strongName))
  ) {
    confidence = "medium";
  } else {
    confidence = "low";
  }
  return {
    type: "single",
    candidate,
    amount: money(amount, candidate.currency).amount,
    score,
    confidence,
    reasons,
    signals: {
      amount: amountSignal,
      number: numberSignal,
      name: Math.round(similarity * 100) / 100,
      iban,
    },
  };
}

/**
 * Two equally good high-confidence singles are a coin toss: both are lowered to medium and say
 * so, so nobody books the first one blindly.
 */
function markAmbiguity(singles: SingleMatch[]): void {
  const [first, second] = singles;
  if (first === undefined || second === undefined) return;
  if (first.confidence !== "high" || first.score !== second.score) return;
  for (let index = 0; index < singles.length; index += 1) {
    const match = singles[index];
    if (match === undefined || match.score !== first.score || match.confidence !== "high") continue;
    singles[index] = {
      ...match,
      confidence: "medium",
      reasons: [...match.reasons, "Another open item fits equally well; check which one was paid."],
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------------------------

interface SplitSearch {
  readonly splits: SplitMatch[];
  readonly combinations: number;
  readonly capped: boolean;
}

/**
 * Depth-first search over subsets of 2–4 items whose open amounts add up exactly to the
 * transaction's free amount. The pool holds items not larger than that amount, best first: named
 * in the purpose, then by name similarity, then by contact, due date and id. Every subset
 * examined counts toward the cap; amounts are positive, so a running sum above the target prunes.
 */
function searchSplits(
  transaction: MatchTransaction,
  scored: readonly SingleMatch[],
  options: MatchOptions,
): SplitSearch {
  const maxCombinations = options.maxCombinations ?? MAX_SPLIT_COMBINATIONS;
  const poolSize = options.splitPool ?? 24;
  const pool = scored
    .filter((match) => compare(match.candidate.open, transaction.available) < 0)
    .sort(byPoolPriority)
    .slice(0, poolSize);
  const scale = Math.max(
    decimal(transaction.available).scale,
    ...pool.map((match) => decimal(match.candidate.open).scale),
  );
  const target = toUnits(transaction.available, scale);
  const amounts = pool.map((match) => toUnits(match.candidate.open, scale));

  const found: SplitMatch[] = [];
  let combinations = 0;
  let capped = false;
  const chosen: number[] = [];
  const visit = (start: number, sum: bigint): void => {
    for (let index = start; index < pool.length; index += 1) {
      if (capped) return;
      const amount = amounts[index] ?? 0n;
      const next = sum + amount;
      if (next > target) continue;
      chosen.push(index);
      if (chosen.length >= 2) {
        combinations += 1;
        if (combinations > maxCombinations) {
          capped = true;
          combinations = maxCombinations;
          chosen.pop();
          return;
        }
        if (next === target) {
          found.push(scoreSplit(transaction, chosen.map((i) => pool[i]).filter(isDefined)));
        }
      }
      if (chosen.length < 4 && next < target) visit(index + 1, next);
      chosen.pop();
    }
  };
  visit(0, 0n);
  return { splits: found, combinations, capped };
}

function scoreSplit(transaction: MatchTransaction, parts: readonly SingleMatch[]): SplitMatch {
  const currency = transaction.currency;
  const reasons = [
    `${parts.length} open items add up exactly to ${money(transaction.available, currency).amount} ${currency}.`,
  ];
  let score = POINTS.splitBase;
  const named = parts.filter((part) => part.signals.number !== undefined).length;
  score += named * POINTS.splitNumber;
  if (named === parts.length) {
    reasons.push("Every document number appears in the purpose.");
  } else if (named > 0) {
    reasons.push(`${named} of the ${parts.length} document numbers appear in the purpose.`);
  }
  const contacts = new Set(parts.map((part) => part.candidate.contactId ?? -part.candidate.id));
  const sameContact = contacts.size === 1;
  if (sameContact) {
    score += POINTS.splitSameContact;
    reasons.push("All items belong to the same contact.");
  }
  const nameMatch = parts.every((part) => part.signals.name >= NAME_STRONG);
  if (sameContact && nameMatch) {
    score += POINTS.splitNameMatch;
    reasons.push("The counterparty's name matches that contact.");
  }
  const confidence: Confidence =
    named === parts.length ? "high" : sameContact && nameMatch ? "medium" : "low";
  return {
    type: "split",
    parts: parts.map((part) => part.candidate),
    score,
    confidence,
    reasons,
  };
}

function byPoolPriority(a: SingleMatch, b: SingleMatch): number {
  const named = Number(b.signals.number !== undefined) - Number(a.signals.number !== undefined);
  if (named !== 0) return named;
  if (b.signals.name !== a.signals.name) return b.signals.name - a.signals.name;
  const contactA = a.candidate.contactId ?? Number.MAX_SAFE_INTEGER;
  const contactB = b.candidate.contactId ?? Number.MAX_SAFE_INTEGER;
  if (contactA !== contactB) return contactA - contactB;
  const dueA = a.candidate.dueDate ?? a.candidate.date ?? "9999-12-31";
  const dueB = b.candidate.dueDate ?? b.candidate.date ?? "9999-12-31";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  return byKindAndId(a.candidate, b.candidate);
}

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

function byKindAndId(
  a: Pick<OpenItemCandidate, "kind" | "id">,
  b: Pick<OpenItemCandidate, "kind" | "id">,
): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id;
}

/** Score descending; ties: singles before splits, then kind and id (of the first part). */
function byScore(a: Match, b: Match): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.type !== b.type) return a.type === "single" ? -1 : 1;
  const keyA = a.type === "single" ? [a.candidate] : a.parts;
  const keyB = b.type === "single" ? [b.candidate] : b.parts;
  for (let index = 0; index < Math.max(keyA.length, keyB.length); index += 1) {
    const x = keyA[index];
    const y = keyB[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const order = byKindAndId(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Document numbers in the purpose
// ---------------------------------------------------------------------------------------------

/** The purpose prepared for number search: ASCII-folded, with IBANs, dates and amounts blanked. */
export interface PreparedPurpose {
  /** Same length as the folded purpose; masked spans are spaces. */
  readonly text: string;
  /** Lower-case alphanumeric words of the unmasked purpose, for name checks. */
  readonly words: ReadonlySet<string>;
}

/**
 * IBAN: two capital letters, two check digits, then groups of four capitals or digits (a space
 * between groups allowed) and a short last group. Blanked only with at least 12 digits (see
 * {@link blankIbans}), so a number like "RE20260042" is not taken for one.
 */
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const DATE_PATTERNS = [
  /\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})(?!\d)/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})(?!\d)/g,
];
/** Amounts with cents: "1.042,00", "1042,00", "1,042.00", "1042.00". */
const AMOUNT_PATTERNS = [/\b\d{1,3}(?:[.,]\d{3})+[.,]\d{2}(?!\d)/g, /\b\d+[.,]\d{2}(?![\d.,])/g];

/**
 * The last word before a number makes it a document number (Rechnung, Re.-Nr., Beleg, Invoice
 * No., …): the keyword, optionally followed by "Nr"/"No"/"Nummer", then only punctuation.
 */
const DOCUMENT_KEYWORD =
  /(?:^|[^a-z])(?:re|rg|rgn|r|rech|rechn|rechnung|rechnungs|inv|invoice|beleg|belegs|gutschrift|gs|gu|ref|referenz|nr|no|nummer)\W*(?:nr|no|nummer)?\W*$/i;
/**
 * The last word before a number makes it another kind of number (Kunden-Nr., Kd-Nr., Mandat,
 * Vertrag, Auftrag, Bestellung, Telefon, Konto, SEPA references EREF/KREF/MREF, …); checked first.
 */
const OTHER_KEYWORD =
  /(?:^|[^a-z])(?:kunde|kd|knr|mandat|vertrag|auftrag|bestell|order|kassenzeichen|steuer|ust|tel|konto|kto|iban|bic|blz|plz|eref|kref|mref|cred|svwz|pers|personal)\w*\W*(?:nr|no|nummer|ref|referenz|id)?\W*$/i;

/** ASCII folding: umlauts spelled out, accents dropped, everything else non-ASCII to a space. */
export function foldText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, " ");
}

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

/** Blanks IBAN-shaped spans with at least 12 digits (German IBANs have 20). */
function blankIbans(text: string): string {
  return text.replace(IBAN_PATTERN, (match) =>
    (match.match(/\d/g) ?? []).length >= 12 ? " ".repeat(match.length) : match,
  );
}

/** Folds the purpose and blanks IBANs, dates and amounts (see {@link PreparedPurpose}). */
export function preparePurpose(purpose: string | undefined): PreparedPurpose {
  const folded = foldText(purpose ?? "");
  let text = blankIbans(folded);
  for (const pattern of [...DATE_PATTERNS, ...AMOUNT_PATTERNS]) text = blank(text, pattern);
  const words = new Set(
    (folded.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 0),
  );
  return { text, words };
}

const SEPARATOR = "[\\s\\-_./#:]*";
/** Significant digits a number's numeric part needs to count after a keyword, or alone. */
const MIN_KEYWORD_DIGITS = 3;
const MIN_BARE_DIGITS = 4;
/** Significant digits from which a numeric part of several groups counts as the whole number. */
const MIN_DISTINCTIVE_DIGITS = 5;

/**
 * Where a document number appears in a prepared purpose: `full` (letters and digits, separators
 * free: "RE-1042" also as "RE 1042", "re1042"), `keyword` (the numeric part after a document
 * keyword: "Re.-Nr. 1042", "Rechnung 1042"), `bare` (the numeric part alone, at least three
 * significant digits, not after another kind of number's keyword), or `undefined`. Leading zeros
 * of the numeric part are optional on both sides. Never matches inside a longer word or number.
 */
export function findDocumentNumber(
  purpose: PreparedPurpose,
  number: string | undefined,
): NumberSignal | undefined {
  if (number === undefined) return undefined;
  const groups = foldText(number).match(/[A-Za-z]+|\d+/g) ?? [];
  if (groups.length === 0) return undefined;
  const firstDigits = groups.findIndex((group) => /^\d/.test(group));
  const prefix = firstDigits === -1 ? groups : groups.slice(0, firstDigits);
  const body = firstDigits === -1 ? [] : groups.slice(firstDigits);
  const bodyPattern = body
    .map((group, index) =>
      index === 0 && /^\d/.test(group) ? `0*${group.replace(/^0+(?=\d)/, "")}` : group,
    )
    .join(SEPARATOR);
  const text = purpose.text;

  if (body.length === 0) {
    // A number without digits (a Belegnummer such as "Miete-Oktober"): only as a whole.
    if (prefix.join("").length < 4) return undefined;
    return testBounded(text, prefix.join(SEPARATOR)) ? "full" : undefined;
  }
  if (
    prefix.length > 0 &&
    testBounded(text, `${prefix.join(SEPARATOR)}${SEPARATOR}${bodyPattern}`)
  ) {
    return "full";
  }
  const significant = body.join("").replace(/^0+/, "").replace(/\D/g, "");
  if (significant.length < MIN_KEYWORD_DIGITS) return undefined;
  // Several groups with enough digits ("2026-0042", "2026-11-001") are distinctive as a whole.
  const distinctive = body.length > 1 && significant.length >= MIN_DISTINCTIVE_DIGITS;
  let signal: NumberSignal | undefined;
  for (const match of boundedMatches(text, bodyPattern)) {
    const before = text.slice(Math.max(0, match - 30), match);
    if (OTHER_KEYWORD.test(before)) continue;
    if (distinctive) return "full";
    if (DOCUMENT_KEYWORD.test(before)) return "keyword";
    if (significant.length >= MIN_BARE_DIGITS) signal = "bare";
  }
  return signal;
}

/**
 * Start indexes of `pattern` in `text` where it is not part of a longer word or number: no letter
 * or digit right before or after, and no digit with a decimal or date separator around it.
 */
function boundedMatches(text: string, pattern: string): number[] {
  const regex = new RegExp(
    `(?<![A-Za-z0-9])(?<!\\d[.,/-])${pattern}(?![A-Za-z0-9])(?![.,/-]\\d)`,
    "gi",
  );
  const starts: number[] = [];
  for (const match of text.matchAll(regex)) starts.push(match.index);
  return starts;
}

function testBounded(text: string, pattern: string): boolean {
  return boundedMatches(text, pattern).length > 0;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Legal-form words (and their connectors) that say nothing about who someone is. */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "gmbh",
  "mbh",
  "ggmbh",
  "ag",
  "ug",
  "haftungsbeschraenkt",
  "kg",
  "kgaa",
  "ohg",
  "gbr",
  "ek",
  "ev",
  "eg",
  "se",
  "co",
  "und",
  "partg",
  "partgmbb",
  "ltd",
  "limited",
  "inc",
  "llc",
  "llp",
  "plc",
  "corp",
  "sarl",
  "sas",
  "sa",
  "bv",
  "nv",
  "srl",
  "spa",
  "oy",
  "ab",
  "as",
  "aps",
]);

/**
 * The words of a name for comparison: folded to ASCII, lower case, split on anything but letters
 * and digits, without legal forms ("GmbH", "UG (haftungsbeschränkt)", "& Co. KG") and single
 * letters ("e.K." → nothing). Sorted and unique.
 */
export function nameTokens(name: string | undefined): string[] {
  if (name === undefined) return [];
  const words = foldText(name)
    .toLowerCase()
    .replace(/\be\.\s*k\.?/g, " ")
    .replace(/\be\.\s*v\.?/g, " ")
    .match(/[a-z0-9]+/g);
  return [
    ...new Set((words ?? []).filter((word) => word.length > 1 && !LEGAL_FORMS.has(word))),
  ].sort();
}

/** Whether two words are the same, or one is a truncation of the other (at least 4 letters). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Similarity of two token lists, 0–1: the Dice coefficient of matching words (truncations count,
 * see {@link sameWord}); at least 0.75 when every word of the shorter name is in the longer.
 */
export function nameSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let matches = 0;
  for (const word of short) {
    const index = long.findIndex((other, i) => !used.has(i) && sameWord(word, other));
    if (index >= 0) {
      used.add(index);
      matches += 1;
    }
  }
  const dice = (2 * matches) / (a.length + b.length);
  return matches === short.length && dice < 0.75 ? 0.75 : dice;
}

/** Whether every distinctive word (≥ 4 letters) of the contact's name is in the purpose. */
function contactNameInPurpose(contact: readonly string[], purpose: PreparedPurpose): boolean {
  const distinctive = contact.filter((word) => word.length >= 4);
  return distinctive.length > 0 && distinctive.every((word) => purpose.words.has(word));
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toUnits(value: DecimalLike, scale: number): bigint {
  const exact = decimal(value);
  return exact.units * 10n ** BigInt(scale - exact.scale);
}

/** `open × 3 %` (see {@link SKONTO_SHARE}). */
function multiplyShare(open: string): string {
  const exact = decimal(open);
  const share = decimal(SKONTO_SHARE);
  return toDecimalString({ units: exact.units * share.units, scale: exact.scale + share.scale });
}

/** Rounds a positive amount up to whole cents, so 3 % of 99.99 (2.9997) allows 3.00. */
function roundUpCents(value: string): string {
  const exact = decimal(value);
  if (exact.scale <= 2) return toDecimalString(exact);
  const divisor = 10n ** BigInt(exact.scale - 2);
  const cents = exact.units / divisor + (exact.units % divisor === 0n ? 0n : 1n);
  return toDecimalString({ units: cents, scale: 2 });
}

/** Calendar days from `from` to `to` (`YYYY-MM-DD`), positive when `to` is later. */
function daysBetween(from: string, to: string): number {
  const day = (date: string): number => {
    const [year = 0, month = 1, dayOfMonth = 1] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, dayOfMonth);
  };
  return Math.round((day(to) - day(from)) / 86_400_000);
}
