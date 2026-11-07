/**
 * Who a draft is addressed to and who is responsible for it: the contact (must exist), the
 * printed recipient address (the contact's invoice address or the stored one, with the call's
 * address fields merged over it part by part) with its `StaticCountry`, and the contact person
 * (`contactPerson`, a `SevUser`; B3).
 *
 * Address. sevDesk does not copy the contact's address onto a document created through the API
 * (reported by jernoxit/sevdesk-rs from its live tests, 2026-10), so drafts always carry one.
 * The contact has no "main" flag on its addresses; the address with category 47
 * (Rechnungsanschrift) wins, else the first one sevDesk lists, which is also what
 * `takeDefaultAddress` would take (spec: "the first address of the contact"). sevDesk documents no "archived" state for contacts, so only existence
 * is checked.
 *
 * Contact person (B3). Every SDK sends `contactPerson`; with one user it is that user, with
 * several the caller must choose (`contactPersonId`), because picking the first user silently
 * would put the wrong name on the document.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { type ContactDetails, getContactDetails } from "../contacts.js";
import { type Country, listCountries } from "../reference-data.js";
import { listUsers } from "../users.js";

/** Address category 47, Rechnungsanschrift (recorded `GET /Category`, objectType ContactAddress). */
const INVOICE_ADDRESS_CATEGORY_ID = 47;
/** ISO code sevDesk uses for Germany in `StaticCountry.code` (lower case, recorded). */
const GERMANY = "de";

const MAX_LINE = 250;

/** Address fields of the draft tools; spread into a tool input. */
export const addressInputShape = {
  addressName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_LINE)
    .optional()
    .describe(
      "Recipient name as printed. Address fields replace the matching parts of the contact's " +
        "invoice address (new drafts) or of the stored address (updates); the rest is kept.",
    ),
  addressStreet: z.string().trim().min(1).max(MAX_LINE).optional().describe("Street and number."),
  addressZip: z.string().trim().min(1).max(20).optional().describe("Postcode (PLZ)."),
  addressCity: z.string().trim().min(1).max(100).optional().describe("City (Ort)."),
  addressCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "expected a two-letter ISO country code such as DE")
    .optional()
    .describe(
      "ISO 3166-1 alpha-2 country code of the address, e.g. DE, AT, CH; default: the country " +
        "of the address it changes, else DE.",
    ),
};

export interface AddressInput {
  readonly addressName?: string | undefined;
  readonly addressStreet?: string | undefined;
  readonly addressZip?: string | undefined;
  readonly addressCity?: string | undefined;
  readonly addressCountry?: string | undefined;
}

/** The recipient address printed on a document. Texts are sanitized or caller-supplied. */
export interface DocumentAddress {
  readonly name: string;
  readonly street?: string | undefined;
  readonly zip?: string | undefined;
  readonly city?: string | undefined;
  readonly countryId: number;
  /** Lower-case ISO code, when sevDesk's country list has it. */
  readonly countryCode?: string | undefined;
  readonly countryName?: string | undefined;
}

/** Whether the call gives any address field, the country included. */
export function hasAddressInput(input: AddressInput): boolean {
  return [
    input.addressName,
    input.addressStreet,
    input.addressZip,
    input.addressCity,
    input.addressCountry,
  ].some((value) => value !== undefined);
}

/**
 * The contact with its addresses. A contact that does not exist is a `validation` error that says
 * how to find the right one (sevDesk's `not_found` is turned into it).
 */
export async function loadContact(
  client: SevdeskClient,
  contactId: number,
  signal?: AbortSignal,
): Promise<ContactDetails> {
  try {
    return await getContactDetails(client, contactId, signal);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw new SevdeskError({
        kind: "validation",
        message:
          `Contact ${contactId} does not exist in sevDesk. Find the customer's id with ` +
          "sevdesk_contacts_search (or create the contact first).",
      });
    }
    throw error;
  }
}

