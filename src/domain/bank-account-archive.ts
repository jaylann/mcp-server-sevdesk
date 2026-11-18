/**
 * Archiving a payment account (Zahlungskonto archivieren): the checks, previews, request and
 * read-back behind `sevdesk_bank_account_archive`.
 *
 * What sevDesk does with `DELETE /CheckAccount/{id}` (recorded on the trial account, Update 2.0,
 * spec/deviations.md D-097, D-142, D-143):
 * - On an account without booked transactions it answers 200 `{objects: [null]}` and archives the
 *   account: status 0, left out of `GET /CheckAccount`, still readable by id. Its open
 *   transactions get `deletedAt` (they leave the lists and balances, D-096), and its IBAN is
 *   cleared (the BIC stays). Clearing accounts behave the same.
 * - On an account with a booked transaction (status 200 or higher, enshrined or not) it changes
 *   nothing and answers HTTP 200 with `{objects: null, error: {code: 159, message: "Cannot delete
 *   because of existing necessary references"}}` (D-142).
 * - Nothing restores an archived account through the API: `PUT {status: 100}` is answered 200 and
 *   ignored (D-143). So archiving is irreversible from here.
 *
 * Refused before anything is sent: an archived account, a cash register (archiving one was not
 * recorded: the trial has only one), a bank-connected account or one of an undocumented type (not
 * recorded), the default account (Standardkonto; not recorded), an account with booked
 * transactions, and one with more transactions than one check reads. sevDesk's own refusal stays
 * the backstop for a booking made after the check. The DELETE is never retried.
 */
