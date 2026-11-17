/**
 * Cost centres (Kostenstellen) of invoices, vouchers and credit notes: lenient parsing of
 * sevDesk's `CostCentre` records, the account's list, the `costCentre` argument of the draft tools
 * (resolved by id, number or name), the `costCentre` filter of the invoice and voucher lists, and
 * the cost-centre fact of the previews and approvals.
 *
 * Recorded 2026-11-16 (spec/deviations.md D-091, D-092):
 * - `GET /CostCentre` (not in the spec) answers rows with `id`, `number` (at most 8 characters),
 *   `name`, `color`, `postingAccount` and `defaultCentre` ("0"/"1"), with `total`. How it pages
 *   was not measured, so one page of {@link COST_CENTRE_LIST_LIMIT} is read and a longer list is
 *   reported as cut.
 * - `saveInvoice`, `saveVoucher` and `saveCreditNote` store `costCentre: {id, objectName:
 *   "CostCentre"}` on create and on an update with the id, and keep it when a later update leaves
 *   it out. `saveOrder` drops it silently: orders never take one here.
 * - `GET /Invoice` and `GET /Voucher` filter by `costCentre[id]` + `costCentre[objectName]`; the
 *   rows carry their `costCentre`, so every row is checked again here. `costCentre=<id>` alone
 *   answers 422. The credit-note list filter was not measured and is not offered.
 * - Recorded 2026-11-17: an update with the id and `costCentre: null` removes the cost centre
 *   (invoices, vouchers, credit notes); the three update tools offer it as `removeCostCentre`.
 *
 * Numbers and names are untrusted text: they go into DTOs and preview values through `cleanText`
 * and never into summaries or error messages. Where they are display only (the get tools and
 * approvals of stored documents), a failing list read shows the id alone ({@link showCostCentre});
 * where an argument is resolved, it fails the call.
 */
import { z } from "zod";

import { SevdeskError } from "../sevdesk/errors.js";
import { parseUpstream, zBool01, zId, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact } from "./common.js";
import { type Phrase, phrase, type PreviewLanguage } from "./preview-text.js";

/**
 * Page size of the one `GET /CostCentre` read: sevDesk's maximum `limit`. An account with more
 * cost centres is reported as cut (`truncated`), and a lookup beyond them is refused.
 */
const COST_CENTRE_LIST_LIMIT = 1000;

/** Longest number or name accepted as an argument (sevDesk allows 8-character numbers). */
const COST_CENTRE_TEXT_MAX = 100;
const NAME_MAX = 200;

// ---------------------------------------------------------------------------------------------
// Records and DTOs
// ---------------------------------------------------------------------------------------------

const costCentreRecordSchema = z.object({
  id: zId,
  number: zText,
  name: zText,
  defaultCentre: zBool01.optional(),
});

/** One cost centre: `sevdesk_reference_lookup` kind=cost_centres and the get tools. */
export const costCentreDtoSchema = z.object({
  id: z.number().int().describe("Cost centre id: pass it as costCentre."),
  number: z.string().optional().describe("Kostenstellennummer as stored in sevDesk."),
  name: z.string().optional().describe("Name as stored in sevDesk."),
  isDefault: z
    .boolean()
    .optional()
    .describe("sevDesk's default cost centre (defaultCentre); only shown when true."),
});

export type CostCentre = z.output<typeof costCentreDtoSchema>;

function parseCostCentre(raw: unknown): CostCentre {
  const record = parseUpstream(costCentreRecordSchema, raw, "a cost centre");
  return compact({
    id: record.id,
    number: cleanText(record.number, NAME_MAX),
    name: cleanText(record.name, NAME_MAX),
    isDefault: record.defaultCentre === true ? true : undefined,
  });
}

/** The account's cost centres as far as read. */
export interface CostCentreList {
  readonly items: readonly CostCentre[];
  /** sevDesk's `total` when it sent one, else the number of items read. */
  readonly total: number;
  /** True when the account has more cost centres than were read. */
  readonly truncated: boolean;
}

