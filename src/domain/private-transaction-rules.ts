/**
 * Private-transaction rules (`PrivateTransactionRule`): the texts by which sevDesk marks bank
 * transactions private on its own. The reads, checks, plans and requests behind
 * `sevdesk_private_transaction_rules_list`, `sevdesk_private_transaction_rule_create` and
 * `sevdesk_private_transaction_rule_delete`.
 *
 * What is recorded (trial account, Update 2.0, spec/deviations.md D-099 and D-130):
 * - `GET /PrivateTransactionRule` with `limit`/`offset` answers `{objects: [...]}`, rows with `id`,
 *   `objectName`, `create`, `update`, `sevClient`, `paymentPurpose` and `counterpartName`; with
 *   `countAll=true` (the client always sends it) it reports `total`, and paging works. In which
 *   order it lists rules is not recorded.
 * - `POST /PrivateTransactionRule` with `objectName` and one of the two texts answers 2xx with the
 *   rule wrapped in `objects`; the text not sent is `null`. It stores a text exactly as sent
 *   (spaces included), cuts one over 255 characters to 255 without notice (D-130), accepts a rule
 *   with both texts, stores a second rule with the same text without complaint, and refuses one
 *   with neither (422). `DELETE /PrivateTransactionRule/{id}` answers `{objects: [null]}`.
 * - Two rules (one per text) turned none of five open transactions entered by hand private, not
 *   even one created after them, and deleting them changed nothing. sevDesk most likely applies
 *   rules only when it imports transactions from the bank, which a trial account cannot do. How a
 *   rule matches (exact, contains, case, both texts or either) is therefore not known.
 *
 * So this module sends one trimmed text per rule of at most {@link RULE_TEXT_MAX} characters,
 * refuses a duplicate itself (sevDesk would store it), and checks the stored text on the
 * read-back. Changing a rule is not recorded and not offered.
 *
 * The open transactions a new rule "would touch" are an estimate made here: the rule's text found,
 * ignoring case, inside the counterparty or purpose of open (unbooked) transactions. Every text
 * that shows it says that it is an estimate and that sevDesk acts on bank imports; nothing here
 * says that a transaction will become private.
 *
 * Rule texts read from sevDesk are untrusted: they reach the output only cleaned
 * (`cleanText`), and never a message. Nothing here retries a write.
 */
import { z } from "zod";

import type { SevdeskObjectRef } from "../safety/write-types.js";
import { toBerlinDate } from "../sevdesk/dates.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { listTransactions, type TransactionDto } from "./banking.js";
import { cleanText, compact } from "./common.js";
import { refuse } from "./lifecycle/transitions.js";
import { type ListPage, readPage } from "./paging.js";

const RULE_PATH = "/PrivateTransactionRule";
const OBJECT_NAME = "PrivateTransactionRule";

/** sevDesk's maximum page size: one request reads every rule an account plausibly has. */
const RULES_PAGE_SIZE = 1000;
/**
 * Pages the read-back after a create reads at most while it looks for the new rule. In which order
 * sevDesk lists rules is not recorded, so on an account with more than {@link RULES_PAGE_SIZE}
 * rules the new one can be on any page; five pages (5000 rules) bound the requests.
 */
const READ_BACK_PAGES = 5;

/**
 * Fewest letters or digits a rule text needs. A rule marks every bank import it matches private,
 * and if sevDesk matches by "contains", a text of one to three characters ("AG", "dm", "EUR",
 * "Re") occurs inside a great many unrelated counterparties and purposes. Four still allows short
 * real names such as "REWE", "ALDI", "Lohn" or "Miete". Spaces and punctuation do not count.
 */
export const RULE_TEXT_MIN = 4;
/**
 * Longest rule text accepted here. sevDesk keeps 255 characters and cuts a longer text without
 * notice (D-130); 100 is ample for a name or a purpose and stays clear of that cut.
 */
export const RULE_TEXT_MAX = 100;
/** Longest rule text shown from sevDesk (untrusted; a rule made elsewhere may be longer). */
const RULE_TEXT_DISPLAY_MAX = 200;
/** Open transactions the estimate examines at most. */
const ESTIMATE_SCAN_LIMIT = 500;
/** Transactions of the estimate a preview lists by id at most. */
export const ESTIMATE_LISTED_MAX = 10;