/** The countries sevDesk knows (`GET /StaticCountry`), for codes, ids and names. */
export async function loadCountries(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<readonly Country[]> {
  return (await listCountries(client, signal)).items;
}

/** The structured parts of an address, before its country is resolved. */
interface AddressParts {
  readonly name?: string | undefined;
  readonly street?: string | undefined;
  readonly zip?: string | undefined;
  readonly city?: string | undefined;
  readonly countryId?: number | undefined;
}

/**
 * What the address fields of a call are merged onto:
 * - `parts`: a structured address (the contact's invoice address, or a draft's stored fields);
 * - `text`: a stored free-text address (web-app drafts, orders), which cannot be changed part by
 *   part, only replaced;
 * - `none`: no address at all.
 */
export type AddressBase =
  | { readonly kind: "parts"; readonly parts: AddressParts }
  | { readonly kind: "text"; readonly countryId?: number | undefined }
  | { readonly kind: "none" };

/**
 * The contact's address a new document takes: the one with category 47 (Rechnungsanschrift),
 * else the first one sevDesk lists; `none` when the contact has no address.
 */
export function contactAddressBase(contact: ContactDetails): AddressBase {
  const chosen =
    contact.addresses.find((address) => address.category?.id === INVOICE_ADDRESS_CATEGORY_ID) ??
    contact.addresses[0];
  if (chosen === undefined) return { kind: "none" };
  return {
    kind: "parts",
    parts: {
      name: chosen.recipient?.split("\n").join(", "),
      street: chosen.street,
      zip: chosen.zip,
      city: chosen.city,
      countryId: chosen.countryId,
    },
  };
}

/**
 * The address of a document: the call's address fields merged over `base`, part by part. Parts
 * the call leaves out keep their value; the name falls back to the contact's name; the country is
 * the given code, else the base's country, else Germany. Throws a `validation` error when there
 * is nothing to merge onto and no city is given, when a free-text address would be changed only
 * in part, and for an unknown country code.
 */
export function mergeAddress(
  base: AddressBase,
  input: AddressInput,
  contact: ContactDetails,
  countries: readonly Country[],
): DocumentAddress {
  const given = hasAddressInput(input);
  let parts: AddressParts;
  if (base.kind === "parts") {
    parts = base.parts;
  } else if (base.kind === "text") {
    const complete = [
      input.addressName,
      input.addressStreet,
      input.addressZip,
      input.addressCity,
    ].every((value) => value !== undefined);
    if (!complete) {
      throw new SevdeskError({
        kind: "validation",
        message:
          "The stored address of this draft is free text, so single parts of it cannot be " +
          "changed. Give addressName, addressStreet, addressZip and addressCity together " +
          "(addressCountry keeps the stored country unless given).",
      });
    }
    parts = { countryId: base.countryId };
  } else if (!given) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Contact ${contact.contact.id} has no address. Give addressName, addressStreet, ` +
        "addressZip, addressCity and addressCountry, or add an address to the contact first.",
    });
  } else if (input.addressCity === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Contact ${contact.contact.id} has no address to complete. Give at least addressCity, ` +
        "with addressStreet and addressZip.",
    });
  } else {
    parts = {};
  }
  const country =
    input.addressCountry !== undefined
      ? countryByCode(countries, input.addressCountry)
      : parts.countryId === undefined
        ? countryByCode(countries, GERMANY)
        : (countries.find((entry) => entry.id === parts.countryId) ?? { id: parts.countryId });
  return {
    name: input.addressName ?? parts.name ?? contact.contact.displayName,
    street: input.addressStreet ?? parts.street,
    zip: input.addressZip ?? parts.zip,
    city: input.addressCity ?? parts.city,
    countryId: country.id,
    countryCode: "code" in country ? country.code : undefined,
    countryName: "name" in country ? country.name : undefined,
  };
}

/** The address of a new document: the call's fields over the contact's invoice address. */
export function resolveAddress(
  contact: ContactDetails,
  input: AddressInput,
  countries: readonly Country[],
): DocumentAddress {
  return mergeAddress(contactAddressBase(contact), input, contact, countries);
}

/**
 * The printed lines of an address: name, street, "zip city", and the country name unless it is
 * Germany (for the multi-line `address` of orders and invoices).
 */
export function addressLines(address: DocumentAddress): string[] {
  const country = address.countryCode === GERMANY ? undefined : countryLabel(address);
  return [...partLines(address), ...(country === undefined ? [] : [country])];
}

/** The address as one line with its country always named, for previews. */
export function addressPreview(address: DocumentAddress): string {
  return [...partLines(address), countryLabel(address)].join(", ");
}

/** The name of a country by id, for previews of stored addresses. */
export function countryName(countryId: number, countries: readonly Country[]): string {
  return countries.find((entry) => entry.id === countryId)?.name ?? `StaticCountry ${countryId}`;
}

function partLines(address: DocumentAddress): string[] {
  const place = [address.zip, address.city].filter((part) => part !== undefined).join(" ");
  return [address.name, address.street, place === "" ? undefined : place].filter(
    (line): line is string => line !== undefined,
  );
}

function countryLabel(address: DocumentAddress): string {
  return address.countryName ?? `StaticCountry ${address.countryId}`;
}

function countryByCode(countries: readonly Country[], code: string): Country {
  const wanted = code.toLowerCase();
  const country = countries.find((entry) => entry.code?.toLowerCase() === wanted);
  if (country === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `sevDesk does not know the country code ${code.toUpperCase()}. ` +
        "sevdesk_reference_lookup kind=countries lists the countries and their codes.",
    });
  }
  return country;
}

/** The SevUser responsible for a document. `name` is sanitized upstream text. */
export interface ContactPerson {
  readonly id: number;
  readonly name: string;
}

/**
 * The contact person (B3): the requested user, which must exist, or the account's only user.
 * With several users and none requested this is a `validation` error listing their ids (names are
 * upstream text and stay out of error messages).
 */
export async function resolveContactPerson(
  client: SevdeskClient,
  requestedId: number | undefined,
  signal?: AbortSignal,
): Promise<ContactPerson> {
  const users = (await listUsers(client, signal)).items;
  if (requestedId !== undefined) {
    const user = users.find((entry) => entry.id === requestedId);
    if (user === undefined) {
      throw new SevdeskError({
        kind: "validation",
        message:
          `User ${requestedId} is not a user of this sevDesk account. ` +
          "sevdesk_reference_lookup kind=users lists the users and their ids.",
      });
    }
    return { id: user.id, name: user.name };
  }
  const [only, ...others] = users;
  if (only === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "sevDesk returned no users, but a document needs a contact person (Ansprechpartner, " +
        "a sevDesk user). Check the account's users in sevDesk.",
    });
  }
  if (others.length > 0) {
    const ids = users.map((user) => user.id).join(", ");
    throw new SevdeskError({
      kind: "validation",
      message:
        `This sevDesk account has ${users.length} users (ids ${ids}). Say which one is the ` +
        "contact person (Ansprechpartner) of the document with contactPersonId; " +
        "sevdesk_reference_lookup kind=users shows their names.",
    });
  }
  return { id: only.id, name: only.name };
}