import type { ConfirmationPreview } from "../safety/write-types.js";
import { isReferenceRefusal, SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { ACCOUNT_KIND_TEXT, changeableKind } from "./bank-account-update.js";
import {
  ACCOUNT_ROWS_MAX,
  type BankAccountDto,
  getStoredCheckAccount,
  maskIban,
  readAccountTransactions,
  type StoredCheckAccount,
  type TransactionDto,
} from "./banking.js";
import { type Fact, formatMoney } from "./lifecycle/preview.js";
import { refuse } from "./lifecycle/transitions.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "./preview-text.js";

/** Open transactions the previews list by id at most; the count always covers all of them. */
const OPEN_LISTED_MAX = 10;

export interface BankAccountArchiveState {
  readonly id: number;
  /** Open transactions sevDesk deletes with the account (D-097). */
  readonly openTransactions: number;
}

export interface BankAccountArchivePlan {
  readonly preview: ConfirmationPreview;
  readonly previewDe: ConfirmationPreview;
  readonly state: BankAccountArchiveState;
}

/**
 * Checks an archive and builds both previews. Reads only (`GET /CheckAccount/{id}`, the account's
 * transactions). The previews show the account as stored and its open transactions, so an approval
 * binds to them: a new or booked transaction before the call runs changes the preview, and the
 * human is asked again.
 */
export async function planBankAccountArchive(
  client: SevdeskClient,
  accountId: number,
  signal?: AbortSignal,
): Promise<BankAccountArchivePlan> {
  const id = toSevdeskId(accountId);
  const stored = await getStoredCheckAccount(client, id, signal);
  const { account } = stored;
  const ref = `Payment account ${String(id)}`;

  if (stored.archived) refuse(`${ref} is archived already.`);
  const kind = changeableKind(account, "Archiving");
  if (kind === "cash") {
    refuse(
      `${ref} is a cash register (Kasse). Archiving one through the API is not supported: what ` +
        "sevDesk does with it is not recorded. Use the sevDesk web app.",
    );
  }
  if (account.isDefault) {
    refuse(
      `${ref} is the default account (Standardkonto). Archiving it is not supported: what sevDesk ` +
        "does with it is not recorded. Make another account the default in the sevDesk web app " +
        "first.",
    );
  }

  const rows = await readAccountTransactions(client, id, signal);
  if (rows.booked.length > 0) {
    const ids = rows.booked.slice(0, 5).map((row) => String(row.id));
    const more = rows.booked.length > ids.length ? ", …" : "";
    refuse(
      `${ref} has booked transactions (${ids.join(", ")}${more}), and sevDesk does not archive ` +
        "an account with booked transactions. Undo their bookings first " +
        "(sevdesk_transaction_reset; not possible once a transaction is enshrined), or keep the " +
        "account.",
    );
  }
  if (!rows.complete) {
    refuse(
      `${ref} has more than ${String(ACCOUNT_ROWS_MAX)} transactions, more than one check reads, ` +
        "so what archiving would delete cannot be shown. Use the sevDesk web app.",
    );
  }

  const warnings = archiveWarnings(stored, rows.open.length);
  return {
    ...bothPreviews((lang) => ({
      action:
        lang === "de"
          ? `Zahlungskonto ${String(id)} archivieren.`
          : `Archive payment account ${String(id)}.`,
      facts: archiveFacts(stored, ACCOUNT_KIND_TEXT[kind][lang], rows.open, lang),
      warnings: warnings.map((warning) => warning[lang]),
      // Nothing restores an archived account through the API (D-143).
      irreversible: true,
    })),
    state: { id, openTransactions: rows.open.length },
  };
}

function archiveWarnings(stored: StoredCheckAccount, open: number): Phrase[] {
  const warnings: Phrase[] = [
    phrase(
      "sevDesk archives the account (sevDesk's API calls this delete): it leaves the account " +
        "lists and can no longer be chosen, but stays readable by id. It cannot be restored " +
        "through the API.",
      "sevDesk archiviert das Konto (die API nennt das Löschen): Es verschwindet aus den " +
        "Kontolisten und kann nicht mehr gewählt werden, bleibt aber über seine ID lesbar. Über " +
        "die API lässt es sich nicht wiederherstellen.",
    ),
  ];
  if (open > 0) {
    warnings.push(
      phrase(
        open === 1
          ? "sevDesk deletes the account's 1 open (unbooked) transaction with it: it leaves the " +
              "transaction lists and the balance (Saldo), marked as deleted."
          : `sevDesk deletes the account's ${String(open)} open (unbooked) transactions with ` +
              "it: they leave the transaction lists and the balance (Saldo), marked as deleted.",
        open === 1
          ? "sevDesk löscht den offenen (ungebuchten) Umsatz des Kontos mit: Er verschwindet aus " +
              "den Umsatzlisten und aus dem Saldo, als gelöscht markiert."
          : `sevDesk löscht die ${String(open)} offenen (ungebuchten) Umsätze des Kontos mit: ` +
              "Sie verschwinden aus den Umsatzlisten und aus dem Saldo, als gelöscht markiert.",
      ),
    );
  }
  if (stored.iban !== undefined) {
    warnings.push(
      phrase(
        "sevDesk clears the account's stored IBAN when it archives it (the BIC stays).",
        "sevDesk entfernt beim Archivieren die gespeicherte IBAN des Kontos (die BIC bleibt).",
      ),
    );
  }
  warnings.push(
    phrase(
      "Checked: none of the account's transactions is booked; sevDesk refuses to archive an " +
        "account with booked ones.",
      "Geprüft: Keiner der Umsätze des Kontos ist gebucht; ein Konto mit gebuchten Umsätzen " +
        "archiviert sevDesk nicht.",
    ),
  );
  return warnings;
}

/** The account as stored, then its open transactions, in the order both previews use. */
function archiveFacts(
  stored: StoredCheckAccount,
  kind: string,
  open: readonly TransactionDto[],
  lang: PreviewLanguage,
): Fact[] {
  const de = lang === "de";
  const { account } = stored;
  const facts: Fact[] = [
    {
      label: de ? "Zahlungskonto" : "Payment account",
      value: `${de ? "ID" : "id"} ${String(account.id)}`,
    },
    { label: de ? "Art" : "Kind", value: kind },
    { label: "Name", value: account.name },
    {
      label: de ? "Buchungskonto" : "Booking account (Buchungskonto)",
      value: account.accountingNumber ?? (de ? "keines" : "none"),
    },
  ];
  const iban = maskIban(stored.iban);
  if (iban !== undefined) facts.push({ label: "IBAN", value: iban });
  const listed = open.slice(0, OPEN_LISTED_MAX);
  facts.push({
    label: de ? "Offene Umsätze, die gelöscht werden" : "Open transactions deleted with it",
    value:
      open.length === 0
        ? de
          ? "keine"
          : "none"
        : open.length > listed.length
          ? de
            ? `${String(open.length)}, die ersten ${String(listed.length)} unten`
            : `${String(open.length)}, the first ${String(listed.length)} listed below`
          : String(open.length),
  });
  for (const row of listed) {
    const parts = [
      row.valueDate === undefined ? undefined : dateText(row.valueDate, lang),
      formatMoney(row.amount, lang),
      row.counterparty,
    ].filter((part): part is string => part !== undefined && part !== "");
    facts.push({
      label: de ? `Kontoumsatz ${String(row.id)}` : `Bank transaction ${String(row.id)}`,
      value: parts.join(", "),
    });
  }
  return facts;
}

/**
 * Archives the account (`DELETE /CheckAccount/{id}`, never retried) and reads it back: success is
 * status 0 on the read-back. sevDesk's refusal for booked transactions (HTTP 200 with an error,
 * D-142) becomes a trusted sentence of our own.
 */
export async function executeBankAccountArchive(
  client: SevdeskClient,
  state: BankAccountArchiveState,
  signal?: AbortSignal,
): Promise<BankAccountDto> {
  try {
    await client.request({
      method: "DELETE",
      path: sevdeskPath("CheckAccount", state.id),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && isReferenceRefusal(error)) {
      throw bookedRefusal(error, state.id);
    }
    throw error;
  }
  const changed = [{ objectName: "CheckAccount", id: String(state.id) }];
  let after: StoredCheckAccount;
  try {
    after = await getStoredCheckAccount(client, state.id, signal);
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, changed);
    throw error;
  }
  if (!after.archived) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted archiving payment account ${String(state.id)}, but reading it back ` +
        "shows it still active. Check it with sevdesk_bank_accounts_list before trying again.",
      completedWrites: changed,
    });
  }
  return after.account;
}

/** sevDesk's refusal (D-142) in our words; status, request and exception id are kept. */
function bookedRefusal(error: SevdeskError, id: number): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message:
      `sevDesk refused to archive payment account ${String(id)}: transactions on it are booked ` +
      "(probably booked after the check). Nothing was changed. Find them with " +
      "sevdesk_transactions_list (checkAccountId), undo their bookings with " +
      "sevdesk_transaction_reset (not possible once enshrined), or keep the account.",
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    explained: true,
    cause: error,
  });
}
