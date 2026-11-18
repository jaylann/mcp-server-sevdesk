/**
 * Creating a payment account (Zahlungskonto anlegen): the checks, preview and request behind
 * `sevdesk_bank_account_create`.
 *
 * sevDesk creates accounts only through two factories (spec/deviations.md D-097):
 * `POST /CheckAccount/Factory/fileImportAccount` (a bank account fed by imported files; recorded
 * with `{name, importType: "CSV"}`, it reads as type `online`, `importType` `CSV`) and
 * `POST /CheckAccount/Factory/clearingAccount` (recorded with `{name}` on SKR04: type `offline`,
 * the next free number of the 18xx range, the account answered in `objects`). A cash register
 * cannot be created through the API (`POST /CheckAccount` answers 400), and
 * `DELETE /CheckAccount/{id}` only archives, so a created account stays.
 *
 * Only documented fields are sent: `name`, `importType` (always `CSV`, the recorded value) and,
 * when the user gives one, `accountingNumber` (D-119: stored as sent; sevDesk refuses a number in
 * use, also by an archived account, and a number it does not allow, both with 422, which become
 * our own messages). The created account is taken from sevDesk's answer, not from the request,
 * and every difference from the request is reported. The POST is never retried.
 */
import { z } from "zod";

import type { ConfirmationFact, ConfirmationPreview } from "../safety/write-types.js";
import { SevdeskError } from "../sevdesk/errors.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import {
  type BankAccountDto,
  bankAccountFromAnswer,
  type CheckAccountEntry,
  listCheckAccountEntries,
} from "./banking.js";
import { cleanText } from "./common.js";

/** What the tool creates: a file-import account or a clearing account (no cash register). */
export const BANK_ACCOUNT_KINDS = ["file_import", "clearing"] as const;
type BankAccountKind = (typeof BANK_ACCOUNT_KINDS)[number];

/** Longest account name accepted (sevDesk documents no limit). */
export const BANK_ACCOUNT_NAME_MAX = 100;
/** Highest booking account number accepted (SKR numbers have four digits, some charts more). */
export const ACCOUNTING_NUMBER_MAX = 99_999_999;

const FACTORY_PATHS: Readonly<Record<BankAccountKind, string>> = {
  file_import: "/CheckAccount/Factory/fileImportAccount",
  clearing: "/CheckAccount/Factory/clearingAccount",
};

const KIND_LABELS: Readonly<Record<BankAccountKind, string>> = {
  file_import: "file-import account (Dateiimport-Konto)",
  clearing: "clearing account (Verrechnungskonto)",
};

/**
 * The way out of a refused booking account number. Which number sevDesk picks without one is
 * recorded on SKR04 only (the next free 18xx number, D-119); on another chart of accounts it may
 * differ, so the range is named as recorded, not promised.
 */
const LEAVE_NUMBER_OUT =
  "leave accountingNumber out to let sevDesk pick a free one (recorded on SKR04: the next free " +
  "18xx number)";

// ---------------------------------------------------------------------------------------------
// Outgoing payloads (strict: spec `createFileImportAccount`, `createClearingAccount`)
// ---------------------------------------------------------------------------------------------

const accountingNumberPayload = z.number().int().positive().max(ACCOUNTING_NUMBER_MAX).optional();

const fileImportPayloadSchema = z.strictObject({
  name: z.string().min(1),
  importType: z.literal("CSV"),
  accountingNumber: accountingNumberPayload,
});

const clearingPayloadSchema = z.strictObject({
  name: z.string().min(1),
  accountingNumber: accountingNumberPayload,
});

type BankAccountCreatePayload =
  z.output<typeof fileImportPayloadSchema> | z.output<typeof clearingPayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

/** Fields of `sevdesk_bank_account_create`; `name` is trimmed and not empty. */
export interface BankAccountCreateInput {
  readonly kind: BankAccountKind;
  readonly name: string;
  readonly accountingNumber?: number | undefined;
}

export interface BankAccountCreateState {
  readonly kind: BankAccountKind;
  readonly path: string;
  readonly payload: BankAccountCreatePayload;
}

