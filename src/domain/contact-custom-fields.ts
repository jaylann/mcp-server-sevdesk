/**
 * Custom contact fields (Kontaktfelder in the sevDesk web app, where a contact's values are filled
 * in under "Eigene Felder"): reading a contact's values, planning and sending the values
 * `sevdesk_contact_create` and `sevdesk_contact_update` set or remove, the account's field
 * definitions for `sevdesk_reference_lookup`, and the search behind `sevdesk_contacts_search`.
 *
 * sevDesk keeps a custom field in two resources (recorded on a trial account, Update 2.0,
 * 2026-11-16; spec/deviations.md D-086):
 * - a **setting** (`/ContactCustomFieldSetting`: `name` of at most 30 characters, `identifier`,
 *   `description`), the field's definition for the whole account. Two settings may share a name.
 *   Deleting a setting deletes every value of it on every contact, without a 409, so nothing here
 *   ever writes a setting: this module only reads `/ContactCustomFieldSetting`, and fields are
 *   defined in the sevDesk web app.
 * - per contact a **value** (`/ContactCustomField`: `contact`, `contactCustomFieldSetting`,
 *   `value`). No read of a contact shows its values, with any `embed`; they are read with
 *   `GET /ContactCustomField?contact[id]=…&contact[objectName]=Contact&embed=contactCustomFieldSetting`
 *   and checked against the contact id again here (D-035). `POST` answers the new value as one
 *   object, `PUT` with only `objectName` and `value` changes the value and keeps both references,
 *   `DELETE` answers `{objects: [null]}`. A value has at most 100 characters (400 "Property
 *   'value' is too long"), and a contact holds at most one value per setting: a second `POST` for
 *   the same contact and setting is refused with 400 (recorded 2026-11-17). Deleting the contact
 *   deletes its values.
 * - `GET /Contact/Factory/findContactsByCustomFieldValue` with `customFieldSetting[id]` alone
 *   answers the contacts (organisations and persons) whose value of that field equals the value,
 *   ignoring case; a part of the value finds nothing. It ignores `limit` and `offset` and answers
 *   the whole match set (recorded 2026-11-17).
 *
 * Not measured: how the lists of settings and values page.
 *
 * Setting names and values are untrusted text (typed in by users) and go through `cleanText`.
 */
import { z } from "zod";

import type { ConfirmationFact } from "../safety/write-types.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { type CompletedWrite, SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { Page, QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact } from "./common.js";
import { type ContactDto, parseContactRecord, toContactDto } from "./contacts.js";
import { type ChildRows, listChildRows } from "./paging.js";

/** sevDesk refuses longer setting names (400, recorded, D-086). */
export const SETTING_NAME_MAX = 30;
/**
 * sevDesk refuses longer values (400 "Property 'value' is too long. Maximum for this property is
 * 100", recorded 2026-11-17, D-086); the tools refuse them before any request.
 */
export const VALUE_MAX = 100;
/** Settings read for names and ids; an account with more is refused where that matters. */
const SETTINGS_LIMIT = 1000;
/**
 * Matches one custom-field search keeps. sevDesk answers the whole match set at once (it ignores
 * `limit` and `offset`, D-086); a larger answer is cut here and the result says so.
 */
const FIND_LIMIT = 1000;
/** Longest setting description in a lookup. */
const DESCRIPTION_MAX = 500;

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient) and DTOs
// ---------------------------------------------------------------------------------------------

/** `ContactCustomFieldSetting` (recorded: `test/fixtures/recorded/2026-11-16/contacts/`). */
const settingRecordSchema = z.object({
  id: zId,
  name: zText,
  description: zText,
});

/**
 * `ContactCustomField`. `contactCustomFieldSetting` is `{id, objectName}`, or the whole setting
 * with `embed=contactCustomFieldSetting`.
 */
const valueRecordSchema = z.object({
  id: zId,
  contact: zOptionalRef,
  contactCustomFieldSetting: z
    .object({ id: zId, name: zText })
    .nullish()
    .transform((value) => value ?? undefined),
  value: zText,
});

type ValueRecord = z.output<typeof valueRecordSchema>;