/** What a rule matches on, as the tools name it. */
export type RuleField = "counterparty" | "purpose";

// ---------------------------------------------------------------------------------------------
// Upstream record and DTO
// ---------------------------------------------------------------------------------------------

/** One rule as `GET /PrivateTransactionRule` lists it (lenient; keys as recorded, D-099). */
const ruleRecordSchema = z.object({
  id: zId,
  paymentPurpose: zText,
  counterpartName: zText,
  create: zText,
});

type RuleRecord = z.output<typeof ruleRecordSchema>;

/** One private-transaction rule (also the tools' output schema). */
export const privateRuleDtoSchema = z.object({
  id: z.number().int(),
  counterparty: z
    .string()
    .optional()
    .describe("Counterparty (Auftraggeber/Empfänger) text the rule matches (counterpartName)."),
  purpose: z
    .string()
    .optional()
    .describe("Purpose (Verwendungszweck) text the rule matches (paymentPurpose)."),
  createdOn: z.string().optional().describe("Day the rule was created, YYYY-MM-DD (Berlin)."),
});

export type PrivateRuleDto = z.output<typeof privateRuleDtoSchema>;

function parseRule(raw: unknown): RuleRecord {
  return parseUpstream(ruleRecordSchema, raw, "a private-transaction rule");
}

function toRuleDto(record: RuleRecord): PrivateRuleDto {
  return compact({
    id: record.id,
    counterparty: cleanText(record.counterpartName, RULE_TEXT_DISPLAY_MAX),
    purpose: cleanText(record.paymentPurpose, RULE_TEXT_DISPLAY_MAX),
    createdOn: creationDay(record.create),
  });
}

/** The Berlin day of `create`; `undefined` when absent or not a readable date. */
function creationDay(create: string | undefined): string | undefined {
  try {
    return toBerlinDate(create);
  } catch {
    // The rule is listed all the same; only its day is unknown.
    return undefined;
  }
}