/**
 * Checks a new payment account and builds the preview and request. Reads only
 * (`GET /CheckAccount`). Refuses, with a `validation` SevdeskError, when an active account already
 * has the same name (compared without case and extra spaces) or the booking account number is
 * taken. A same-named account is refused rather than warned about: this tier asks nobody, a model
 * repeating a call would otherwise leave a second account, and an account cannot be deleted again.
 */
export async function planBankAccountCreate(
  client: SevdeskClient,
  input: BankAccountCreateInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: BankAccountCreateState }> {
  const { entries, complete } = await listCheckAccountEntries(client, signal);

  const sameName = entries.find(
    (entry) =>
      !entry.archived &&
      entry.storedName !== undefined &&
      accountNameKey(entry.storedName) === accountNameKey(input.name),
  );
  if (sameName !== undefined) {
    throw validation(
      `An active payment account with this name exists already: account ` +
        `${String(sameName.account.id)} (${describeAccount(sameName.account)}). Use that ` +
        "account (sevdesk_bank_accounts_list shows it), or choose another name: sevDesk cannot " +
        "delete a payment account, only archive it.",
    );
  }
  if (input.accountingNumber !== undefined) {
    const owner = numberOwner(entries, input.accountingNumber);
    if (owner !== undefined) {
      throw validation(
        `Booking account ${String(input.accountingNumber)} is already used by payment account ` +
          `${String(owner.id)}, and every payment account needs a booking account of its own. ` +
          `Choose another number, or ${LEAVE_NUMBER_OUT}.`,
      );
    }
  }

  const payload: BankAccountCreatePayload =
    input.kind === "file_import"
      ? fileImportPayloadSchema.parse({
          name: input.name,
          importType: "CSV",
          accountingNumber: input.accountingNumber,
        })
      : clearingPayloadSchema.parse({ name: input.name, accountingNumber: input.accountingNumber });

  const facts: ConfirmationFact[] = [
    { label: "Kind", value: KIND_LABELS[input.kind] },
    { label: "Name", value: display(input.name) },
    {
      label: "Booking account (Buchungskonto)",
      value:
        input.accountingNumber === undefined ? "chosen by sevDesk" : String(input.accountingNumber),
    },
  ];
  if (input.kind === "file_import") facts.push({ label: "Import type", value: "CSV" });

  return {
    preview: {
      // By kind only: the name is the model's argument; the "Name" fact shows it (#147).
      action: `Create a new ${KIND_LABELS[input.kind]}.`,
      facts,
      warnings: warningsFor(input, complete),
      irreversible: false,
    },
    state: { kind: input.kind, path: FACTORY_PATHS[input.kind], payload },
  };
}

