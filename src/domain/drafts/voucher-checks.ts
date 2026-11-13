/**
 * What a voucher (Beleg) write checks before anything is sent, in one place for create, update,
 * finalize and the e-invoice import:
 *
 * - the bookkeeping generation: voucher writes need Update 2.0 (tax rules and booking accounts);
 *   a 1.0 account is refused with a clear message;
 * - the tax rule (Steuerregel): one per voucher, of the voucher's direction (expense rules for
 *   expenses, revenue rules for revenue, "either" rules for both), fitting the account's VAT
 *   regulation (`account-settings.ts`, D-067), never 18–21 (`notSupportedFor: vouchers` in
 *   reference data). The default follows the regime: expense 9 (Vorsteuerabziehbare
 *   Aufwendungen) on regular VAT, 10 (Nicht vorsteuerabziehbare Aufwendungen, the only expense rule
 *   a Kleinunternehmer expense account allows besides reverse charge 13, D-006) on a
 *   Kleinunternehmer account; revenue 1 / 11 like the sales drafts;
 * - every position's booking account × tax rule × tax rate × direction against sevDesk's
 *   ReceiptGuidance (B2, D-006, D-065): sevDesk rejects wrong combinations only late and
 *   unhelpfully, so they are refused here with the allowed alternatives;
 * - the supplier contact exists; a possible duplicate (same supplier, Belegnummer, date and gross)
 *   is refused unless the caller says it is intended (`allowDuplicate`);
 * - the receipt file is read only through the call's `FileAccess`: from `SEVDESK_FILE_DIRS`
 *   (`readConfinedFile`) or, over HTTP with file transfer, from the caller's own uploads.
 *
 * Messages are trusted text: ids, our labels and reference-data names only.
 */
import { createHash } from "node:crypto";

import type { FileAccess } from "../../safety/file-access.js";
import type { LocalFileKind } from "../../safety/local-files.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import { getBookkeepingSystemVersion } from "../../sevdesk/system-version.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { loadAccountSettings, type TaxRegime, taxRegimeOf } from "../account-settings.js";
import {
  type AccountDatevList,
  findAccountDatev,
  isValidOn,
  loadAccountsDatev,
} from "../accounts-datev.js";
import { cleanText } from "../common.js";
import { parseContactRecord, toContactDto } from "../contacts.js";
import { add, compare, decimal, format } from "../money.js";
import { dateText, type Phrase, phrase, type PreviewLanguage } from "../preview-text.js";
import {
  loadReceiptGuidance,
  type ReceiptGuide,
  validateAccountTaxRule,
} from "../receipt-guidance.js";
import { TAX_RULES, type TaxRule, taxRuleById } from "../reference-data.js";
import { listVouchers, type VoucherKind } from "../vouchers.js";
import { type Amounts, positionAmounts } from "./positions.js";
import {
  checkTaxRuleRegime,
  checkTaxRuleUseCase,
  resolveTaxRates,
  type RuleScope,
  taxRuleFor,
  taxRuleWarnings,
  UNKNOWN_REGIME_WARNING,
  UNKNOWN_REGIME_WARNING_DE,
} from "./tax.js";
import type { ReceiptFile } from "./voucher-payload.js";

/** Per-call context of a voucher `prepare`. */
export interface VoucherCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Owner of the settings, guidance and account caches: tools pass `ctx.config`. */
  readonly cacheOwner: object;
  /** Where receipt files come from: tools pass `ctx.files`. */
  readonly files: FileAccess;
}