/** The record ref of a rule, for `affected` and completed writes. */
export function ruleObject(id: number): SevdeskObjectRef {
  return { objectName: OBJECT_NAME, id: String(id) };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** One page of rules (`GET /PrivateTransactionRule`, explicit `limit`). */
export function listPrivateRules(
  client: SevdeskClient,
  page: { readonly limit: number; readonly offset: number },
  signal?: AbortSignal,
): Promise<ListPage<PrivateRuleDto>> {
  return readPage(client, RULE_PATH, {}, page, (raw) => toRuleDto(parseRule(raw)), signal);
}

/**
 * A listed rule with its stored texts exactly as sevDesk answered them, and comparison keys of
 * them. Both are untrusted: never put them into messages.
 */
interface RuleEntry {
  readonly rule: PrivateRuleDto;
  readonly keys: { readonly counterparty: string; readonly purpose: string };
  readonly stored: {
    readonly counterparty: string | undefined;
    readonly purpose: string | undefined;
  };
}

/** The rules of the first page; `complete` is false when more may exist. */
function readAllRules(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<{ readonly entries: readonly RuleEntry[]; readonly complete: boolean }> {
  return readRulePage(client, 0, signal);
}

/** The rules of the page at `offset`; `complete` is false when more may follow it. */
async function readRulePage(
  client: SevdeskClient,
  offset: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly entries: readonly RuleEntry[]; readonly complete: boolean }> {
  const page = await client.list(RULE_PATH, undefined, {
    limit: RULES_PAGE_SIZE,
    offset,
    ...(signal === undefined ? {} : { signal }),
  });
  const entries = page.items.map(parseRule).map((record) => ({
    rule: toRuleDto(record),
    keys: {
      counterparty: textKey(record.counterpartName),
      purpose: textKey(record.paymentPurpose),
    },
    stored: { counterparty: record.counterpartName, purpose: record.paymentPurpose },
  }));
  const received = page.items.length;
  const complete =
    page.total === undefined ? received < RULES_PAGE_SIZE : page.total <= offset + received;
  return { entries, complete };
}

/** What {@link findRule} found, and whether it read the whole list. */
interface RuleSearch {
  readonly entry: RuleEntry | undefined;
  /**
   * False when the pages ran out (or sevDesk sent an empty page) before the end of the list, so a
   * rule not found may sit further on.
   */
  readonly searchedAll: boolean;
  /** Rules read. */
  readonly read: number;
}

/** Looks for rule `id` page by page, at most {@link READ_BACK_PAGES} pages. */
async function findRule(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<RuleSearch> {
  let read = 0;
  for (let page = 0; page < READ_BACK_PAGES; page += 1) {
    const { entries, complete } = await readRulePage(client, read, signal);
    read += entries.length;
    const entry = entries.find((candidate) => candidate.rule.id === id);
    if (entry !== undefined) return { entry, searchedAll: true, read };
    if (complete) return { entry: undefined, searchedAll: true, read };
    if (entries.length === 0) break;
  }
  return { entry: undefined, searchedAll: false, read };
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** What `sevdesk_private_transaction_rule_create` is asked for (texts trimmed, or absent). */
export interface PrivateRuleCreateInput {
  readonly counterparty?: string | undefined;
  readonly purpose?: string | undefined;
}

const createPayloadSchema = z.union([
  z.strictObject({ objectName: z.literal(OBJECT_NAME), counterpartName: z.string().min(1) }),
  z.strictObject({ objectName: z.literal(OBJECT_NAME), paymentPurpose: z.string().min(1) }),
]);

type PrivateRuleCreatePayload = z.output<typeof createPayloadSchema>;

/** The open transactions that look like what a new rule is meant for (see the module comment). */
interface RuleEstimate {
  /** Matches in the order sevDesk listed them, at most {@link ESTIMATE_LISTED_MAX}. */
  readonly listed: readonly TransactionDto[];
  /** All matches among the examined transactions. */
  readonly matches: number;
  /** Open transactions examined. */
  readonly examined: number;
  /** False when more open transactions exist than were examined. */
  readonly complete: boolean;
}

/** Everything the preview and the request of a new rule need; built from reads only. */
export interface PrivateRuleCreatePlan {
  readonly field: RuleField;
  /** The text as the preview shows it. */
  readonly text: string;
  readonly payload: PrivateRuleCreatePayload;
  readonly estimate: RuleEstimate;
  /** False when more rules may exist than the duplicate check read (one page of 1000). */
  readonly rulesComplete: boolean;
}

/**
 * Checks a new rule and builds its request and the estimate. Reads only: the rules (the duplicate
 * check) and up to {@link ESTIMATE_SCAN_LIMIT} open transactions. Refuses, with a trusted
 * `validation` error before anything is sent: no text, both texts (not recorded: whether sevDesk
 * then needs both or either), a text with fewer than {@link RULE_TEXT_MIN} letters or digits, and a
 * rule with the same text(s) as an existing one (compared without case and extra spaces; the
 * existing rule is named by id).
 */
export async function planPrivateRuleCreate(
  client: SevdeskClient,
  input: PrivateRuleCreateInput,
  signal?: AbortSignal,
): Promise<PrivateRuleCreatePlan> {
  const { field, text } = singleText(input);
  if (significantLength(text) < RULE_TEXT_MIN) {
    refuse(
      `The rule's text is too short: it needs at least ${String(RULE_TEXT_MIN)} letters or ` +
        "digits. A rule marks every bank import it matches as private, and a short text such as " +
        '"AG" or "dm" occurs in a great many unrelated counterparties and purposes. Nothing was ' +
        "sent.",
    );
  }

  const { entries, complete } = await readAllRules(client, signal);
  const wanted = {
    counterparty: field === "counterparty" ? textKey(text) : "",
    purpose: field === "purpose" ? textKey(text) : "",
  };
  const same = entries.find(
    (entry) =>
      entry.keys.counterparty === wanted.counterparty && entry.keys.purpose === wanted.purpose,
  );
  if (same !== undefined) {
    refuse(
      `Private-transaction rule ${String(same.rule.id)} already has this ${FIELD_NOUN[field]} ` +
        "text (compared without case and extra spaces), so a second one would change nothing. " +
        "Nothing was sent; sevdesk_private_transaction_rules_list shows the rule.",
    );
  }

  const payload = createPayloadSchema.parse(
    field === "counterparty"
      ? { objectName: OBJECT_NAME, counterpartName: text }
      : { objectName: OBJECT_NAME, paymentPurpose: text },
  );
  return {
    field,
    text: cleanText(text, RULE_TEXT_MAX) ?? "",
    payload,
    estimate: await estimateMatches(client, field, text, signal),
    rulesComplete: complete,
  };
}

const FIELD_NOUN: Readonly<Record<RuleField, string>> = {
  counterparty: "counterparty",
  purpose: "purpose",
};

/** The one text of a new rule; refuses none and both. */
function singleText(input: PrivateRuleCreateInput): { field: RuleField; text: string } {
  const { counterparty, purpose } = input;
  if (counterparty !== undefined && purpose !== undefined) {
    refuse(
      "A rule takes one text here: counterparty or purpose. sevDesk would store a rule with " +
        "both, but whether it then needs both texts to match or only one is not known, so such " +
        "a rule is refused. Create one rule per text if either text should mark a transaction " +
        "private. Nothing was sent.",
    );
  }
  if (counterparty !== undefined) return { field: "counterparty", text: counterparty };
  if (purpose !== undefined) return { field: "purpose", text: purpose };
  return refuse(
    "Give the text the rule matches: counterparty (Auftraggeber/Empfänger) or purpose " +
      "(Verwendungszweck). Nothing was sent.",
  );
}

/**
 * The open (unbooked, status 100) transactions whose counterparty or purpose contains `text`,
 * ignoring case and extra spaces: the local stand-in for sevDesk's unmeasured matching. Reads at
 * most {@link ESTIMATE_SCAN_LIMIT} open transactions, newest pages as sevDesk lists them.
 */
async function estimateMatches(
  client: SevdeskClient,
  field: RuleField,
  text: string,
  signal: AbortSignal | undefined,
): Promise<RuleEstimate> {
  const scan = await listTransactions(
    client,
    { statuses: ["created"], limit: ESTIMATE_SCAN_LIMIT, offset: 0 },
    { signal },
  );
  const wanted = textKey(text);
  const matching = scan.items.filter((row) =>
    textKey(field === "counterparty" ? row.counterparty : row.purpose).includes(wanted),
  );
  return {
    listed: matching.slice(0, ESTIMATE_LISTED_MAX),
    matches: matching.length,
    examined: scan.items.length,
    complete: !scan.hasMore && !scan.scanCapped,
  };
}

/** The new rule as read back, and how it differs from the request. */
export interface PrivateRuleCreated {
  /** As read back; as sevDesk answered the POST when the read-back did not reach it (see notes). */
  readonly rule: PrivateRuleDto;
  /**
   * Trusted sentences naming each difference between the request and what sevDesk stored, or that
   * the read-back did not reach the rule.
   */
  readonly notes: readonly string[];
}

/**
 * Creates the rule (one POST, never retried), takes it from sevDesk's answer and confirms it by
 * reading the rules back, page by page up to {@link READ_BACK_PAGES} pages. An answer without an
 * id, a failed read-back and a rule missing from the whole list fail with a message that says the
 * rule was probably created, so the call is not repeated blindly. A list longer than the read-back
 * reads, without the rule in it, is not taken as a failure: the rule is returned as sevDesk
 * answered the POST, with a note that its stored text was not checked.
 */
export async function executePrivateRuleCreate(
  client: SevdeskClient,
  payload: PrivateRuleCreatePayload,
  signal?: AbortSignal,
): Promise<PrivateRuleCreated> {
  const answer = await client.request({
    method: "POST",
    path: RULE_PATH,
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
  const created = createdRule(answer);
  if (created === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the new private-transaction rule, but its answer did not name it, so " +
        "its id is unknown. Do not repeat the call: look for the rule with " +
        "sevdesk_private_transaction_rules_list first.",
    });
  }
  const { id } = created;
  const changed = [ruleObject(id)];
  const { entry, searchedAll, read } = await afterWrite(changed, () =>
    findRule(client, id, signal),
  );
  if (entry === undefined && !searchedAll) {
    return {
      rule: toRuleDto(created),
      notes: [
        `Rule ${String(id)} is not among the first ${String(read)} rules sevDesk lists, so it ` +
          "is shown as sevDesk answered the create and the text it stored was not checked; " +
          "check it with sevdesk_private_transaction_rules_list.",
      ],
    };
  }
  if (entry === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted private-transaction rule ${String(id)}, but it is not in the list of ` +
        "rules read afterwards. Check it with sevdesk_private_transaction_rules_list before " +
        "trying again.",
      completedWrites: changed,
    });
  }
  // Compared exactly with the trimmed text that was sent: sevDesk stores a text as sent (spaces
  // included) and cuts one over 255 characters without notice (D-099), so any difference means
  // it changed the text.
  const requested =
    "counterpartName" in payload
      ? { counterparty: payload.counterpartName, purpose: undefined }
      : { counterparty: undefined, purpose: payload.paymentPurpose };
  const notes =
    entry.stored.counterparty === requested.counterparty &&
    entry.stored.purpose === requested.purpose
      ? []
      : [
          `sevDesk stored rule ${String(id)} with other texts than were sent; check it with ` +
            "sevdesk_private_transaction_rules_list.",
        ];
  return { rule: entry.rule, notes };
}

/**
 * The rule in sevDesk's answer to the POST (one object, or an array of one; recorded with the
 * listed keys, D-099); `undefined` when it names no id.
 */
function createdRule(answer: unknown): RuleRecord | undefined {
  let single: unknown;
  try {
    single = expectSingle(answer, "created private-transaction rule");
  } catch (error) {
    if (error instanceof SevdeskError) return undefined;
    throw error;
  }
  const parsed = ruleRecordSchema.safeParse(single);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

/**
 * Finds the rule to delete in the list (sevDesk has no recorded read by id). Refuses an id that is
 * not listed, saying when the list may be incomplete.
 */
export async function planPrivateRuleDelete(
  client: SevdeskClient,
  ruleId: number,
  signal?: AbortSignal,
): Promise<{ readonly rule: PrivateRuleDto }> {
  const id = toSevdeskId(ruleId);
  const { entries, complete } = await readAllRules(client, signal);
  const entry = entries.find((candidate) => candidate.rule.id === id);
  if (entry === undefined) {
    refuse(
      `There is no private-transaction rule ${String(id)}` +
        (complete ? "" : ` among the first ${String(RULES_PAGE_SIZE)} rules sevDesk lists`) +
        "; find the rules with sevdesk_private_transaction_rules_list. Nothing was sent.",
    );
  }
  return { rule: entry.rule };
}

/**
 * Deletes the rule (one DELETE, never retried) and confirms it by reading the rules back: success
 * is the rule missing from the list. A rule still listed, or a failed read, fails with the rule as
 * a completed write: sevDesk accepted the request, and the user must look before trying again.
 */
export async function executePrivateRuleDelete(
  client: SevdeskClient,
  ruleId: number,
  signal?: AbortSignal,
): Promise<void> {
  const id = toSevdeskId(ruleId);
  await client.request({
    method: "DELETE",
    path: sevdeskPath("PrivateTransactionRule", id),
    ...(signal === undefined ? {} : { signal }),
  });
  const changed = [ruleObject(id)];
  const { entries } = await afterWrite(changed, () => readAllRules(client, signal));
  if (entries.some((entry) => entry.rule.id === id)) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted the delete of private-transaction rule ${String(id)}, but the rule is ` +
        "still listed afterwards. Check it with sevdesk_private_transaction_rules_list before " +
        "trying again.",
      completedWrites: changed,
    });
  }
}

/** A read after a write; a failed read is rethrown with `changed` as completed writes. */
async function afterWrite<T>(
  changed: readonly SevdeskObjectRef[],
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, changed);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/** A text for comparisons: Unicode-normalized, spaces collapsed, trimmed, case folded; none is "". */
function textKey(text: string | undefined): string {
  return (text ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

/** Letters and digits in `text` (what {@link RULE_TEXT_MIN} counts). */
function significantLength(text: string): number {
  return Array.from(text.normalize("NFKC")).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
}