function warningsFor(input: BankAccountCreateInput, complete: boolean): string[] {
  const warnings = [
    "sevDesk cannot delete a payment account through its API, only archive it: the account " +
      "stays in the account list unless it is archived (sevdesk_bank_account_archive).",
  ];
  if (input.kind === "clearing") {
    warnings.push(
      "A clearing account takes no transactions entered by hand: sevDesk creates its " +
        "transactions when payments are booked on it. Use a file-import account for those.",
    );
  }
  if (input.accountingNumber === undefined) {
    warnings.push(
      "Without accountingNumber sevDesk picks the booking account itself: recorded on SKR04, the " +
        "next free number of the 18xx range, for file-import and clearing accounts alike; other " +
        "charts of accounts are not recorded. Ask the tax consultant whether the account needs a " +
        "specific one.",
    );
  }
  if (!complete) {
    warnings.push(
      "sevDesk lists more than 1000 payment accounts: the name and booking account were checked " +
        "against the first 1000 only.",
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

/** The created account as sevDesk answered it, and how that answer differs from the request. */
export interface BankAccountCreated {
  readonly account: BankAccountDto;
  /** Trusted sentences naming each difference between the request and the answer. */
  readonly notes: readonly string[];
}

/**
 * Creates the account (`POST` to the factory, never retried) and reads it from sevDesk's answer.
 * An answer without a readable account fails with a message that says the account was probably
 * created, so the call is not repeated blindly.
 */
export async function executeBankAccountCreate(
  client: SevdeskClient,
  state: BankAccountCreateState,
  signal?: AbortSignal,
): Promise<BankAccountCreated> {
  let answer: unknown;
  try {
    answer = await client.request({
      method: "POST",
      path: state.path,
      body: state.payload,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw accountingNumberRefusal(error, state) ?? error;
  }
  let account: BankAccountDto;
  try {
    account = bankAccountFromAnswer(answer, "created payment account");
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the new payment account, but its answer did not contain a readable " +
        "account, so its id is unknown. Do not repeat the call: look for the account with " +
        "sevdesk_bank_accounts_list first.",
      cause: error,
    });
  }
  return { account, notes: differences(state, account) };
}

/**
 * sevDesk's two recorded refusals of a booking account number (D-119), both HTTP 422: "The given
 * account number is already used" (also by an archived account, which keeps its number and is
 * not listed, so the pre-check cannot see it) and "The given account number … is invalid" (the
 * number is not one sevDesk allows for a payment account). Each becomes a trusted sentence of our
 * own, without sevDesk's text; status, request and sevDesk's exception id are kept for the error
 * output and the audit log. Any other error is left as it is (`undefined`). Nothing was created in
 * either case.
 */
function accountingNumberRefusal(
  error: unknown,
  state: BankAccountCreateState,
): SevdeskError | undefined {
  const requested = state.payload.accountingNumber;
  if (
    requested === undefined ||
    !(error instanceof SevdeskError) ||
    error.kind !== "validation" ||
    error.upstreamMessage === undefined
  ) {
    return undefined;
  }
  const number = String(requested);
  const upstream = error.upstreamMessage;
  const message = /account number.*already used/i.test(upstream)
    ? `sevDesk refused booking account ${number}: another payment account already uses it, ` +
      "possibly an archived one, which keeps its number and is not listed. Nothing was created. " +
      `Choose another number, or ${LEAVE_NUMBER_OUT}.`
    : /account number.*invalid/i.test(upstream)
      ? `sevDesk does not accept ${number} as the booking account of a payment account. Nothing ` +
        "was created. Choose a booking account the chart of accounts provides for bank or " +
        `clearing accounts (ask the tax consultant), or ${LEAVE_NUMBER_OUT}.`
      : undefined;
  if (message === undefined) return undefined;
  return new SevdeskError({
    kind: "validation",
    message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    // Our own sentence for a known refusal: shown instead of the generic advice.
    explained: true,
    cause: error,
    completedWrites: error.completedWrites,
  });
}

/** What the answer shows differently from what was requested (kind, booking account). */
function differences(state: BankAccountCreateState, account: BankAccountDto): string[] {
  const notes: string[] = [];
  const answeredAsRequested =
    state.kind === "file_import" ? account.fileImport : account.type === "clearing";
  if (!answeredAsRequested) {
    notes.push(
      `sevDesk's answer does not show the account as a ${KIND_LABELS[state.kind]} (it reads as ` +
        `${describeAccount(account)}); check it with sevdesk_bank_accounts_list before using it.`,
    );
  }
  const requested = state.payload.accountingNumber;
  if (requested !== undefined && account.accountingNumber !== String(requested)) {
    const stored = account.accountingNumber;
    notes.push(
      stored !== undefined && /^\d{1,10}$/.test(stored)
        ? `sevDesk stored booking account ${stored}, not the requested ${String(requested)}.`
        : `sevDesk's answer does not show the requested booking account ${String(requested)}.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * An account name for comparisons: Unicode-normalized, spaces collapsed, case ignored. Shared with
 * the rename (`bank-account-update.ts`), so both refuse the same duplicates.
 */
export function accountNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

/** The listed account (archived ones included) that already has this booking account number. */
function numberOwner(
  entries: readonly CheckAccountEntry[],
  accountingNumber: number,
): BankAccountDto | undefined {
  const wanted = String(accountingNumber);
  return entries.find((entry) => entry.account.accountingNumber === wanted)?.account;
}

const ACCOUNT_TYPE_LABELS: Readonly<Record<BankAccountDto["type"], string>> = {
  bank: "a bank account",
  clearing: "a clearing account",
  cash: "a cash register",
  unknown: "an account of unknown type",
};

/** A trusted label of an account's kind, from the parsed enum and flag only. */
function describeAccount(account: BankAccountDto): string {
  return account.fileImport ? "a file-import account" : ACCOUNT_TYPE_LABELS[account.type];
}

function display(value: string): string {
  return cleanText(value, BANK_ACCOUNT_NAME_MAX) ?? "";
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
