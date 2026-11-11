/**
 * The stored state of a voucher (Beleg) that an update or the finalize changes: the raw writable
 * fields of `GET /Voucher/{id}` and its position rows (`GET /VoucherPos?voucher[id]=…`).
 *
 * `saveVoucher` with the voucher's id updates it (spec: "this request can also be used to update
 * draft vouchers"); whether sevDesk clears fields the body leaves out is not documented, so update
 * and finalize bodies carry every writable field this server knows over unchanged (as the invoice
 * updates do, spec/deviations.md D-054). These schemas therefore keep raw values (texts untrimmed
 * and unsanitized, decimals as sent); only the preview helpers clean text. The module also holds
 * the checks a stored voucher must pass before it is changed or finalized ({@link checkDraft}) and
 * the carrying-over of its fields into a save body ({@link carriedVoucher}).
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import {
  parseUpstream,
  zBool01,
  zId,
  zIntish,
  zOptionalDecimal,
  zOptionalRef,
  zText,
} from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { TaxRegime } from "../account-settings.js";
import { cleanText } from "../common.js";
import { listChildRows } from "../paging.js";
import { numberText, type PreviewLanguage } from "../preview-text.js";
import { type TaxRule, taxRuleById } from "../reference-data.js";
import { type VoucherKind, voucherKindFromCreditDebit } from "../vouchers.js";
import { berlinDay } from "./current.js";
import { wireDocumentDate } from "./fields.js";
import { moneyText } from "./preview.js";
import { resolveTaxRates } from "./tax.js";
import { type AmountMode, exactRate } from "./voucher-checks.js";
import { VOUCHER_DRAFT_STATUS, voucherRef } from "./voucher-payload.js";

/** Dates arrive as ISO date-times (or Unix seconds); converted with `berlinDay`. */
const zDate = z.unknown().optional();

const storedVoucherSchema = z.object({
  id: zId,
  status: zIntish,
  voucherDate: zDate,
  supplier: zOptionalRef,
  supplierName: zText,
  description: zText,
  paymentDeadline: zDate,
  deliveryDate: zDate,
  deliveryDateUntil: zDate,
  currency: zText,
  taxRule: zOptionalRef,
  taxType: zText,
  creditDebit: zText,
  voucherType: zText,
  enshrined: zDate,
  costCentre: zOptionalRef,
  document: zOptionalRef,
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
});

const storedPositionSchema = z.object({
  id: zId,
  voucher: zOptionalRef,
  accountDatev: zOptionalRef,
  accountingType: zOptionalRef,
  taxRate: zOptionalDecimal,
  net: zBool01.optional(),
  sumNet: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  comment: zText,
  isAsset: zBool01.optional(),
});

type StoredVoucherRecord = z.output<typeof storedVoucherSchema>;
export type StoredVoucherPosition = z.output<typeof storedPositionSchema>;

/** A stored voucher as an update or the finalize sees it. */
export interface StoredVoucher {
  readonly record: StoredVoucherRecord;
  /** Calendar days (Berlin) of the stored dates. */
  readonly dates: {
    readonly voucherDate: string | undefined;
    readonly deliveryDate: string | undefined;
    readonly deliveryDateUntil: string | undefined;
    readonly paymentDeadline: string | undefined;
  };
  /** From `creditDebit`; `undefined` when sevDesk sent something else. */
  readonly kind: VoucherKind | undefined;
  readonly enshrined: boolean;
  /** Whether sevDesk reported an attached document (`undefined`: the key was absent, D-044). */
  readonly hasDocument: boolean | undefined;
  readonly positions: readonly StoredVoucherPosition[];
}

/**
 * Reads the voucher and all its positions. An unknown id is a trusted `validation` error; a
 * position list that could not be read completely is refused too, since an update would then
 * keep or delete only part of it.
 */