/** Reads the account's cost centres (`GET /CostCentre`, one page with an explicit `limit`). */
export async function listCostCentres(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<CostCentreList> {
  const page = await client.list("/CostCentre", undefined, {
    limit: COST_CENTRE_LIST_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  });
  const items = page.items.map(parseCostCentre);
  const truncated =
    page.total === undefined ? items.length >= COST_CENTRE_LIST_LIMIT : page.total > items.length;
  return { items, total: page.total ?? items.length, truncated };
}

/**
 * A cost centre for a preview fact: "MCP1 Werkstatt (id 344959)" ("… (ID 344959)" in German),
 * from cleaned values.
 */
export function costCentreLabel(centre: CostCentre, lang: PreviewLanguage = "en"): string {
  const id = `${lang === "de" ? "ID" : "id"} ${String(centre.id)}`;
  const text = [centre.number, centre.name].filter((part) => part !== undefined).join(" ");
  return text === "" ? id : `${text} (${id})`;
}

/**
 * The cost centre with this id as the account lists it, or `{id}` alone when the list does not
 * have it (deleted, or beyond the cut). A failing list read fails the call: the update previews
 * use it; display-only callers go through {@link showCostCentre}.
 */
export async function describeCostCentre(
  client: SevdeskClient,
  id: number,
  signal?: AbortSignal,
): Promise<CostCentre> {
  const list = await listCostCentres(client, signal);
  return list.items.find((centre) => centre.id === id) ?? { id };
}

/** A stored cost centre for display (get tools, approvals). */
export interface ShownCostCentre {
  readonly centre: CostCentre;
  /** True when the account's list could not be read: `centre` is then the id alone. */
  readonly unread: boolean;
}

/**
 * The stored cost centre with this id for display only: {@link describeCostCentre}, or the id
 * alone (`unread`) when `GET /CostCentre` fails with any `SevdeskError` but a cancelled call or
 * this server's own guard (`aborted`, `blocked`), e.g. on a plan or for a user without cost
 * centres. The id comes from the document record, which approvals bind, so number and name are
 * display only and an unreadable list need not block reading, finalizing or sending a document
 * (like an unreadable layout, `readApprovalLayout` in `lifecycle/content.ts`). The draft tools'
 * arguments are still resolved strictly: a guess there would book costs on the wrong cost centre.
 */
export async function showCostCentre(
  client: SevdeskClient,
  id: number,
  signal?: AbortSignal,
): Promise<ShownCostCentre> {
  try {
    return { centre: await describeCostCentre(client, id, signal), unread: false };
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted" && error.kind !== "blocked") {
      return { centre: { id }, unread: true };
    }
    throw error;
  }
}

/** The approval warning for a cost centre shown by its id alone ({@link ShownCostCentre}). */
export const COST_CENTRE_UNREAD: Phrase = phrase(
  "The number and name of the cost centre could not be read from sevDesk, so only its id is " +
    "shown. Check them in sevDesk before you approve.",
  "Nummer und Name der Kostenstelle ließen sich nicht aus sevDesk lesen; gezeigt wird nur ihre " +
    "ID. Prüfe sie vor der Freigabe in sevDesk.",
);

/** The `costCentre` output field of the get tools (invoice, voucher, credit note). */
export const costCentreOutput = costCentreDtoSchema
  .optional()
  .describe(
    "The document's Kostenstelle with number and name (the id alone when sevDesk does not " +
      "list it or its list could not be read); left out when none is set.",
  );

/**
 * The {@link costCentreOutput} value of a get tool for a document's `costCentreId`: `{}` without
 * one (no request), else `{costCentre}` from {@link showCostCentre}.
 */
export async function costCentreOf(
  client: SevdeskClient,
  costCentreId: number | undefined,
  signal?: AbortSignal,
): Promise<{ costCentre?: CostCentre }> {
  return costCentreId === undefined
    ? {}
    : { costCentre: (await showCostCentre(client, costCentreId, signal)).centre };
}

/** The `costCentre` reference a raw document record stores, if any. */
const storedCostCentreSchema = z.object({ costCentre: zOptionalRef });

/**
 * The cost centre a raw document record (`GET /Invoice/{id}`, `/Voucher/{id}`, …) carries, from
 * {@link showCostCentre}; `undefined` without one (no request then).
 */
export async function storedCostCentre(
  client: SevdeskClient,
  raw: unknown,
  signal?: AbortSignal,
): Promise<ShownCostCentre | undefined> {
  const ref = parseUpstream(storedCostCentreSchema, raw, "a document").costCentre;
  return ref === undefined ? undefined : showCostCentre(client, ref.id, signal);
}

