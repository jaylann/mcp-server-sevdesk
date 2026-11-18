/**
 * Changing a payment account (Zahlungskonto bearbeiten): the checks, previews, request and
 * read-back behind `sevdesk_bank_account_update`.
 *
 * What sevDesk does with `PUT /CheckAccount/{id}` (recorded on the trial account, Update 2.0,
 * spec/deviations.md D-097, D-141, D-144):
 * - It stores `name`, `iban`, `bic`, `autoMapTransaction` (singular, as rows read) and a free
 *   `accountingNumber`. A booking account number another account uses is refused with 400 "The
 *   given account number is already used".
 * - It answers 200 also for keys it ignores: the spec's plural `autoMapTransactions`, `type` and
 *   `status`. So a 200 proves nothing, and every field sent is read back
 *   (`GET /CheckAccount/{id}`); one that was not stored fails the call.
 * - `defaultAccount` was not recorded (it would move the account's default account) and is never
 *   sent; neither are `type` and `status`.
 *
 * Refused before anything is sent: an archived account; a bank-connected account or one of an
 * undocumented type (a trial account has no bank connection, so what a change does to one is not
 * recorded); anything but the name on a clearing account or cash register (the other fields were
 * recorded on a file-import account only; renaming on a file-import and a clearing account); a name
 * another active account has, compared as `sevdesk_bank_account_create` does; a booking account
 * number a listed account uses; a new booking account on an account with booked transactions
 * (what sevDesk does with their bookings is not recorded); and a call that changes nothing. The
 * PUT is never retried.
 */
import { z } from "zod";