export async function loadStoredVoucher(
  client: SevdeskClient,
  voucherId: number,
  signal?: AbortSignal,
): Promise<StoredVoucher> {
  const voucherKey = toSevdeskId(voucherId);
  let payload: unknown;
  try {
    payload = await client.request({
      method: "GET",
      path: sevdeskPath("Voucher", voucherKey),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw new SevdeskError({
        kind: "validation",
        message:
          `Voucher ${String(voucherKey)} does not exist in sevDesk. Find the voucher id with ` +
          "sevdesk_vouchers_list.",
      });
    }
    throw error;
  }
  const raw = expectSingle(payload, `voucher ${String(voucherKey)}`);
  const record = parseUpstream(storedVoucherSchema, raw, "a voucher");
  const positions = await listChildRows(
    client,
    "/VoucherPos",
    { "voucher[id]": voucherKey, "voucher[objectName]": "Voucher" },
    {
      parse: (row) => parseUpstream(storedPositionSchema, row, "voucher positions"),
      belongs: (row) => row.voucher?.id === voucherKey,
    },
    signal,
  );
  if (!positions.complete) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Voucher ${String(voucherKey)} has more positions than this server can read, so it ` +
        "cannot be changed here. Edit it in the sevDesk web app.",
    });
  }
  return {
    record,
    dates: {
      voucherDate: berlinDay(record.voucherDate),
      deliveryDate: berlinDay(record.deliveryDate),
      deliveryDateUntil: berlinDay(record.deliveryDateUntil),
      paymentDeadline: berlinDay(record.paymentDeadline),
    },
    kind: voucherKindFromCreditDebit(record.creditDebit),
    enshrined: berlinDay(record.enshrined) !== undefined,
    hasDocument: hasKey(raw, "document") ? record.document !== undefined : undefined,
    positions: [...positions.rows].sort((a, b) => a.id - b.id),
  };
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}

// ---------------------------------------------------------------------------------------------
// Carrying a stored voucher over into an update or finalize body
// ---------------------------------------------------------------------------------------------

export interface CarriedFields {
  readonly status: number;
  readonly voucherDate: string;
  readonly supplierId: number | undefined;
  readonly supplierName: string | undefined;
  readonly description: string | undefined;
  readonly paymentDeadline: string | undefined;
  readonly deliveryDate: string;
  readonly deliveryDateUntil: string | undefined;
  readonly taxRuleId: number;
}

/** The `voucher` object of an update or finalize: the given fields, the rest carried over. */
export function carriedVoucher(
  stored: StoredVoucher,
  fields: CarriedFields,
): Record<string, unknown> {
  const record = stored.record;
  return {
    id: record.id,
    objectName: "Voucher",
    mapAll: true,
    voucherDate: wireDocumentDate(fields.voucherDate),
    supplier: fields.supplierId === undefined ? null : voucherRef(fields.supplierId, "Contact"),
    supplierName: fields.supplierName,
    description: fields.description,
    paymentDeadline:
      fields.paymentDeadline === undefined ? undefined : wireDocumentDate(fields.paymentDeadline),
    deliveryDate: wireDocumentDate(fields.deliveryDate),
    deliveryDateUntil:
      fields.deliveryDateUntil === undefined
        ? undefined
        : wireDocumentDate(fields.deliveryDateUntil),
    status: fields.status,
    taxRule: voucherRef(fields.taxRuleId, "TaxRule"),
    creditDebit: record.creditDebit?.trim().toUpperCase(),
    voucherType: "VOU",
    currency: "EUR",
    costCentre:
      record.costCentre === undefined ? undefined : voucherRef(record.costCentre.id, "CostCentre"),
  };
}

/**
 * Checks that a stored voucher can be changed or finalized here: a normal (VOU), EUR, Update 2.0
 * draft that is not enshrined and says whether it is an expense or revenue. Returns its kind.
 */
export function checkDraft(stored: StoredVoucher, action: "changed" | "finalized"): VoucherKind {
  const { record } = stored;
  const id = String(record.id);
  if (stored.enshrined) {
    refuse(`Voucher ${id} is enshrined (festgeschrieben) and can no longer be ${action}.`);
  }
  if (record.status !== VOUCHER_DRAFT_STATUS) {
    refuse(
      `Voucher ${id} is not a draft (status ${String(record.status)}); only drafts can be ` +
        `${action}. Reset it to draft first with sevdesk_voucher_reset (to "draft").`,
    );
  }
  const type = record.voucherType?.trim().toUpperCase() ?? "VOU";
  if (type !== "VOU") {
    refuse(
      `Voucher ${id} is not a normal voucher (type ${type === "RV" ? "RV, recurring" : "other"}); ` +
        "edit it in the sevDesk web app.",
    );
  }
  const currency = record.currency?.trim().toUpperCase() ?? "EUR";
  if (currency !== "EUR") {
    refuse(
      `Voucher ${id} is a foreign-currency voucher; this server writes EUR vouchers only. Edit ` +
        "it in the sevDesk web app.",
    );
  }
  if (stored.kind === undefined) {
    refuse(
      `Voucher ${id} does not say whether it is an expense or revenue (creditDebit); edit it ` +
        "in the sevDesk web app.",
    );
  }
  return stored.kind;
}

/** The stored tax rule; a voucher without a known rule (e.g. legacy taxType) is refused. */
export function storedRule(stored: StoredVoucher, fix: string): TaxRule {
  const ruleRef = stored.record.taxRule;
  const rule = ruleRef === undefined ? undefined : taxRuleById(ruleRef.id);
  if (rule === undefined) {
    refuse(
      `Voucher ${String(stored.record.id)} has no Update 2.0 tax rule this server knows. ${fix}`,
    );
  }
  return rule;
}

/**
 * The stored positions as checked positions under `rule`: each needs an Update 2.0 booking account
 * (a legacy position with only an `accountingType` cannot be checked, D-045) and a rate the rule
 * allows.
 */
export function storedPositionsFor(
  stored: StoredVoucher,
  rule: TaxRule,
  regime: TaxRegime | undefined,
): { accountDatevId: number; taxRateNumber: number }[] {
  const rates = resolveTaxRates(
    rule,
    stored.positions.map((row) => ({ taxRate: row.taxRate })),
    undefined,
    regime,
  );
  return stored.positions.map((row, index) => {
    const account = row.accountDatev;
    if (account === undefined) {
      refuse(
        `Position ${String(index + 1)} of voucher ${String(stored.record.id)} has no Update 2.0 ` +
          "booking account (accountDatev, only a legacy accountingType). Replace the positions " +
          "with sevdesk_voucher_update_draft (positions).",
      );
    }
    return { accountDatevId: account.id, taxRateNumber: exactRate(rates[index] ?? "0", index) };
  });
}

/** The amount mode of stored positions (`net` flag of the first; gross when there are none). */
export function storedAmountMode(positions: readonly StoredVoucherPosition[]): AmountMode {
  return positions[0]?.net === true ? "net" : "gross";
}

export function storedPositionText(
  row: StoredVoucherPosition,
  mode: AmountMode,
  lang: PreviewLanguage = "en",
): string {
  const amount = mode === "net" ? row.sumNet : row.sumGross;
  const rate = row.taxRate ?? "?";
  const comment = cleanText(row.comment, 200);
  const german = lang === "de";
  const shown =
    amount === undefined
      ? german
        ? "(kein Betrag)"
        : "(no amount)"
      : moneyText(amount, "EUR", lang);
  const basis = german ? (mode === "net" ? "netto" : "brutto") : mode;
  return (
    `${shown} ${basis}, ${numberText(rate, lang)} % ${german ? "USt." : "VAT"}` +
    (comment === undefined ? "" : `; ${comment}`)
  );
}

export function storedTotal(stored: StoredVoucher, lang: PreviewLanguage = "en"): string {
  const gross = stored.record.sumGross;
  if (gross === undefined) return lang === "de" ? "wie gespeichert" : "as stored";
  return moneyText(gross, "EUR", lang);
}

export function nonBlank(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === "" ? undefined : text;
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}
