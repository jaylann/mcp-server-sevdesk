/**
 * Contacts (Kontakte): lenient parsing of sevDesk's `Contact`, `ContactAddress` and
 * `CommunicationWay` records, the compact DTOs tools return, and the read operations behind the
 * contact tools.
 *
 * sevDesk has no "type" attribute: a contact is an organisation when `name` is set and a person
 * otherwise (`surename` = first name, sic, and `familyname`). Source: spec tag `Contact` → "Types
 * of contacts" and `Model_ContactResponse.name`. `GET /Contact` returns organisations only unless
 * `depth=1` is sent (spec, `getContacts` parameter `depth`).
 *
 * All text from sevDesk is untrusted (contact data is typed in by users or imported from third
 * parties) and goes through {@link sanitizeUntrusted}.
 */
import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { toBerlinDate } from "../sevdesk/dates.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zBool01, zId, zRef } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import {
  addressCategoryById,
  communicationWayKeyById,
  CONTACT_CATEGORY_KEYS,
  contactCategoryById,
} from "./reference-data.js";

const NAME_MAX = 300;
const FIELD_MAX = 200;
const VALUE_MAX = 500;
/** sevDesk's maximum page size, used for addresses and communication ways. */
const DETAIL_PAGE_SIZE = 1000;
/**
 * Cap when addresses or communication ways have to be read page by page (more than one page, or
 * sevDesk ignored the `contact[id]` filter and the account's rows are filtered here).
 */
const DETAIL_MAX_ROWS = 10_000;

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient)
// ---------------------------------------------------------------------------------------------

/** Free text that sevDesk may send as string, number or `null`; `null`/"" become `undefined`. */
const zText = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) =>
    value === null || value === undefined || value === "" ? undefined : String(value),
  );

const zOptionalRef = zRef()
  .nullish()
  .transform((value) => value ?? undefined);

/** `Contact` as returned by `GET /Contact` and `GET /Contact/{id}` (fields the DTO needs). */
const contactRecordSchema = z.object({
  id: zId,
  create: z.unknown().optional(),
  update: z.unknown().optional(),
  name: zText,
  surename: zText,
  familyname: zText,
  name2: zText,
  academicTitle: zText,
  customerNumber: zText,
  parent: zOptionalRef,
  category: zOptionalRef,
  vatNumber: zText,
  taxNumber: zText,
  buyerReference: zText,
  governmentAgency: zBool01.optional(),
});

export type ContactRecord = z.output<typeof contactRecordSchema>;

/** `ContactAddress` (spec `Model_ContactAddressResponse`). */
const addressRecordSchema = z.object({
  id: zId,
  contact: zOptionalRef,
  street: zText,
  zip: zText,
  city: zText,
  country: zOptionalRef,
  category: zOptionalRef,
  name: zText,
  name2: zText,
  name3: zText,
  name4: zText,
});

/** `CommunicationWay` (spec `Model_CommunicationWayResponse`). */
const communicationWayRecordSchema = z.object({
  id: zId,
  contact: zOptionalRef,
  type: zText,
  value: zText,
  key: zOptionalRef,
  main: zBool01.optional(),
});

// ---------------------------------------------------------------------------------------------
// DTOs (also the tools' output schemas)
// ---------------------------------------------------------------------------------------------