import type { ConfirmationPreview } from "../safety/write-types.js";
import { SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { accountNameKey, BANK_ACCOUNT_NAME_MAX } from "./bank-account-create.js";
import {
  type BankAccountDto,
  getStoredCheckAccount,
  listCheckAccountEntries,
  maskIban,
  readAccountTransactions,
  type StoredCheckAccount,
} from "./banking.js";
import { cleanText } from "./common.js";
import type { Fact } from "./lifecycle/preview.js";
import { refuse } from "./lifecycle/transitions.js";
import { bothPreviews, type Phrase, phrase, type PreviewLanguage } from "./preview-text.js";

/**
 * The kinds of account this server changes: every kind the trial account has. A cash register is
 * only renamed (a name-only `PUT`, recorded on the two other kinds), never archived.
 */
export type ChangeableKind = "file_import" | "clearing" | "cash";

export const ACCOUNT_KIND_TEXT: Readonly<Record<ChangeableKind, Phrase>> = {
  file_import: phrase("file-import account (Dateiimport-Konto)", "Dateiimport-Konto"),
  clearing: phrase("clearing account (Verrechnungskonto)", "Verrechnungskonto"),
  cash: phrase("cash register (Kasse)", "Kasse"),
};

/**
 * The kind of an account this server may change; refuses the others with a trusted `validation`
 * error. A bank account counts only as a file-import account (D-097): one with a bank or PayPal
 * connection, or of an undocumented type, is refused, since none could be recorded.
 */
export function changeableKind(account: BankAccountDto, what: string): ChangeableKind {
  const ref = `Payment account ${String(account.id)}`;
  if (account.fileImport) return "file_import";
  switch (account.type) {
    case "clearing":
    case "cash":
      return account.type;
    case "bank":
      return refuse(
        `${ref} is connected to a bank (online banking) or PayPal. ${what} such an account is ` +
          "not supported: what it does to the bank connection is not recorded. Use the sevDesk " +
          "web app.",
      );
    case "unknown":
      return refuse(
        `${ref} is of an account type sevDesk does not document; ${what.toLowerCase()} it is ` +
          "not supported.",
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

/**
 * An IBAN as typed (spaces allowed), checked by its ISO 13616 check digits; becomes upper-case
 * letters and digits only.
 */
export const ibanInput = z
  .string()
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .refine((value) => /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value) && ibanChecksumOk(value), {
    message: "expected a valid IBAN (country code, check digits, account number)",
  });

/** A BIC (SWIFT code) of 8 or 11 characters; becomes upper case. */
export const bicInput = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value), {
    message: "expected a BIC of 8 or 11 letters and digits",
  });

/** ISO 13616: the IBAN with its first four characters moved to the end, as a number, mod 97 = 1. */
function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Fields of `sevdesk_bank_account_update`; each one given is a change. */
export interface BankAccountUpdateInput {
  readonly id: number;
  /** Trimmed, not empty. */
  readonly name?: string | undefined;
  readonly accountingNumber?: number | undefined;
  /** Upper-case letters and digits ({@link ibanInput}). */
  readonly iban?: string | undefined;
  /** Upper case ({@link bicInput}). */
  readonly bic?: string | undefined;
  readonly autoMapTransactions?: boolean | undefined;
}

/** What is sent: only the fields that change, under the keys sevDesk stores (D-141). */
interface BankAccountUpdatePayload {
  readonly name?: string;
  readonly accountingNumber?: string;
  readonly iban?: string;
  readonly bic?: string;
  readonly autoMapTransaction?: 0 | 1;
}

export interface BankAccountUpdateState {
  readonly id: number;
  readonly payload: BankAccountUpdatePayload;
}

export interface BankAccountUpdatePlan {
  readonly preview: ConfirmationPreview;
  readonly previewDe: ConfirmationPreview;
  readonly state: BankAccountUpdateState;
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

/**
 * Checks a change and builds both previews and the request. Reads only (`GET /CheckAccount/{id}`,
 * `GET /CheckAccount` for a new name or number, the account's transactions for a new number).
 * The previews show the account as stored (kind, name, booking account and each value before and
 * after), so an approval binds to that record: when it changes before the call runs, the preview
 * changes and the human is asked again. Fields given with the value already stored are left out;
 * when nothing is left, the call is refused.
 */
export async function planBankAccountUpdate(
  client: SevdeskClient,
  input: BankAccountUpdateInput,
  signal?: AbortSignal,
): Promise<BankAccountUpdatePlan> {
  const id = toSevdeskId(input.id);
  const stored = await getStoredCheckAccount(client, id, signal);
  const { account } = stored;
  const ref = `Payment account ${String(id)}`;

  if (stored.archived) {
    refuse(
      `${ref} is archived; changing an archived account is not supported (sevDesk lists it ` +
        "nowhere, and it cannot be restored through the API).",
    );
  }
  const kind = changeableKind(account, "Changing");
  const payload = changedFields(input, stored);
  if (Object.keys(payload).length === 0) {
    refuse(`${ref} already has the values given; nothing to change.`);
  }
  const beyondName = FIELD_ORDER.filter(
    (field) => field !== "name" && payload[field] !== undefined,
  );
  if (beyondName.length > 0 && kind !== "file_import") {
    refuse(
      `${ref} is a ${ACCOUNT_KIND_TEXT[kind].en}: only its name is changed here. Booking ` +
        "account, IBAN, BIC and automatic assignment are set only on file-import accounts, the " +
        "only kind where storing them was recorded.",
    );
  }

  const warnings: Phrase[] = [];
  if (payload.name !== undefined || payload.accountingNumber !== undefined) {
    const { entries, complete } = await listCheckAccountEntries(client, signal);
    const others = entries.filter((entry) => entry.account.id !== id);
    if (payload.name !== undefined) {
      const wanted = accountNameKey(payload.name);
      const sameName = others.find(
        (entry) =>
          !entry.archived &&
          entry.storedName !== undefined &&
          accountNameKey(entry.storedName) === wanted,
      );
      if (sameName !== undefined) {
        refuse(
          `Another active payment account has this name already: account ` +
            `${String(sameName.account.id)}. Choose another name, so the accounts can be told apart.`,
        );
      }
    }
    if (payload.accountingNumber !== undefined) {
      const wanted = payload.accountingNumber;
      const owner = others.find((entry) => entry.account.accountingNumber === wanted);
      if (owner !== undefined) {
        refuse(
          `Booking account ${wanted} is already used by payment account ` +
            `${String(owner.account.id)}, and every payment account needs a booking account of ` +
            "its own. Choose another number.",
        );
      }
    }
    if (!complete) {
      warnings.push(
        phrase(
          "sevDesk lists more than 1000 payment accounts: the new values were checked against " +
            "the first 1000 only.",
          "sevDesk listet mehr als 1000 Zahlungskonten: Die neuen Werte wurden nur mit den " +
            "ersten 1000 verglichen.",
        ),
      );
    }
  }
  if (payload.accountingNumber !== undefined) {
    await assertNothingBooked(client, account, signal);
    warnings.push(
      phrase(
        "The booking account (Buchungskonto) decides where the account's payments are booked in " +
          "the accounts (reports, DATEV export). Change it only on the tax consultant's advice. " +
          "Checked: none of the account's transactions is booked.",
        "Das Buchungskonto bestimmt, wo die Zahlungen des Kontos in der Buchhaltung gebucht " +
          "werden (Auswertungen, DATEV-Export). Ändern Sie es nur auf Rat Ihrer Steuerberatung. " +
          "Geprüft: Keiner der Umsätze des Kontos ist gebucht.",
      ),
    );
  }
  if (payload.autoMapTransaction === 1) {
    warnings.push(
      phrase(
        "With automatic assignment on, sevDesk may book imported transactions on matching " +
          "invoices and vouchers by itself.",
        "Mit automatischer Zuordnung kann sevDesk importierte Umsätze selbst auf passende " +
          "Rechnungen und Belege buchen.",
      ),
    );
  }
  warnings.push(
    phrase(
      "Nothing else changes: the transactions and the balance (Saldo) stay as they are. Undo: " +
        "set the values left of the arrows again with sevdesk_bank_account_update.",
      "Sonst ändert sich nichts: Umsätze und Saldo bleiben, wie sie sind. Rückgängig: die Werte " +
        "links der Pfeile mit sevdesk_bank_account_update wieder setzen.",
    ),
  );

  return {
    ...bothPreviews((lang) => ({
      action:
        lang === "de"
          ? `Zahlungskonto ${String(id)} ändern: ${changedNames(payload, lang)}.`
          : `Change payment account ${String(id)}: ${changedNames(payload, lang)}.`,
      facts: updateFacts(stored, kind, payload, lang),
      warnings: warnings.map((warning) => warning[lang]),
      irreversible: false,
    })),
    state: { id, payload },
  };
}

/** The given fields whose value differs from the stored one, under sevDesk's keys. */
function changedFields(
  input: BankAccountUpdateInput,
  stored: StoredCheckAccount,
): BankAccountUpdatePayload {
  const number = input.accountingNumber === undefined ? undefined : String(input.accountingNumber);
  const autoMap = input.autoMapTransactions;
  return {
    ...(input.name !== undefined && input.name !== stored.storedName ? { name: input.name } : {}),
    ...(number !== undefined && number !== stored.account.accountingNumber
      ? { accountingNumber: number }
      : {}),
    ...(input.iban !== undefined && input.iban !== stored.iban ? { iban: input.iban } : {}),
    ...(input.bic !== undefined && input.bic !== stored.bic ? { bic: input.bic } : {}),
    ...(autoMap !== undefined && autoMap !== stored.autoMap
      ? { autoMapTransaction: autoMap ? 1 : 0 }
      : {}),
  };
}

/**
 * Refuses an account with booked transactions (or more than one page of them, which cannot all be
 * checked), naming up to five of the booked rows by id.
 */
async function assertNothingBooked(
  client: SevdeskClient,
  account: BankAccountDto,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rows = await readAccountTransactions(client, account.id, signal);
  const ref = `Payment account ${String(account.id)}`;
  if (rows.booked.length > 0) {
    const ids = rows.booked.slice(0, 5).map((row) => String(row.id));
    const more = rows.booked.length > ids.length ? ", …" : "";
    refuse(
      `${ref} has booked transactions (${ids.join(", ")}${more}). A new booking account is not ` +
        "set on such an account: what sevDesk does with their bookings is not recorded. Change " +
        "it in the sevDesk web app with the tax consultant.",
    );
  }
  if (!rows.complete) {
    refuse(
      `${ref} has more transactions than one check reads (1000), so it cannot be shown that ` +
        "none is booked. Change the booking account in the sevDesk web app.",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

const FIELD_LABELS: Readonly<Record<keyof BankAccountUpdatePayload, Phrase>> = {
  name: phrase("Name", "Name"),
  accountingNumber: phrase("Booking account (Buchungskonto)", "Buchungskonto"),
  iban: phrase("IBAN", "IBAN"),
  bic: phrase("BIC", "BIC"),
  autoMapTransaction: phrase(
    "Automatic assignment of imported transactions",
    "Automatische Zuordnung importierter Umsätze",
  ),
};

const FIELD_ORDER: readonly (keyof BankAccountUpdatePayload)[] = [
  "name",
  "accountingNumber",
  "iban",
  "bic",
  "autoMapTransaction",
];

/** The changed fields as words for the action sentence, in a fixed order. */
function changedNames(payload: BankAccountUpdatePayload, lang: PreviewLanguage): string {
  return FIELD_ORDER.filter((field) => payload[field] !== undefined)
    .map((field) => (field === "name" && lang === "en" ? "name" : FIELD_LABELS[field][lang]))
    .join(", ");
}

/**
 * The account as stored, in the order both previews use: id and kind, then name and booking
 * account (always, to identify the account), then the other changed fields. A changed value reads
 * "current → new".
 */
function updateFacts(
  stored: StoredCheckAccount,
  kind: ChangeableKind,
  payload: BankAccountUpdatePayload,
  lang: PreviewLanguage,
): Fact[] {
  const de = lang === "de";
  const { account } = stored;
  const none = de ? "keine" : "none";
  const value = (before: string, after: string | undefined): string =>
    after === undefined ? before : `${before} → ${after}`;
  const facts: Fact[] = [
    {
      label: de ? "Zahlungskonto" : "Payment account",
      value: `${de ? "ID" : "id"} ${String(account.id)}`,
    },
    { label: de ? "Art" : "Kind", value: ACCOUNT_KIND_TEXT[kind][lang] },
    {
      label: FIELD_LABELS.name[lang],
      value: value(account.name, payload.name === undefined ? undefined : display(payload.name)),
    },
    {
      label: FIELD_LABELS.accountingNumber[lang],
      value: value(account.accountingNumber ?? (de ? "keines" : "none"), payload.accountingNumber),
    },
  ];
  if (payload.iban !== undefined) {
    facts.push({
      label: FIELD_LABELS.iban[lang],
      value: value(maskIban(stored.iban) ?? none, maskIban(payload.iban) ?? none),
    });
  }
  if (payload.bic !== undefined) {
    facts.push({
      label: FIELD_LABELS.bic[lang],
      value: value(cleanText(stored.bic, 11) ?? none, payload.bic),
    });
  }
  if (payload.autoMapTransaction !== undefined) {
    const onOff = (on: boolean | undefined): string => {
      if (on === undefined) return de ? "unbekannt" : "unknown";
      if (on) return de ? "an" : "on";
      return de ? "aus" : "off";
    };
    facts.push({
      label: FIELD_LABELS.autoMapTransaction[lang],
      value: value(onOff(stored.autoMap), onOff(payload.autoMapTransaction === 1)),
    });
  }
  if (account.isDefault) {
    facts.push({ label: de ? "Standardkonto" : "Default account", value: de ? "ja" : "yes" });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

/**
 * Sends the change (`PUT /CheckAccount/{id}`, never retried), reads the account back and checks
 * every field sent: sevDesk answers 200 also for keys it ignores (D-141), so a field not stored
 * fails the call with a message that names it and says that the rest may have been stored.
 */
export async function executeBankAccountUpdate(
  client: SevdeskClient,
  state: BankAccountUpdateState,
  signal?: AbortSignal,
): Promise<BankAccountDto> {
  const withSignal = signal === undefined ? {} : { signal };
  try {
    await client.request({
      method: "PUT",
      path: sevdeskPath("CheckAccount", state.id),
      body: state.payload,
      ...withSignal,
    });
  } catch (error) {
    throw accountingNumberRefusal(error, state) ?? error;
  }
  const changed = [{ objectName: "CheckAccount", id: String(state.id) }];
  let after: StoredCheckAccount;
  try {
    after = await getStoredCheckAccount(client, state.id, signal);
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, changed);
    throw error;
  }
  const missing = FIELD_ORDER.filter(
    (field) => state.payload[field] !== undefined && !stored(field, state.payload, after),
  );
  if (missing.length > 0) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted the change of payment account ${String(state.id)}, but reading it back ` +
        `shows these values not as sent: ${missing.map((field) => FIELD_LABELS[field].en).join(", ")}. ` +
        "Other values sent may have been stored; check the account with " +
        "sevdesk_bank_accounts_list.",
      completedWrites: changed,
    });
  }
  return after.account;
}

/** Whether the read-back shows `field` as sent. */
function stored(
  field: keyof BankAccountUpdatePayload,
  payload: BankAccountUpdatePayload,
  after: StoredCheckAccount,
): boolean {
  switch (field) {
    case "name":
      return after.storedName === payload.name;
    case "accountingNumber":
      return after.account.accountingNumber === payload.accountingNumber;
    case "iban":
      return after.iban === payload.iban;
    case "bic":
      return after.bic === payload.bic;
    case "autoMapTransaction":
      return after.autoMap === (payload.autoMapTransaction === 1);
  }
}

/**
 * sevDesk's refusal of a booking account number another account uses: 400 "The given account
 * number is already used" (D-144; also by an account the list leaves out, which the pre-check
 * cannot see). Becomes a trusted sentence of our own; any other error is left as it is.
 */
function accountingNumberRefusal(
  error: unknown,
  state: BankAccountUpdateState,
): SevdeskError | undefined {
  const requested = state.payload.accountingNumber;
  if (
    requested === undefined ||
    !(error instanceof SevdeskError) ||
    error.kind !== "validation" ||
    !/account number.*already used/i.test(error.upstreamMessage ?? "")
  ) {
    return undefined;
  }
  return new SevdeskError({
    kind: "validation",
    message:
      `sevDesk refused booking account ${requested}: another payment account already uses it, ` +
      "possibly one the account list leaves out (archived). sevDesk refused the whole request. " +
      "Choose another number.",
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    explained: true,
    cause: error,
  });
}

function display(value: string): string {
  return cleanText(value, BANK_ACCOUNT_NAME_MAX) ?? "";
}