/** A custom field the account defines (tool output of `sevdesk_reference_lookup`). */
export const customFieldSettingDtoSchema = z.object({
  id: z.number().int().describe("Setting id: pass it as settingId to the contact tools."),
  name: z.string().describe("The field's name (at most 30 characters in sevDesk)."),
  description: z.string().optional(),
});

export type CustomFieldSetting = z.output<typeof customFieldSettingDtoSchema>;

/** One custom field value of a contact (tool output). */
export const customFieldDtoSchema = z.object({
  id: z
    .number()
    .int()
    .describe("Id of this value; sevdesk_contact_update removes it with remove kind customField."),
  settingId: z.number().int().describe("Id of the field (see sevdesk_reference_lookup)."),
  name: z.string().optional().describe("The field's name, as defined in sevDesk."),
  value: z.string(),
});

type CustomFieldDto = z.output<typeof customFieldDtoSchema>;

function toCustomFieldDto(record: ValueRecord): CustomFieldDto | undefined {
  const setting = record.contactCustomFieldSetting;
  if (setting === undefined) return undefined;
  return compact({
    id: record.id,
    settingId: setting.id,
    name: cleanText(setting.name, SETTING_NAME_MAX * 4),
    value: cleanText(record.value, VALUE_MAX * 2) ?? "",
  });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The account's settings: up to {@link SETTINGS_LIMIT}, `truncated` when sevDesk has more. */
export interface CustomFieldSettings {
  readonly items: readonly CustomFieldSetting[];
  /** sevDesk's `total` when it sent one, else the number of items read. */
  readonly total: number;
  /** True when sevDesk's `total` is larger than what was read, or a full page came without one. */
  readonly truncated: boolean;
}

/**
 * The account's custom fields (`GET /ContactCustomFieldSetting`, one page of
 * {@link SETTINGS_LIMIT}). Only ever a GET: settings are defined in the sevDesk web app.
 */
export async function listCustomFieldSettings(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<CustomFieldSettings> {
  const page = await client.list("/ContactCustomFieldSetting", undefined, {
    limit: SETTINGS_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  });
  const items = page.items.map((raw) => {
    const row = parseUpstream(settingRecordSchema, raw, "custom field settings");
    return compact({
      id: row.id,
      name: cleanText(row.name, SETTING_NAME_MAX * 4) ?? `(unnamed field ${String(row.id)})`,
      description: cleanText(row.description, DESCRIPTION_MAX),
    });
  });
  // A full page without sevDesk's `total` may be cut as well (like the cost centres).
  const truncated =
    page.total === undefined ? items.length >= SETTINGS_LIMIT : page.total > items.length;
  return { items, total: page.total ?? items.length, truncated };
}

/** A contact's custom field values, as read. */
export interface ContactCustomFields extends ChildRows<CustomFieldDto> {
  /**
   * Each value of `rows` as sevDesk stores it, by value id. `rows` hold the display copy
   * (`cleanText`: trimmed, invisible and bidi characters removed), so whether an update changes a
   * value is decided against this text: a stored "EXT-4711 " is changed to "EXT-4711". Never
   * output.
   */
  readonly storedValues: ReadonlyMap<number, string>;
}

/**
 * The custom field values of one contact, with the setting's name (see the module comment). Rows
 * of other contacts, should sevDesk ignore the filter, and rows without a setting are left out.
 */
export async function readContactCustomFields(
  client: SevdeskClient,
  contactId: number,
  signal: AbortSignal | undefined,
): Promise<ContactCustomFields> {
  const id = toSevdeskId(contactId);
  const rows = await listChildRows(
    client,
    "/ContactCustomField",
    { "contact[id]": id, "contact[objectName]": "Contact", embed: "contactCustomFieldSetting" },
    {
      parse: (raw) => parseUpstream(valueRecordSchema, raw, "custom field values"),
      belongs: (row) => row.contact?.id === id,
    },
    signal,
  );
  return {
    rows: rows.rows
      .map(toCustomFieldDto)
      .filter((row): row is CustomFieldDto => row !== undefined)
      .sort((a, b) => a.id - b.id),
    complete: rows.complete,
    storedValues: new Map(rows.rows.map((row) => [row.id, row.value ?? ""])),
  };
}

/** {@link readContactCustomFields} for a display, where a failed read must not fail the call. */
export type DisplayedCustomFields =
  ({ readonly readable: true } & ContactCustomFields) | { readonly readable: false };

/**
 * {@link readContactCustomFields}, but a sevDesk failure (other than a cancellation) becomes
 * `readable: false` instead of an error: `sevdesk_contact_get` and the delete preview still show
 * the contact, and say that its custom fields could not be read.
 */
export async function readCustomFieldsForDisplay(
  client: SevdeskClient,
  contactId: number,
  signal: AbortSignal | undefined,
): Promise<DisplayedCustomFields> {
  try {
    return { readable: true, ...(await readContactCustomFields(client, contactId, signal)) };
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return { readable: false };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Which setting an argument names
// ---------------------------------------------------------------------------------------------

/** A custom field named by an argument: its setting id or its name, never both. */
export interface CustomFieldRef {
  readonly settingId?: number | undefined;
  readonly name?: string | undefined;
}

/**
 * The setting `ref` names, checked against the account's settings: an id must be one of them; a
 * name must match exactly one (compared ignoring case and spacing), since sevDesk allows two
 * settings with one name. Throws a `validation` SevdeskError before anything is sent otherwise;
 * the messages name ids only, never sevDesk's text. `where` names the argument, e.g.
 * "customFields entry 2".
 */
export function resolveSetting(
  settings: CustomFieldSettings,
  ref: CustomFieldRef,
  where: string,
): CustomFieldSetting {
  if ((ref.settingId === undefined) === (ref.name === undefined)) {
    throw validation(
      `${where}: give the field either by settingId or by name, not both and not neither. ` +
        "sevdesk_reference_lookup kind=contact_custom_fields lists them.",
    );
  }
  if (ref.settingId !== undefined) {
    const setting = settings.items.find((item) => item.id === ref.settingId);
    if (setting !== undefined) return setting;
    throw validation(
      `${where}: custom field ${String(ref.settingId)} is not one of this account's custom ` +
        `fields${settings.truncated ? " that could be read (sevDesk has more than could be read)" : ""}. ` +
        "sevdesk_reference_lookup kind=contact_custom_fields lists them; fields are defined in " +
        "the sevDesk web app.",
    );
  }
  const wanted = normalizeName(ref.name ?? "");
  const matches = settings.items.filter((item) => normalizeName(item.name) === wanted);
  if (settings.truncated) {
    throw validation(
      `${where}: the account has more custom fields than could be read, so a name cannot be ` +
        "matched safely. Give the field by settingId (sevdesk_reference_lookup " +
        "kind=contact_custom_fields).",
    );
  }
  const [only, ...others] = matches;
  if (only === undefined) {
    throw validation(
      `${where}: no custom field of this account has that name. sevdesk_reference_lookup ` +
        "kind=contact_custom_fields lists them; fields are defined in the sevDesk web app.",
    );
  }
  if (others.length > 0) {
    throw validation(
      `${where}: ${String(matches.length)} custom fields have that name (settings ` +
        `${matches.map((item) => String(item.id)).join(", ")}). Give the one you mean by settingId.`,
    );
  }
  return only;
}

/** Case- and whitespace-insensitive form of a setting name. */
function normalizeName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

// ---------------------------------------------------------------------------------------------
// Writes: plan
// ---------------------------------------------------------------------------------------------

/** One custom field value a create or update sets. */
export interface CustomFieldInput extends CustomFieldRef {
  readonly value: string;
}

/** A value to send: a new one (`POST`) or a change of an existing one (`PUT`). */
export type CustomFieldWrite =
  | { readonly kind: "create"; readonly settingId: number; readonly value: string }
  | { readonly kind: "update"; readonly id: number; readonly value: string };

/** A value an update deletes, as it was read. */
export interface CustomFieldRemoval {
  readonly id: number;
  readonly field: CustomFieldDto;
}

/** Where planned values go: a new contact, or an existing contact whose values were read. */
export type CustomFieldTarget =
  | { readonly kind: "create" }
  | {
      readonly kind: "update";
      readonly contactId: number;
      readonly current: ContactCustomFields;
      /** Values the same update removes; their fields cannot be set in the same update. */
      readonly removedIds: ReadonlySet<number>;
    };

/** What the values of a create or update add to its plan and preview. */
export interface CustomFieldValuesPlan {
  readonly writes: readonly CustomFieldWrite[];
  /** One fact per value set or changed, in the order of the entries. */
  readonly facts: readonly ConfirmationFact[];
  /** For the update's action sentence, e.g. "custom field 19498". */
  readonly changes: readonly string[];
}

/**
 * Plans the custom field values of a create or update before anything is sent. Every entry names
 * one setting of the account ({@link resolveSetting}), and none twice. On a create every value is
 * new. On an update the contact's value of that setting is changed when it differs (left alone
 * when equal), and a value is added when the contact has none. sevDesk keeps one value per
 * setting and contact (a second `POST` is refused, D-086), so setting a field whose value the same
 * update removes is refused: the new value would be added before the old one is deleted. An added
 * value is refused too when not every value of the contact could be read, and a value longer than
 * {@link VALUE_MAX}.
 */
export function planCustomFieldValues(
  entries: readonly CustomFieldInput[],
  settings: CustomFieldSettings,
  target: CustomFieldTarget,
): CustomFieldValuesPlan {
  const seen = new Set<number>();
  const writes: CustomFieldWrite[] = [];
  const facts: ConfirmationFact[] = [];
  const changes: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const where = `customFields entry ${String(index + 1)}`;
    const setting = resolveSetting(settings, entry, where);
    if (seen.has(setting.id)) {
      throw validation(
        `${where}: custom field ${String(setting.id)} is listed twice; give each field once.`,
      );
    }
    seen.add(setting.id);
    if (entry.value.length > VALUE_MAX) {
      throw validation(
        `${where}: the value has ${String(entry.value.length)} characters; sevDesk takes at most ` +
          `${String(VALUE_MAX)}.`,
      );
    }
    const shown = cleanText(entry.value, VALUE_MAX) ?? "";
    const label = `Custom field (setting ${String(setting.id)})`;
    if (target.kind === "create") {
      writes.push({ kind: "create", settingId: setting.id, value: entry.value });
      facts.push({ label, value: `${setting.name}: ${shown}` });
      continue;
    }
    const contact = String(target.contactId);
    const removedHere = target.current.rows.find(
      (row) => row.settingId === setting.id && target.removedIds.has(row.id),
    );
    if (removedHere !== undefined) {
      throw validation(
        `${where}: remove also lists value ${String(removedHere.id)} of custom field ` +
          `${String(setting.id)}. sevDesk keeps one value per field and contact, so give the new ` +
          "value without removing the old one: it is changed in place. Nothing was changed.",
      );
    }
    const existing = target.current.rows.filter((row) => row.settingId === setting.id);
    const [value, ...more] = existing;
    // Defensive: sevDesk refused a second value of one setting when measured (D-086), so a
    // contact should never have two; if one does, which to change cannot be known.
    if (more.length > 0) {
      throw validation(
        `${where}: contact ${contact} has ${String(existing.length)} values of custom field ` +
          `${String(setting.id)} (ids ${existing.map((row) => String(row.id)).join(", ")}), so ` +
          "which one to change is unclear; nothing was changed. Remove the extra ones with " +
          "remove kind customField first.",
      );
    }
    if (value === undefined) {
      if (!target.current.complete) {
        throw validation(
          `${where}: contact ${contact} has more custom field values than could be read, so ` +
            "whether it has this field already is unknown; nothing was changed.",
        );
      }
      writes.push({ kind: "create", settingId: setting.id, value: entry.value });
      facts.push({ label: `${label} (new)`, value: `${setting.name}: ${shown}` });
    } else {
      // Against the stored text, not the cleaned display copy: a stored value with outer spaces
      // or invisible characters is changed, not skipped as equal.
      if ((target.current.storedValues.get(value.id) ?? value.value) === entry.value) continue;
      writes.push({ kind: "update", id: value.id, value: entry.value });
      const before =
        value.value === shown
          ? `${shownValue(value.value)} (stored with extra spaces or invisible characters)`
          : shownValue(value.value);
      facts.push({
        label: `${label}, value id ${String(value.id)}`,
        value: `${setting.name}: ${before} → ${shown}`,
      });
    }
    changes.push(`custom field ${String(setting.id)}`);
  }
  return { writes, facts, changes };
}

/**
 * Checks the custom field values `remove` names against the contact's values as read: each must be
 * one of them, none listed twice. Throws a `validation` SevdeskError (ids only) before anything is
 * sent otherwise.
 */
export function planCustomFieldRemovals(
  ids: readonly number[],
  current: ContactCustomFields,
  contactId: number,
): CustomFieldRemoval[] {
  const seen = new Set<number>();
  return ids.map((id) => {
    if (seen.has(id)) {
      throw validation(
        `remove lists custom field value ${String(id)} twice; list each entry once.`,
      );
    }
    seen.add(id);
    const field = current.rows.find((row) => row.id === id);
    if (field === undefined) {
      const partial = current.complete
        ? ""
        : " that could be read (sevDesk may hold more than could be read for certain)";
      throw validation(
        `Custom field value ${String(id)} is not one of contact ${String(contactId)}'s custom ` +
          `field values${partial}; nothing was changed. sevdesk_contact_get lists them with ` +
          "their ids.",
      );
    }
    return { id, field };
  });
}

/** The preview fact of one removed value: field name and value as read, so it can be re-entered. */
export function customFieldRemovalFact(removal: CustomFieldRemoval): ConfirmationFact {
  const { field } = removal;
  return {
    label: `Remove custom field value (id ${String(removal.id)})`,
    value: `${field.name ?? `field ${String(field.settingId)}`}: ${shownValue(field.value)}`,
  };
}

function shownValue(value: string): string {
  return value === "" ? "(empty)" : value;
}

// ---------------------------------------------------------------------------------------------
// Writes: send
// ---------------------------------------------------------------------------------------------

function refSchema<N extends string>(objectName: N) {
  return z.strictObject({ id: z.number().int().positive(), objectName: z.literal(objectName) });
}

/** `POST /ContactCustomField` (strict: sevDesk ignores unknown fields, D-003). */
const valueCreatePayloadSchema = z.strictObject({
  objectName: z.literal("ContactCustomField"),
  contact: refSchema("Contact"),
  contactCustomFieldSetting: refSchema("ContactCustomFieldSetting"),
  value: z.string().min(1),
});

/** `PUT /ContactCustomField/{id}`: only the value; both references stay (D-086). */
const valueUpdatePayloadSchema = z.strictObject({
  objectName: z.literal("ContactCustomField"),
  value: z.string().min(1),
});

/**
 * Sends the planned values in order, each once, and records each in `completed` (the caller
 * reports them when a later step fails). Never retries.
 */
export async function executeCustomFieldWrites(
  client: SevdeskClient,
  contactId: number,
  writes: readonly CustomFieldWrite[],
  completed: CompletedWrite[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const withSignal = signal === undefined ? {} : { signal };
  for (const write of writes) {
    if (write.kind === "update") {
      await client.request({
        method: "PUT",
        path: sevdeskPath("ContactCustomField", write.id),
        body: valueUpdatePayloadSchema.parse({
          objectName: "ContactCustomField",
          value: write.value,
        }),
        ...withSignal,
      });
      completed.push({ objectName: "ContactCustomField", id: String(write.id) });
      continue;
    }
    const answer = await client.request({
      method: "POST",
      path: "/ContactCustomField",
      body: valueCreatePayloadSchema.parse({
        objectName: "ContactCustomField",
        contact: { id: contactId, objectName: "Contact" },
        contactCustomFieldSetting: { id: write.settingId, objectName: "ContactCustomFieldSetting" },
        value: write.value,
      }),
      ...withSignal,
    });
    const created = parseUpstream(
      z.object({ id: zId }),
      expectSingle(answer, "created custom field value"),
      "the created custom field value",
    );
    completed.push({ objectName: "ContactCustomField", id: String(created.id) });
  }
}

/** A custom field value `remove` took off, and whether sevDesk had it still. */
export interface RemovedCustomField {
  readonly removal: CustomFieldRemoval;
  /** True when the DELETE answered 404: the value was gone already. */
  readonly alreadyGone: boolean;
}

/**
 * Deletes the planned values one by one, in order, after every other change, and records each in
 * `completed`. A 404 means the value is gone already and is reported, not raised.
 */
export async function executeCustomFieldRemovals(
  client: SevdeskClient,
  removals: readonly CustomFieldRemoval[],
  completed: CompletedWrite[],
  signal: AbortSignal | undefined,
): Promise<RemovedCustomField[]> {
  const removed: RemovedCustomField[] = [];
  for (const removal of removals) {
    let alreadyGone = false;
    try {
      await client.request({
        method: "DELETE",
        path: sevdeskPath("ContactCustomField", removal.id),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (!(error instanceof SevdeskError && error.kind === "not_found")) throw error;
      alreadyGone = true;
    }
    completed.push({ objectName: "ContactCustomField", id: String(removal.id) });
    removed.push({ removal, alreadyGone });
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** Just the id of a found contact, read for every match before the cut. */
const matchIdSchema = z.object({ id: zId });

/** The contacts one custom-field search found. */
export interface CustomFieldMatches {
  readonly items: readonly ContactDto[];
  /** True when the answer was cut to {@link FIND_LIMIT} matches, or sevDesk reported more. */
  readonly truncated: boolean;
}

/**
 * The contacts (organisations and persons) whose value of `settingId` equals `value`, ignoring
 * case (`GET /Contact/Factory/findContactsByCustomFieldValue` with `customFieldSetting[id]` alone,
 * D-086), de-duplicated by id, sorted by id, and cut to the {@link FIND_LIMIT} lowest ids. sevDesk
 * ignores `limit` and `offset` here and answers every match at once, so the endpoint is read
 * exactly once (the client still sends the explicit `limit` every list request carries) and the
 * caller pages locally. Only the id of every match is read; the contacts kept are parsed and built
 * for output, so a value thousands of contacts share costs no more than {@link FIND_LIMIT} rows.
 * A match set too large for the client's answer cap fails with advice that fits this search (a
 * more specific value), not the client's generic one (a smaller limit, a shorter date range).
 */
export async function findContactsByCustomField(
  client: SevdeskClient,
  settingId: number,
  value: string,
  signal?: AbortSignal,
): Promise<CustomFieldMatches> {
  const path = "/Contact/Factory/findContactsByCustomFieldValue";
  const query: Record<string, QueryValue> = {
    value,
    "customFieldSetting[id]": toSevdeskId(settingId),
    "customFieldSetting[objectName]": "ContactCustomFieldSetting",
  };
  let page: Page;
  try {
    page = await client.list(path, query, {
      limit: FIND_LIMIT,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (!isAnswerCap(error)) throw error;
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk answers every contact with this custom field value at once, and that answer " +
        "is larger than this server reads from one answer, so it was not read. A smaller limit " +
        "or offset does not help here (sevDesk ignores both for this search); give a more " +
        "specific value.",
      method: "GET",
      path,
      expectedLimit: true,
      cause: error,
    });
  }
  // First match of each id, by its raw id alone; the full parse waits until the cut is known.
  const firstById = new Map<number, unknown>();
  for (const raw of page.items) {
    const { id } = parseUpstream(matchIdSchema, raw, "contacts found by custom field");
    if (!firstById.has(id)) firstById.set(id, raw);
  }
  const ids = [...firstById.keys()].sort((a, b) => a - b);
  const kept = ids.slice(0, FIND_LIMIT);
  const truncated =
    ids.length > kept.length || (page.total !== undefined && page.total > page.items.length);
  return {
    items: kept.map((id) => toContactDto(parseContactRecord(firstById.get(id)))),
    truncated,
  };
}

/**
 * The client's error for a 2xx answer over its size cap: `unexpected_response` without status,
 * with `expectedLimit` (the only such error the client raises).
 */
function isAnswerCap(error: unknown): boolean {
  return (
    error instanceof SevdeskError &&
    error.kind === "unexpected_response" &&
    error.status === undefined &&
    error.expectedLimit
  );
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