const CONTACT_KINDS = ["organisation", "person"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

const categoryRefSchema = z.object({
  id: z.number().int(),
  key: z.enum(CONTACT_CATEGORY_KEYS).optional().describe("Standard category key, if standard."),
  name: z.string().optional().describe("German name in sevDesk, e.g. Kunde, Lieferant."),
});

/** Compact contact. */
export const contactDtoSchema = z.object({
  id: z.number().int(),
  kind: z.enum(CONTACT_KINDS),
  displayName: z.string().describe("Organisation name, or the person's full name."),
  customerNumber: z.string().optional().describe("Kundennummer."),
  category: categoryRefSchema.optional(),
  parentOrganisationId: z
    .number()
    .int()
    .optional()
    .describe("For persons: the organisation contact they belong to."),
  vatNumber: z.string().optional().describe("USt-IdNr."),
  taxNumber: z.string().optional().describe("Steuernummer."),
  buyerReference: z.string().optional().describe("Leitweg-ID / buyer reference for e-invoices."),
  governmentAgency: z.boolean().optional().describe("Public authority (Behörde)."),
  createdAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
  updatedAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
});

export type ContactDto = z.output<typeof contactDtoSchema>;

const keyRefSchema = z.object({
  id: z.number().int(),
  name: z.string().optional(),
});

/** Compact contact address. */
export const addressDtoSchema = z.object({
  id: z.number().int(),
  recipient: z.string().optional().describe("Name lines of the address, one per line."),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  countryId: z
    .number()
    .int()
    .optional()
    .describe("StaticCountry id; names via sevdesk_reference_lookup kind=countries."),
  category: keyRefSchema.optional().describe("Address type, e.g. Rechnungsanschrift."),
});

type AddressDto = z.output<typeof addressDtoSchema>;

/** Compact communication way (email, phone, website). */
export const communicationWayDtoSchema = z.object({
  id: z.number().int(),
  type: z.string().describe("EMAIL, PHONE, WEB or MOBILE."),
  value: z.string(),
  key: keyRefSchema.optional().describe("Purpose, e.g. Arbeit, Privat, Rechnungsadresse."),
  main: z.boolean(),
});

type CommunicationWayDto = z.output<typeof communicationWayDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** Parses one upstream contact; throws an `unexpected_response` error if it does not fit. */
export function parseContactRecord(raw: unknown): ContactRecord {
  return parseUpstream(contactRecordSchema, raw, "a contact");
}

/** Organisation when `name` is set, person otherwise (sevDesk's own rule). */
export function contactKind(record: ContactRecord): ContactKind {
  return present(record.name) === undefined ? "person" : "organisation";
}

/** Maps a parsed contact to the compact DTO. */
export function toContactDto(record: ContactRecord): ContactDto {
  const kind = contactKind(record);
  const nameParts =
    kind === "organisation"
      ? [record.name]
      : [record.academicTitle, record.surename, record.name2, record.familyname];
  const displayName = joinPresent(nameParts, " ") ?? `(unnamed contact ${record.id})`;
  const category =
    record.category === undefined ? undefined : contactCategoryById(record.category.id);

  return compact({
    id: record.id,
    kind,
    displayName: sanitizeUntrusted(displayName, NAME_MAX),
    customerNumber: cleanText(record.customerNumber),
    category:
      record.category === undefined
        ? undefined
        : category === undefined
          ? { id: record.category.id }
          : { id: category.id, key: category.key, name: category.name },
    parentOrganisationId: record.parent?.id,
    vatNumber: cleanText(record.vatNumber),
    taxNumber: cleanText(record.taxNumber),
    buyerReference: cleanText(record.buyerReference),
    governmentAgency: record.governmentAgency,
    createdAt: berlinDate(record.create),
    updatedAt: berlinDate(record.update),
  });
}

function toAddressDto(record: z.output<typeof addressRecordSchema>): AddressDto {
  const recipient = joinPresent([record.name, record.name2, record.name3, record.name4], "\n");
  return compact({
    id: record.id,
    recipient: recipient === undefined ? undefined : sanitizeUntrusted(recipient, VALUE_MAX),
    street: cleanText(record.street),
    zip: cleanText(record.zip),
    city: cleanText(record.city),
    countryId: record.country?.id,
    category:
      record.category === undefined ? undefined : namedRef(record.category.id, addressCategoryById),
  });
}

function toCommunicationWayDto(
  record: z.output<typeof communicationWayRecordSchema>,
): CommunicationWayDto {
  return compact({
    id: record.id,
    type: sanitizeUntrusted(present(record.type) ?? "UNKNOWN", 20),
    value: sanitizeUntrusted(present(record.value) ?? "", VALUE_MAX),
    key: record.key === undefined ? undefined : namedRef(record.key.id, communicationWayKeyById),
    main: record.main ?? false,
  });
}

/** `{ id, name }` with the name from static reference data; no name for unknown or blank ones. */
function namedRef(
  id: number,
  lookup: (id: number) => { readonly name: string } | undefined,
): { id: number; name?: string } {
  const name = lookup(id)?.name;
  return name === undefined || name === "" ? { id } : { id, name };
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export interface ContactSearchParams {
  /** Matched by sevDesk against the organisation name, first name and last name. */
  readonly query?: string | undefined;
  readonly customerNumber?: string | undefined;
  readonly categoryId?: number | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ContactSearchResult {
  readonly items: readonly ContactDto[];
  /** Rows sevDesk returned for this page, before de-duplication. */
  readonly received: number;
  /** Matches in sevDesk (`countAll`), when sevDesk reported it. */
  readonly total: number | undefined;
  /**
   * Whether the next page may hold more matches. sevDesk can return a short page in the middle
   * of a collection, so without a `total` only an empty page proves the end.
   */
  readonly hasMore: boolean;
  /** Offset of the next page: this offset plus the rows received (not plus the limit). */
  readonly nextOffset: number;
}

/**
 * Searches organisations and persons (`GET /Contact` with `depth=1`, without which sevDesk returns
 * organisations only). Filters are sevDesk's: `name`, `customerNumber`, `category[id]`. Results are
 * de-duplicated by id.
 */
export async function searchContacts(
  client: SevdeskClient,
  params: ContactSearchParams,
  signal?: AbortSignal,
): Promise<ContactSearchResult> {
  const query: Record<string, QueryValue> = { depth: "1" };
  if (params.query !== undefined) query["name"] = params.query;
  if (params.customerNumber !== undefined) query["customerNumber"] = params.customerNumber;
  if (params.categoryId !== undefined) {
    query["category[id]"] = params.categoryId;
    query["category[objectName]"] = "Category";
  }

  const page = await client.list("/Contact", query, {
    limit: params.limit,
    offset: params.offset,
    ...(signal === undefined ? {} : { signal }),
  });

  const seen = new Set<number>();
  const items: ContactDto[] = [];
  for (const raw of page.items) {
    const record = parseContactRecord(raw);
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    items.push(toContactDto(record));
  }

  const received = page.items.length;
  const nextOffset = params.offset + received;
  const hasMore = received > 0 && (page.total === undefined || nextOffset < page.total);
  return { items, received, total: page.total, hasMore, nextOffset };
}

export interface ContactDetails {
  readonly contact: ContactDto;
  readonly addresses: readonly AddressDto[];
  /** False when sevDesk had more address rows than could be read; `addresses` is then partial. */
  readonly addressesComplete: boolean;
  readonly communicationWays: readonly CommunicationWayDto[];
  /** False when sevDesk had more rows than could be read; `communicationWays` is then partial. */
  readonly communicationWaysComplete: boolean;
}

/**
 * One contact with its addresses and communication ways. A missing contact surfaces as the
 * client's `not_found` error. See {@link listContactRows} for how addresses and communication
 * ways are read without leaking or silently dropping rows.
 */
export async function getContactDetails(
  client: SevdeskClient,
  contactId: number,
  signal?: AbortSignal,
): Promise<ContactDetails> {
  const id = toSevdeskId(contactId);
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Contact", id),
    ...(signal === undefined ? {} : { signal }),
  });
  const contact = toContactDto(parseContactRecord(expectSingle(payload, `contact ${id}`)));

  const [addresses, communicationWays] = await Promise.all([
    listContactRows(
      client,
      "/ContactAddress",
      id,
      (raw) => parseUpstream(addressRecordSchema, raw, "contact addresses"),
      signal,
    ),
    listContactRows(
      client,
      "/CommunicationWay",
      id,
      (raw) => parseUpstream(communicationWayRecordSchema, raw, "communication ways"),
      signal,
    ),
  ]);

  return {
    contact,
    addresses: addresses.rows.map(toAddressDto),
    addressesComplete: addresses.complete,
    communicationWays: communicationWays.rows.map(toCommunicationWayDto),
    communicationWaysComplete: communicationWays.complete,
  };
}

interface ContactRows<T> {
  readonly rows: readonly T[];
  /** False when the cap stopped reading before the end. */
  readonly complete: boolean;
}

/**
 * Reads the rows of one contact from a collection that takes sevDesk's `contact[id]` filter
 * (undocumented for `GET /ContactAddress`, see spec/deviations.md D-032).
 *
 * Rows are always filtered by `contact.id` here as well, so an ignored filter cannot leak other
 * contacts' data. One page suffices when every row belongs to the contact and sevDesk's `total`
 * shows nothing is left (or the page is empty). Otherwise, when the total exceeds the page or the
 * filter was evidently ignored, the collection is read page by page up to
 * {@link DETAIL_MAX_ROWS} rows and filtered locally; hitting that cap is reported as incomplete
 * rather than returning a silently short list.
 */
async function listContactRows<
  T extends { readonly contact?: { readonly id: number } | undefined },
>(
  client: SevdeskClient,
  path: string,
  contactId: number,
  parse: (raw: unknown) => T,
  signal: AbortSignal | undefined,
): Promise<ContactRows<T>> {
  const filter = { "contact[id]": contactId, "contact[objectName]": "Contact" };
  const withSignal = signal === undefined ? {} : { signal };
  const belongs = (row: T): boolean => row.contact?.id === contactId;

  const page = await client.list(path, filter, { limit: DETAIL_PAGE_SIZE, ...withSignal });
  const first = page.items.map(parse);
  const received = page.items.length;
  const filterHonoured = first.every(belongs);
  const nothingLeft = received === 0 || (page.total !== undefined && page.total <= received);
  if (filterHonoured && nothingLeft) {
    return { rows: first, complete: true };
  }

  const all = await client.listAll(path, filter, {
    max: DETAIL_MAX_ROWS,
    pageSize: DETAIL_PAGE_SIZE,
    ...withSignal,
  });
  return { rows: all.items.map(parse).filter(belongs), complete: !all.truncated };
}

/**
 * The next free customer number (Kundennummer) from the account's number range
 * (`GET /Contact/Factory/getNextCustomerNumber`). Reading it does not reserve it.
 */
export async function getNextCustomerNumber(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await client.request({
    method: "GET",
    path: "/Contact/Factory/getNextCustomerNumber",
    ...(signal === undefined ? {} : { signal }),
  });
  const value = typeof payload === "number" ? String(payload) : payload;
  if (typeof value !== "string" || value.trim() === "") {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "sevDesk returned the next customer number in an unexpected format.",
    });
  }
  return sanitizeUntrusted(value.trim(), FIELD_MAX);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function joinPresent(
  parts: readonly (string | undefined)[],
  separator: string,
): string | undefined {
  const kept = parts.map(present).filter((part): part is string => part !== undefined);
  return kept.length === 0 ? undefined : kept.join(separator);
}

/** Trimmed, sanitized text, or `undefined` when empty. */
function cleanText(value: string | undefined): string | undefined {
  const text = present(value);
  return text === undefined ? undefined : sanitizeUntrusted(text, FIELD_MAX);
}

/** Drops `undefined` members, so absent fields are left out of the JSON instead of set to null. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

/** Calendar date of a sevDesk timestamp; an unreadable timestamp is left out, not fatal. */
function berlinDate(value: unknown): string | undefined {
  try {
    return toBerlinDate(value);
  } catch {
    return undefined;
  }
}