/** How position amounts are entered: `gross` (Brutto, the default for receipts) or `net`. */
export const AMOUNT_MODES = ["gross", "net"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

/** Positions per voucher a tool accepts in one call. */
export const MAX_VOUCHER_POSITIONS = 50;

/** Largest receipt file read (from disk or an upload): 20 MiB. */
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;

/**
 * File kinds a receipt (Belegbild) of a manual draft may have: PDF, PNG, JPEG (M4 probe: sevDesk
 * takes them; plain text is refused with 415). An XML is an e-invoice and goes through the import
 * ({@link EINVOICE_FILE_KINDS}), which checks it before booking.
 */
const RECEIPT_FILE_KINDS = ["pdf", "png", "jpeg"] as const;

/** File kinds the e-invoice import reads: a ZUGFeRD/Factur-X PDF or an XRechnung XML. */
export const EINVOICE_FILE_KINDS = ["pdf", "xml"] as const;

/**
 * Whether the e-invoice import attaches a bare XML (an XRechnung) through `uploadTempFile`.
 * Verified by the M4 probe (run 4, 2026-11-08): `application/xml` is accepted (token `<hex>.xml`,
 * `isEInvoice: true`) and the draft gets a `document`. Kept as one switch: with `xml: false` the
 * import saves the voucher without attachment and its preview says so.
 */
export const RECEIPT_UPLOADS: { readonly xml: boolean } = { xml: true };

const REFERENCE_HINT = "sevdesk_reference_lookup kind=receipt_guidance";

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping generation and regime
// ---------------------------------------------------------------------------------------------

/**
 * Refuses accounts on bookkeeping system 1.0 (voucher writes need Update 2.0). `cacheOwner` is
 * the owner of the version cache (callers pass `options.cacheOwner`, i.e. `ctx.config`); without
 * it the version is cached per client, which a write preparation gets anew on every call.
 */
export async function assertUpdate2(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
  cacheOwner?: object,
): Promise<void> {
  if ((await getBookkeepingSystemVersion(client, signal, { cacheOwner })) === "2.0") return;
  refuse(
    "This sevDesk account still uses bookkeeping system 1.0. Voucher writes need sevDesk " +
      "Update 2.0 (tax rules and booking accounts); create the voucher (Beleg) in the sevDesk " +
      "web app, or move the account to Update 2.0 first.",
  );
}

/** The account's VAT regulation through the cache; `undefined` when it cannot be read. */
export async function voucherRegime(
  client: SevdeskClient,
  options: VoucherCallOptions,
): Promise<TaxRegime | undefined> {
  return taxRegimeOf(
    await loadAccountSettings(client, { cacheOwner: options.cacheOwner, signal: options.signal }),
  );
}

// ---------------------------------------------------------------------------------------------
// Tax rule
// ---------------------------------------------------------------------------------------------

/** The rule a voucher gets when the call names none, per direction and regime. */
const DEFAULT_VOUCHER_RULES: Readonly<Record<VoucherKind, Record<TaxRegime, number>>> = {
  expense: { regular: 9, small_business: 10 },
  revenue: { regular: 1, small_business: 11 },
};

/** The rules a voucher of `kind` may name (its direction plus "either"); 18–21 are refused later. */
export function voucherRuleScope(kind: VoucherKind): RuleScope {
  return {
    allowedRuleIds: TAX_RULES.filter(
      (rule) => rule.direction === kind || rule.direction === "either",
    ).map((rule) => rule.id),
    documents: `${kind} vouchers`,
  };
}

/** A resolved tax rule with the preview warnings it brings. */
export interface VoucherRule {
  readonly rule: TaxRule;
  readonly warnings: readonly string[];
}

/**
 * The tax rule of a new voucher (or a new rule on an update): `taxRuleId`, else the regime's
 * default. Refuses an unknown rule, a rule of the other direction, one that does not fit the
 * regime and the rules sevDesk does not support for vouchers (18–21).
 */
export function resolveVoucherRule(
  kind: VoucherKind,
  taxRuleId: number | undefined,
  regime: TaxRegime | undefined,
  lang: PreviewLanguage = "en",
): VoucherRule {
  const scope = voucherRuleScope(kind);
  const ruleId = taxRuleId ?? DEFAULT_VOUCHER_RULES[kind][regime ?? "regular"];
  const named = taxRuleById(ruleId);
  if (named !== undefined) checkTaxRuleRegime(named, regime, scope);
  const rule = taxRuleFor(ruleId, scope);
  checkTaxRuleUseCase(rule, "vouchers", "voucher");
  return {
    rule,
    warnings: [
      ...(regime === undefined
        ? [lang === "de" ? UNKNOWN_REGIME_WARNING_DE : UNKNOWN_REGIME_WARNING]
        : []),
      ...taxRuleWarnings(rule, regime, lang),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** One position as a tool takes it. */
export interface VoucherPositionInput {
  readonly accountDatevId: number;
  /** Exact positive decimal, net or gross as the voucher's amount mode says. */
  readonly amount: string;
  /** Percent as an exact decimal, e.g. "19"; may be left out when the rule allows one rate. */
  readonly taxRate?: string | undefined;
  readonly comment?: string | undefined;
  readonly isAsset?: boolean | undefined;
}

/** A checked position. */
export interface VoucherPosition {
  readonly accountDatevId: number;
  readonly amount: string;
  /** Exact decimal string, e.g. "19". */
  readonly taxRate: string;
  /** The rate as the JSON number sevDesk and ReceiptGuidance take. */
  readonly taxRateNumber: number;
  readonly comment?: string | undefined;
  readonly isAsset: boolean;
}

/**
 * The positions with their tax rates checked against the rule (`resolveTaxRates`: a missing rate
 * takes the rule's only rate). Every rate must be a plain number that converts exactly (B2: the
 * ReceiptGuidance check compares numbers).
 */
export function resolveVoucherPositions(
  rule: TaxRule,
  inputs: readonly VoucherPositionInput[],
  regime: TaxRegime | undefined,
): VoucherPosition[] {
  const rates = resolveTaxRates(rule, inputs, undefined, regime);
  return inputs.map((input, index) => {
    const taxRate = rates[index] ?? "0";
    return {
      accountDatevId: input.accountDatevId,
      amount: input.amount,
      taxRate,
      taxRateNumber: exactRate(taxRate, index),
      comment: input.comment,
      isAsset: input.isAsset ?? false,
    };
  });
}

/** `rate` as a number, refused unless it is a plain decimal from 0 to 100 that converts exactly. */
export function exactRate(rate: string, index: number): number {
  const number = /^\d{1,3}(\.\d+)?$/.test(rate) ? Number(rate) : Number.NaN;
  if (!Number.isFinite(number) || number > 100 || compare(String(number), rate) !== 0) {
    refuse(`Position ${String(index + 1)} has a tax rate that is not a plain percentage.`);
  }
  return number;
}

/** Net, tax and gross of one position (sevDesk's rounding: per position, to cents). */
export function voucherPositionAmounts(position: VoucherPosition, mode: AmountMode): Amounts {
  return positionAmounts(
    {
      name: "position",
      quantity: "1",
      unitPrice: position.amount,
      taxRate: position.taxRate,
      unitId: 1,
    },
    mode,
  );
}

/** The voucher totals we expect sevDesk to compute from the positions. */
export function expectedVoucherTotals(
  positions: readonly VoucherPosition[],
  mode: AmountMode,
): Amounts {
  let net = decimal(0);
  let tax = decimal(0);
  let gross = decimal(0);
  for (const position of positions) {
    const amounts = voucherPositionAmounts(position, mode);
    net = add(net, amounts.net);
    tax = add(tax, amounts.tax);
    gross = add(gross, amounts.gross);
  }
  return { net: format(net, 2), tax: format(tax, 2), gross: format(gross, 2) };
}

// ---------------------------------------------------------------------------------------------
// Booking accounts (ReceiptGuidance B2, AccountDatev)
// ---------------------------------------------------------------------------------------------

/** What the account checks found, for the preview. */
export interface AccountCheck {
  /** In both preview languages; a draft preview (English only) takes `.en`. */
  readonly warnings: readonly Phrase[];
  /** Preview label per account id ("6815 Bürobedarf"; contains sevDesk text, facts only). */
  readonly labels: ReadonlyMap<number, string>;
  /** The same labels as the German preview writes them ("… (Konto 4266)"). */
  readonly labelsDe: ReadonlyMap<number, string>;
}

/**
 * Checks every position's account × rule × rate × direction against the cached ReceiptGuidance
 * and refuses with every problem found (B2), before anything is written. Then names the accounts
 * from the cached AccountDatev list (falling back to the guidance's number and name when that
 * undocumented list cannot be read) and warns about deactivated accounts and accounts not valid
 * on the voucher date.
 */
export async function checkVoucherAccounts(
  client: SevdeskClient,
  kind: VoucherKind,
  rule: TaxRule,
  positions: readonly Pick<VoucherPosition, "accountDatevId" | "taxRateNumber">[],
  voucherDate: string,
  options: VoucherCallOptions,
): Promise<AccountCheck> {
  const cacheOptions = { cacheOwner: options.cacheOwner, signal: options.signal };
  const problems: string[] = [];
  const warnings: Phrase[] = [];
  for (const [index, position] of positions.entries()) {
    const check = await validateAccountTaxRule(
      client,
      {
        accountDatevId: position.accountDatevId,
        taxRuleId: rule.id,
        taxRate: position.taxRateNumber,
        direction: kind,
      },
      cacheOptions,
    );
    for (const problem of check.problems) {
      problems.push(`Position ${String(index + 1)}: ${problem.message}`);
    }
    for (const warning of check.warnings) {
      if (!warnings.some((known) => known.en === warning.en)) warnings.push(warning);
    }
  }
  if (problems.length > 0) {
    refuse(
      `${problems.join(" ")} Nothing was sent to sevDesk. The allowed combinations per account ` +
        `are listed by ${REFERENCE_HINT}.`,
    );
  }

  const guides = (await loadReceiptGuidance(client, { kind: "all" }, cacheOptions)).guides;
  const accounts = await accountsOrNone(client, options);
  const labels = new Map<number, string>();
  const labelsDe = new Map<number, string>();
  for (const position of positions) {
    const accountId = position.accountDatevId;
    if (labels.has(accountId)) continue;
    labels.set(accountId, voucherAccountLabel(accounts, guides, accountId));
    labelsDe.set(accountId, voucherAccountLabel(accounts, guides, accountId, "de"));
    const account = accounts === undefined ? undefined : findAccountDatev(accounts, accountId);
    if (account === undefined) continue;
    if (!account.active) {
      warnings.push(
        phrase(
          `Account ${String(accountId)} is deactivated in sevDesk's chart of accounts.`,
          `Das Konto ${String(accountId)} ist im Kontenplan von sevDesk deaktiviert.`,
        ),
      );
    } else if (!isValidOn(account, voucherDate)) {
      warnings.push(
        phrase(
          `Account ${String(accountId)} is not valid on the voucher date ${voucherDate} in ` +
            "sevDesk's chart of accounts; sevDesk may refuse to book it.",
          `Das Konto ${String(accountId)} ist im Kontenplan von sevDesk am Belegdatum ` +
            `${dateText(voucherDate, "de")} nicht gültig; sevDesk lehnt die Buchung ` +
            "möglicherweise ab.",
        ),
      );
    }
  }
  return { warnings, labels, labelsDe };
}

/** The AccountDatev list, or `undefined` when the undocumented endpoint cannot be read. */
async function accountsOrNone(
  client: SevdeskClient,
  options: VoucherCallOptions,
): Promise<AccountDatevList | undefined> {
  try {
    return await loadAccountsDatev(client, {
      cacheOwner: options.cacheOwner,
      signal: options.signal,
    });
  } catch (error) {
    if (
      error instanceof SevdeskError &&
      ["not_found", "validation", "server", "unexpected_response"].includes(error.kind)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * "6815 Bürobedarf (account 4266)": the AccountDatev number and name, else the guidance's, else
 * the bare id. Contains sevDesk text: for preview facts only.
 */
export function voucherAccountLabel(
  accounts: AccountDatevList | undefined,
  guides: readonly ReceiptGuide[],
  accountId: number,
  lang: PreviewLanguage = "en",
): string {
  const account = accounts === undefined ? undefined : findAccountDatev(accounts, accountId);
  const guide = guides.find((entry) => entry.accountDatevId === accountId);
  const number = account?.number ?? guide?.accountNumber;
  const name = account?.name ?? guide?.accountName;
  const digits = number !== undefined && /^\d{1,12}$/.test(number) ? number : undefined;
  const text = [digits, name].filter((part): part is string => part !== undefined).join(" ");
  const word = lang === "de" ? "Konto" : "account";
  return text === "" ? `${word} ${String(accountId)}` : `${text} (${word} ${String(accountId)})`;
}

// ---------------------------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------------------------

/** The supplier (or customer) contact's display name; an unknown id is a trusted refusal. */
export async function loadSupplierName(
  client: SevdeskClient,
  contactId: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const key = toSevdeskId(contactId);
  let payload: unknown;
  try {
    payload = await client.request({
      method: "GET",
      path: sevdeskPath("Contact", key),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      refuse(
        `Contact ${String(key)} does not exist in sevDesk. Find the supplier with ` +
          "sevdesk_contacts_search, or pass supplierName instead of supplierId.",
      );
    }
    throw error;
  }
  return toContactDto(parseContactRecord(expectSingle(payload, `contact ${String(key)}`)))
    .displayName;
}

/** The supplier as a preview value: "Bürohaus GmbH (contact 1003)" or "Bürohaus (no contact)". */
export function supplierText(
  name: string | undefined,
  contactId: number | undefined,
  lang: PreviewLanguage = "en",
): string {
  const german = lang === "de";
  const shown = cleanText(name, 200) ?? (german ? "(ohne Namen)" : "(unnamed)");
  if (contactId === undefined) return `${shown} (${german ? "kein Kontakt" : "no contact"})`;
  return `${shown} (${german ? "Kontakt" : "contact"} ${String(contactId)})`;
}

// ---------------------------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------------------------

/** Rows checked; one supplier rarely has more vouchers on one day. */
const DUPLICATE_SCAN_LIMIT = 25;

export interface VoucherDuplicateQuery {
  readonly kind: VoucherKind;
  readonly supplierId?: number | undefined;
  readonly supplierName?: string | undefined;
  /** Belegnummer; when absent, supplier, date and gross decide. */
  readonly number?: string | undefined;
  /** Voucher date, `YYYY-MM-DD`. */
  readonly date: string;
  /** Expected gross total with two decimals, EUR. */
  readonly gross: string;
}

/**
 * Ids of existing vouchers of the same kind with the same supplier (contact or name), Belegnummer,
 * date and gross total (sevDesk's filters narrow the list, the comparison here is exact).
 */
export async function findVoucherDuplicates(
  client: SevdeskClient,
  query: VoucherDuplicateQuery,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  const result = await listVouchers(
    client,
    {
      kind: query.kind,
      supplierId: query.supplierId,
      supplierName: query.supplierId === undefined ? query.supplierName : undefined,
      description: query.number,
      from: query.date,
      to: query.date,
      limit: DUPLICATE_SCAN_LIMIT,
      offset: 0,
    },
    signal,
  );
  const same = (a: string | undefined, b: string | undefined): boolean =>
    normalize(a) === normalize(b);
  return result.items
    .filter(
      (row) =>
        row.currency === "EUR" &&
        row.totals.gross !== undefined &&
        compare(row.totals.gross.amount, query.gross) === 0 &&
        (query.number === undefined || same(row.number, query.number)) &&
        (query.supplierId === undefined
          ? same(row.supplier?.name, query.supplierName)
          : row.supplier?.id === query.supplierId),
    )
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

function normalize(text: string | undefined): string {
  return (cleanText(text, 300) ?? "").toLowerCase();
}

/**
 * Refuses found duplicates unless `allowDuplicate`, then returns the preview warning (or
 * `undefined` when there are none).
 */
export function duplicateCheck(
  ids: readonly number[],
  query: VoucherDuplicateQuery,
  allowDuplicate: boolean,
): string | undefined {
  if (ids.length === 0) return undefined;
  const which = ids.length === 1 ? `voucher ${String(ids[0])}` : `vouchers ${ids.join(", ")}`;
  const what =
    `${which} with the same supplier, ` +
    `${query.number === undefined ? "" : "Belegnummer, "}date (${query.date}) and gross total ` +
    `(${query.gross} EUR)`;
  if (!allowDuplicate) {
    refuse(
      `Possible duplicate: ${what} already exist${ids.length === 1 ? "s" : ""}. Check it with ` +
        "sevdesk_voucher_get; if this really is another receipt, call again with " +
        "allowDuplicate: true.",
    );
  }
  return `Possible duplicate (allowDuplicate is set): ${what} already exist${
    ids.length === 1 ? "s" : ""
  }.`;
}

// ---------------------------------------------------------------------------------------------
// Receipt file
// ---------------------------------------------------------------------------------------------

/**
 * Reads the receipt `ref` names (a path inside `SEVDESK_FILE_DIRS`, or an `upload:` reference
 * over HTTP) through `files`, which refuses with an actionable message otherwise; `kinds`
 * defaults to {@link RECEIPT_FILE_KINDS}.
 */
export async function readReceiptFile(
  files: FileAccess,
  ref: string,
  kinds: readonly LocalFileKind[] = RECEIPT_FILE_KINDS,
): Promise<ReceiptFile> {
  const file = await files.read(ref, { maxBytes: MAX_RECEIPT_BYTES, kinds });
  return { name: file.name, kind: file.kind, bytes: file.bytes };
}

/** "Rechnung-4711.pdf (PDF, 48211 bytes, SHA-256 3f2a…)": local text, cleaned by the fact. */
export function receiptText(file: ReceiptFile, lang: PreviewLanguage = "en"): string {
  const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 16);
  return (
    `${file.name} (${file.kind.toUpperCase()}, ${String(file.bytes.length)} ${lang === "de" ? "Bytes" : "bytes"}, SHA-256 ` +
    `${hash}…)`
  );
}

// ---------------------------------------------------------------------------------------------
// Preview wording
// ---------------------------------------------------------------------------------------------

/** The voucher's direction in a preview. */
export function kindText(kind: VoucherKind, lang: PreviewLanguage = "en"): string {
  if (lang === "de") {
    return kind === "expense"
      ? "Ausgabe: Die Zahlung geht vom Bankkonto ab"
      : "Einnahme: Die Zahlung geht ein";
  }
  return kind === "expense"
    ? "expense (Ausgabe): its payment leaves the bank account"
    : "revenue (Einnahme): its payment comes in";
}

/** The party's label: the supplier of an expense, the customer of revenue. */
export function partyLabel(kind: VoucherKind, lang: PreviewLanguage = "en"): string {
  if (lang === "de") return kind === "expense" ? "Lieferant" : "Kunde";
  return kind === "expense" ? "Supplier (Lieferant)" : "Customer (Kunde)";
}