/** The approval fact of a stored cost centre, in both languages; none without one. */
export function costCentreFacts(
  centre: CostCentre | undefined,
  lang: PreviewLanguage,
): { label: string; value: string }[] {
  if (centre === undefined) return [];
  return [
    {
      label: lang === "de" ? "Kostenstelle" : "Cost centre (Kostenstelle)",
      value: costCentreLabel(centre, lang),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The costCentre argument
// ---------------------------------------------------------------------------------------------

/** A cost centre as a tool argument: its id, or its number or name as text. */
export type CostCentreArg = number | string;

const costCentreValue = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().trim().min(1).max(COST_CENTRE_TEXT_MAX),
]);

/** The `costCentre` argument of the invoice, voucher and credit note draft tools. */
export const costCentreInput = costCentreValue
  .optional()
  .describe(
    "Kostenstelle: its id (number), or its number or name (text, case and accents ignored); " +
      "see sevdesk_reference_lookup kind=cost_centres. An unknown or ambiguous one is refused.",
  );

/**
 * A number or name as compared here: trimmed, letter case and accents ignored (NFKD splits an
 * accented letter into base letter and mark; the marks are dropped).
 */
function fold(text: string): string {
  return text.trim().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The cost centres an argument names: a number by id only; a text by id (all digits), number or
 * name, compared folded. Among several, the one spelled exactly so wins.
 */
function matching(items: readonly CostCentre[], value: CostCentreArg): CostCentre[] {
  if (typeof value === "number") return items.filter((centre) => centre.id === value);
  const text = value.trim();
  const folded = fold(text);
  const matches = items.filter(
    (centre) =>
      String(centre.id) === text ||
      (centre.number !== undefined && fold(centre.number) === folded) ||
      (centre.name !== undefined && fold(centre.name) === folded),
  );
  if (matches.length <= 1) return matches;
  const exact = matches.filter(
    (centre) => String(centre.id) === text || centre.number === text || centre.name === text,
  );
  return exact.length === 1 ? exact : matches;
}

/**
 * The one cost centre an argument names, read from the account's list. No match or several are
 * refused with a `validation` error before any write: a guessed cost centre would book costs on
 * the wrong one.
 */
export async function resolveCostCentre(
  client: SevdeskClient,
  value: CostCentreArg,
  signal?: AbortSignal,
): Promise<CostCentre> {
  return (await chooseCostCentre(client, value, undefined, signal)).centre;
}

/** A cost centre an update sets, and the one the document stores, from the same list. */
export interface CostCentreChoice {
  readonly centre: CostCentre;
  /** The stored cost centre as listed (`{id}` alone when the list lacks it); none if unset. */
  readonly stored?: CostCentre | undefined;
}

/**
 * {@link resolveCostCentre} for an update: also describes the stored cost centre `storedId` from
 * the same read, so the preview can say what changes.
 */
export async function chooseCostCentre(
  client: SevdeskClient,
  value: CostCentreArg,
  storedId: number | undefined,
  signal?: AbortSignal,
): Promise<CostCentreChoice> {
  const list = await listCostCentres(client, signal);
  const matches = matching(list.items, value);
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    const stored =
      storedId === undefined
        ? undefined
        : (list.items.find((centre) => centre.id === storedId) ?? { id: storedId });
    return { centre: only, stored };
  }
  if (matches.length === 0) {
    throw validation(
      list.truncated
        ? `The account has more than ${COST_CENTRE_LIST_LIMIT.toLocaleString("en-US")} cost ` +
            "centres and none of the first ones has this id, number or name; pass the id of " +
            "one of them."
        : "No cost centre (Kostenstelle) has this id, number or name. " +
            "sevdesk_reference_lookup kind=cost_centres lists them.",
    );
  }
  throw validation(
    "Several cost centres have this number or name (compared ignoring case and accents). Pass " +
      "the id instead; sevdesk_reference_lookup kind=cost_centres lists them.",
  );
}

/** The payload reference of a cost centre. */
export function costCentreRef(id: number): { id: number; objectName: "CostCentre" } {
  return { id, objectName: "CostCentre" };
}

// ---------------------------------------------------------------------------------------------
// Updates: set, remove or keep
// ---------------------------------------------------------------------------------------------

/**
 * The cost-centre arguments of `sevdesk_invoice_update_draft`, `sevdesk_voucher_update_draft` and
 * `sevdesk_credit_note_update_draft`.
 */
export const costCentreUpdateInputShape = {
  costCentre: costCentreValue
    .optional()
    .describe(
      "New Kostenstelle: id, number or name (see sevdesk_reference_lookup kind=cost_centres). " +
        "Leave out to keep the stored one.",
    ),
  removeCostCentre: z
    .boolean()
    .optional()
    .describe("true removes the stored Kostenstelle from the draft. Not together with costCentre."),
};

/**
 * The boolean cost-centre argument of the update tools, for `assertChanges`' `flags`:
 * `removeCostCentre: false` asks for nothing.
 */
export const COST_CENTRE_FLAGS: readonly string[] = ["removeCostCentre"];

/** What an update does with the cost centre. */
export interface CostCentreUpdate {
  /** The cost centre the draft gets; `null` removes the stored one. */
  readonly next: CostCentre | null;
  /**
   * The stored cost centre as listed (`{id}` alone when the list lacks it); none if unset (only
   * when `next` sets one).
   */
  readonly stored?: CostCentre | undefined;
}

/** What {@link costCentreUpdate} needs to know of the stored draft and of the rest of the call. */
export interface CostCentreUpdateContext {
  /** The id of the cost centre the draft stores; `undefined` when it has none. */
  readonly storedId: number | undefined;
  /** The fields the call gives, as `assertChanges` returns them. */
  readonly given: readonly string[];
}

/**
 * The cost-centre change an update asks for, or `undefined` to keep the stored one (no request).
 * `costCentre` is resolved like {@link resolveCostCentre}; `removeCostCentre: true` removes it,
 * which `costCentre: null` does (recorded 2026-11-17, spec/deviations.md D-092). Both together are
 * refused. `removeCostCentre: true` on a draft without a cost centre removes nothing: alone it is
 * refused ("This draft has no cost centre.") before any write, since it would only save the draft
 * unchanged; next to other fields it is left out like `false`.
 */
export async function costCentreUpdate(
  client: SevdeskClient,
  args: {
    readonly costCentre?: CostCentreArg | undefined;
    readonly removeCostCentre?: boolean | undefined;
  },
  context: CostCentreUpdateContext,
  signal?: AbortSignal,
): Promise<CostCentreUpdate | undefined> {
  const { storedId, given } = context;
  const remove = args.removeCostCentre === true;
  if (remove && args.costCentre !== undefined) {
    throw validation("Pass either costCentre (a new one) or removeCostCentre, not both.");
  }
  if (args.costCentre !== undefined) {
    const choice = await chooseCostCentre(client, args.costCentre, storedId, signal);
    return { next: choice.centre, stored: choice.stored };
  }
  if (!remove) return undefined;
  if (storedId === undefined) {
    if (given.every((key) => key === "removeCostCentre")) {
      throw validation("This draft has no cost centre.");
    }
    return undefined;
  }
  return { next: null, stored: await describeCostCentre(client, storedId, signal) };
}

/**
 * The `costCentre` of an update body: the stored reference kept (`undefined` when there is none),
 * the new one, or `null` to remove it.
 */
export function costCentreUpdatePayload(
  update: CostCentreUpdate | undefined,
  storedId: number | undefined,
): { id: number; objectName: "CostCentre" } | null | undefined {
  if (update === undefined) return storedId === undefined ? undefined : costCentreRef(storedId);
  return update.next === null ? null : costCentreRef(update.next.id);
}

/**
 * Before and after of a cost-centre change for a preview's change log; before is `undefined` when
 * the draft had none.
 */
export function costCentreChange(
  update: CostCentreUpdate,
  lang: PreviewLanguage = "en",
): readonly [string | undefined, string] {
  const before = update.stored === undefined ? undefined : costCentreLabel(update.stored, lang);
  if (update.next !== null) return [before, costCentreLabel(update.next, lang)];
  return [before, lang === "de" ? "entfernt" : "removed"];
}

// ---------------------------------------------------------------------------------------------
// The costCentre filter of the invoice and voucher lists
// ---------------------------------------------------------------------------------------------

/** The `costCentre` argument of `sevdesk_invoices_list` and `sevdesk_vouchers_list`. */
export const costCentreFilterInputShape = {
  costCentre: costCentreValue
    .optional()
    .describe(
      "Only documents booked on this Kostenstelle: its id (number), or its number or name " +
        "(text); see sevdesk_reference_lookup kind=cost_centres.",
    ),
};

/**
 * Resolves the list filter like {@link resolveCostCentre}: an unknown or ambiguous cost centre is
 * refused, never answered with the unfiltered list. `undefined` when none was asked for.
 */
export async function resolveCostCentreFilter(
  client: SevdeskClient,
  value: CostCentreArg | undefined,
  signal?: AbortSignal,
): Promise<CostCentre | undefined> {
  return value === undefined ? undefined : resolveCostCentre(client, value, signal);
}

/** The list query of a cost-centre filter: both keys, as recorded (D-092). */
export function costCentreFilterQuery(filter: CostCentre | undefined): Record<string, QueryValue> {
  return filter === undefined
    ? {}
    : { "costCentre[id]": filter.id, "costCentre[objectName]": "CostCentre" };
}

/** Whether a list row passes the filter's re-check: it carries the filter's cost centre. */
export function inCostCentre(
  filter: CostCentre | undefined,
  costCentreId: number | undefined,
): boolean {
  return filter === undefined || costCentreId === filter.id;
}

/** The output field of a list tool with a cost-centre filter; spread next to `pageOutputShape`. */
export const costCentreFilterOutputShape = {
  costCentreFilter: costCentreDtoSchema
    .optional()
    .describe("Only with costCentre: the cost centre the list was filtered by."),
};

/** The {@link costCentreFilterOutputShape} value of a list call. */
export function costCentreFilterOutput(filter: CostCentre | undefined): {
  costCentreFilter?: CostCentre;
} {
  return filter === undefined ? {} : { costCentreFilter: filter };
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
