/**
 * Contact writes (Kontakte anlegen und ändern): the checks, previews and requests behind
 * `sevdesk_contact_create` and `sevdesk_contact_update`.
 *
 * A contact is spread over three resources: `Contact` (names, category, numbers), `ContactAddress`
 * and `CommunicationWay` (e-mail, phone, website). Creating one is therefore up to three separate,
 * non-atomic writes; when a later one fails, the error carries the records already created
 * (`completedWrites`) so the user can finish the contact with the update tool instead of creating
 * it twice.
 *
 * Payload evidence (live-measured by sevdesk-rs, https://github.com/jernoxit/sevdesk-rs,
 * `src/document_payload/contact.rs` and `src/endpoints/contact.rs`, 2026-10-01; the same shapes
 * in the WooCommerce sevDesk plugin's `ContactSync.php`):
 * - `POST /Contact` takes `name` (organisation) or `surename` + `familyname` (person, sevDesk's
 *   spelling), `category` `{id, objectName: "Category"}` and `status`; without `customerNumber`
 *   sevDesk assigns the next free number itself.
 * - `PUT /Contact/{id}`, `PUT /ContactAddress/{id}` and `PUT /CommunicationWay/{id}` are partial
 *   updates: fields left out stay as they are. So updates send only what changes, and nothing is
 *   ever cleared. `name` sent for a person does not make it an organisation, so the kinds are
 *   never mixed here.
 * - `GET /Contact?customerNumber=` filters exactly; `name=` matches loosely (organisation name,
 *   first or last name), so candidates are compared here.
 * Outgoing payloads are built from strict schemas, because sevDesk ignores unknown fields
 * silently (D-003).
 */
import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { type CompletedWrite, SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import type { ConfirmationFact, ConfirmationPreview, SevdeskObjectRef } from "../tools/types.js";
import { cleanText, trimmedText } from "./common.js";
import {
  type ContactDetails,
  type ContactRecord,
  getContactDetails,
  getNextCustomerNumber,
  parseContactRecord,
} from "./contacts.js";
import {
  CONTACT_CATEGORIES,
  contactCategoryById,
  contactCategoryIdByKey,
  type ContactCategoryKey,
  listCountries,
} from "./reference-data.js";

/** Contact status "active" (spec `Model_Contact.status`: 100 lead, 500 pending, 1000 active). */
const ACTIVE_STATUS = 1000;
/** Address category Rechnungsanschrift (invoice address), see `ADDRESS_CATEGORIES`. */
const BILLING_ADDRESS_CATEGORY = 47;
/** Communication way key Arbeit (work), see `COMMUNICATION_WAY_KEYS`. */
const WORK_KEY = 2;
/** Country used for a new address when none is given: Germany. */
const DEFAULT_COUNTRY_CODE = "DE";

/** Candidate contacts read for the name check (the `name` filter already narrows them). */
const NAME_SCAN_MAX = 500;
/** E-mail rows read for the e-mail check (sevDesk has no filter by value). */
const EMAIL_SCAN_MAX = 10_000;
const DISPLAY_MAX = 200;

// ---------------------------------------------------------------------------------------------
// Outgoing payloads (strict)
// ---------------------------------------------------------------------------------------------

function refSchema<N extends string>(objectName: N) {
  return z.strictObject({
    id: z.number().int().positive(),
    objectName: z.literal(objectName),
  });
}

const text = z.string().min(1);

const contactCreatePayloadSchema = z.strictObject({
  name: text.optional(),
  surename: text.optional(),
  familyname: text.optional(),
  category: refSchema("Category"),
  status: z.literal(ACTIVE_STATUS),
  customerNumber: text.optional(),
  vatNumber: text.optional(),
  taxNumber: text.optional(),
  buyerReference: text.optional(),
});

const contactUpdatePayloadSchema = z.strictObject({
  name: text.optional(),
  surename: text.optional(),
  familyname: text.optional(),
  category: refSchema("Category").optional(),
  customerNumber: text.optional(),
  vatNumber: text.optional(),
  taxNumber: text.optional(),
  buyerReference: text.optional(),
});

const addressFieldsSchema = z.strictObject({
  street: text.optional(),
  zip: text.optional(),
  city: text.optional(),
  country: refSchema("StaticCountry"),
  category: refSchema("Category"),
});

const addressCreatePayloadSchema = addressFieldsSchema.extend({ contact: refSchema("Contact") });

const addressUpdatePayloadSchema = z.strictObject({
  street: text.optional(),
  zip: text.optional(),
  city: text.optional(),
  country: refSchema("StaticCountry").optional(),
});

const COMMUNICATION_TYPES = ["EMAIL", "PHONE", "WEB"] as const;
type CommunicationType = (typeof COMMUNICATION_TYPES)[number];

const wayFieldsSchema = z.strictObject({
  type: z.enum(COMMUNICATION_TYPES),
  value: text,
  key: refSchema("CommunicationWayKey"),
  main: z.boolean(),
});

const wayCreatePayloadSchema = wayFieldsSchema.extend({ contact: refSchema("Contact") });

const wayUpdatePayloadSchema = z.strictObject({ value: text });

type ContactCreatePayload = z.output<typeof contactCreatePayloadSchema>;
/** Text fields of a contact that updates can change. */
type ContactTextField = Extract<
  keyof ContactUpdatePayload & keyof ContactRecord,
  | "name"
  | "surename"
  | "familyname"
  | "customerNumber"
  | "vatNumber"
  | "taxNumber"
  | "buyerReference"
>;
type ContactUpdatePayload = z.output<typeof contactUpdatePayloadSchema>;
type AddressFields = z.output<typeof addressFieldsSchema>;
type AddressUpdatePayload = z.output<typeof addressUpdatePayloadSchema>;
type WayFields = z.output<typeof wayFieldsSchema>;

function ref<N extends string>(objectName: N, id: number): { id: number; objectName: N } {
  return { id, objectName };
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Postal address fields of a write; `country` is an ISO 3166-1 alpha-2 code. */
interface AddressInput {
  readonly street?: string | undefined;
  readonly zip?: string | undefined;
  readonly city?: string | undefined;
  readonly country?: string | undefined;
}

/** E-mail, phone and website of a write. */
interface CommunicationInput {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly website?: string | undefined;
}

/** What `sevdesk_contact_create` asks for (already validated and trimmed by the tool). */
export interface ContactCreateInput extends AddressInput, CommunicationInput {
  readonly organisationName?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly category: ContactCategoryKey;
  readonly customerNumber?: string | undefined;
  readonly vatNumber?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly allowDuplicate: boolean;
}

/** What `sevdesk_contact_update` asks for: only the fields to change. */
export interface ContactUpdateInput extends AddressInput, CommunicationInput {
  readonly id: number;
  readonly organisationName?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly category?: ContactCategoryKey | undefined;
  readonly customerNumber?: string | undefined;
  readonly vatNumber?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly buyerReference?: string | undefined;
}

const COMMUNICATION_FIELDS: readonly {
  readonly field: keyof CommunicationInput;
  readonly type: CommunicationType;
  readonly label: string;
}[] = [
  { field: "email", type: "EMAIL", label: "E-mail" },
  { field: "phone", type: "PHONE", label: "Phone" },
  { field: "website", type: "WEB", label: "Website" },
];

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** What `executeContactCreate` sends, decided by {@link planContactCreate}. */
export interface ContactCreateState {
  readonly contact: ContactCreatePayload;
  readonly address: AddressFields | undefined;
  readonly communicationWays: readonly WayFields[];
}

/**
 * Checks a new contact and builds its preview: one kind of name, a known country, a free customer
 * number, and no existing contact with the same name or e-mail address unless `allowDuplicate`.
 * Reads only. Throws a `validation` SevdeskError naming the existing contacts otherwise.
 */
export async function planContactCreate(
  client: SevdeskClient,
  input: ContactCreateInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: ContactCreateState }> {
  const kind = createKind(input);
  const categoryId = contactCategoryIdByKey(input.category);
  const hasAddress = [input.street, input.zip, input.city].some((value) => value !== undefined);
  if (!hasAddress && input.country !== undefined) {
    throw validation("A country alone is no address: add street, zip or city, or leave it out.");
  }

  const [nameMatches, emailMatches, numberOwner, nextNumber, country] = await Promise.all([
    findContactsByName(client, input, kind, signal),
    input.email === undefined
      ? Promise.resolve(emptyScan())
      : findContactsByEmail(client, input.email, signal),
    input.customerNumber === undefined
      ? Promise.resolve(undefined)
      : findContactByCustomerNumber(client, input.customerNumber, signal),
    input.customerNumber === undefined
      ? getNextCustomerNumber(client, signal)
      : Promise.resolve(undefined),
    hasAddress
      ? resolveCountry(client, input.country ?? DEFAULT_COUNTRY_CODE, signal)
      : Promise.resolve(undefined),
  ]);

  if (numberOwner !== undefined) {
    throw validation(
      `The customer number is already used by contact ${numberOwner}. Use another number, or ` +
        "leave customerNumber out so sevDesk assigns the next free one.",
    );
  }
  const duplicates = duplicateReasons(nameMatches.ids, emailMatches.ids);
  if (duplicates.length > 0 && !input.allowDuplicate) {
    throw validation(
      `${duplicates.join(" ")} Use the existing contact (sevdesk_contact_get, ` +
        "sevdesk_contact_update), or call again with allowDuplicate: true to create another one.",
    );
  }

  const contact = contactCreatePayloadSchema.parse({
    ...(kind === "organisation"
      ? { name: input.organisationName }
      : { surename: input.firstName, familyname: input.lastName }),
    category: ref("Category", categoryId),
    status: ACTIVE_STATUS,
    customerNumber: input.customerNumber,
    vatNumber: input.vatNumber,
    taxNumber: input.taxNumber,
    buyerReference: input.buyerReference,
  });
  const address =
    country === undefined
      ? undefined
      : addressFieldsSchema.parse({
          street: input.street,
          zip: input.zip,
          city: input.city,
          country: ref("StaticCountry", country.id),
          category: ref("Category", BILLING_ADDRESS_CATEGORY),
        });
  const communicationWays = COMMUNICATION_FIELDS.flatMap(({ field, type }) => {
    const value = input[field];
    return value === undefined
      ? []
      : [
          wayFieldsSchema.parse({
            type,
            value,
            key: ref("CommunicationWayKey", WORK_KEY),
            main: true,
          }),
        ];
  });

  const displayName = contactName(input) ?? "";
  const category = CONTACT_CATEGORIES.find((entry) => entry.id === categoryId);
  const facts: ConfirmationFact[] = [
    { label: "Name", value: displayName },
    { label: "Type", value: kind },
    {
      label: "Category",
      value: category === undefined ? String(categoryId) : categoryLabel(category),
    },
    {
      label: "Customer number",
      value:
        input.customerNumber ??
        `${nextNumber ?? "next free number"} (next free number, assigned by sevDesk)`,
    },
  ];
  pushFact(facts, "VAT ID (USt-IdNr.)", input.vatNumber);
  pushFact(facts, "Tax number (Steuernummer)", input.taxNumber);
  pushFact(facts, "Buyer reference (Leitweg-ID)", input.buyerReference);
  if (country !== undefined) {
    facts.push({
      label: "Billing address (Rechnungsanschrift)",
      value: formatAddress(input.street, input.zip, input.city, country.name),
    });
  }
  for (const { field, label } of COMMUNICATION_FIELDS) pushFact(facts, label, input[field]);

  const warnings: string[] = [];
  if (duplicates.length > 0) {
    warnings.push(`Creating it anyway (allowDuplicate): ${duplicates.join(" ")}`);
  }
  if (nameMatches.truncated || emailMatches.truncated) {
    warnings.push(
      "The duplicate check could not read every existing contact or e-mail address; a duplicate " +
        "may exist that was not found.",
    );
  }
  if (input.customerNumber === undefined) {
    warnings.push(
      "sevDesk assigns the customer number when the contact is saved; the number shown is the " +
        "next free one right now.",
    );
  }
  const parts = [
    address === undefined ? undefined : "a billing address",
    wayCount(communicationWays.length),
  ];
  const extras = parts.filter((part): part is string => part !== undefined);
  return {
    preview: {
      action:
        `Create the ${kind} contact ${displayName} (${category?.name ?? `category ${categoryId}`})` +
        `${extras.length === 0 ? "" : ` with ${extras.join(" and ")}`}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: { contact, address, communicationWays },
  };
}

/**
 * Creates the contact, then its address, then its communication ways, and reads it back. Never
 * retries. When a step after the contact fails, the thrown error lists the records already created.
 */
export async function executeContactCreate(
  client: SevdeskClient,
  state: ContactCreateState,
  signal?: AbortSignal,
): Promise<{ details: ContactDetails; affected: SevdeskObjectRef[] }> {
  const withSignal = signal === undefined ? {} : { signal };
  const created = await client.request({
    method: "POST",
    path: "/Contact",
    body: state.contact,
    ...withSignal,
  });
  const contactId = parseContactRecord(expectSingle(created, "created contact")).id;
  const completed: CompletedWrite[] = [{ objectName: "Contact", id: String(contactId) }];
  const contactRef = ref("Contact", contactId);
  try {
    if (state.address !== undefined) {
      const body = addressCreatePayloadSchema.parse({ ...state.address, contact: contactRef });
      const address = await client.request({
        method: "POST",
        path: "/ContactAddress",
        body,
        ...withSignal,
      });
      completed.push({
        objectName: "ContactAddress",
        id: String(createdId(address, "contact address")),
      });
    }
    for (const way of state.communicationWays) {
      const body = wayCreatePayloadSchema.parse({ ...way, contact: contactRef });
      const answer = await client.request({
        method: "POST",
        path: "/CommunicationWay",
        body,
        ...withSignal,
      });
      completed.push({
        objectName: "CommunicationWay",
        id: String(createdId(answer, "communication way")),
      });
    }
    const details = await getContactDetails(client, contactId, signal);
    return { details, affected: completed.map((entry) => ({ ...entry })) };
  } catch (error) {
    throw afterPartialWrite(error, completed);
  }
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

type AddressChange =
  | { readonly kind: "update"; readonly id: number; readonly body: AddressUpdatePayload }
  | { readonly kind: "create"; readonly body: AddressFields };

type WayChange =
  | { readonly kind: "update"; readonly id: number; readonly body: { value: string } }
  | { readonly kind: "create"; readonly body: WayFields };

/** What `executeContactUpdate` sends, decided by {@link planContactUpdate}. */
export interface ContactUpdateState {
  readonly contactId: number;
  readonly contact: ContactUpdatePayload | undefined;
  readonly address: AddressChange | undefined;
  readonly communicationWays: readonly WayChange[];
}

/**
 * Reads the contact with its addresses and communication ways and works out the smallest change:
 * contact fields that differ, the billing address (or the only address; a new billing address when
 * there is neither) and the main e-mail/phone/website of each type (added when missing). Fields
 * that were not given are never touched. Throws a `validation` SevdeskError when the change is
 * impossible (names of the other contact kind, customer number taken) or empty.
 */
export async function planContactUpdate(
  client: SevdeskClient,
  input: ContactUpdateInput,
  signal?: AbortSignal,
): Promise<{ preview: ConfirmationPreview; state: ContactUpdateState }> {
  const id = toSevdeskId(input.id);
  const hasAddress = [input.street, input.zip, input.city, input.country].some(
    (value) => value !== undefined,
  );
  const [record, details, numberOwner, country] = await Promise.all([
    readContactRecord(client, id, signal),
    getContactDetails(client, id, signal),
    input.customerNumber === undefined
      ? Promise.resolve(undefined)
      : findContactByCustomerNumber(client, input.customerNumber, signal),
    input.country === undefined
      ? Promise.resolve(undefined)
      : resolveCountry(client, input.country, signal),
  ]);
  const name = cleanText(details.contact.displayName, DISPLAY_MAX) ?? `contact ${id}`;

  if (details.contact.kind === "person" && input.organisationName !== undefined) {
    throw validation(
      `Contact ${id} is a person: change firstName/lastName instead of organisationName ` +
        "(sevDesk cannot turn a person into an organisation; create a new contact instead).",
    );
  }
  if (
    details.contact.kind === "organisation" &&
    (input.firstName !== undefined || input.lastName !== undefined)
  ) {
    throw validation(
      `Contact ${id} is an organisation: change organisationName instead of firstName/lastName ` +
        "(persons are separate contacts in sevDesk).",
    );
  }
  if (numberOwner !== undefined && numberOwner !== id) {
    throw validation(`The customer number is already used by contact ${numberOwner}.`);
  }

  const facts: ConfirmationFact[] = [{ label: "Contact", value: `${name} (id ${id})` }];
  const changed: string[] = [];
  const contactBody: Record<string, unknown> = {};
  const field = (key: ContactTextField, next: string | undefined, label: string): void => {
    if (next === undefined) return;
    const current = trimmedText(record[key]);
    if (current === next) return;
    contactBody[key] = next;
    facts.push({ label, value: `${show(current)} → ${next}` });
    changed.push(label.toLowerCase());
  };
  field("name", input.organisationName, "Name");
  field("surename", input.firstName, "First name");
  field("familyname", input.lastName, "Last name");
  if (input.category !== undefined) {
    const categoryId = contactCategoryIdByKey(input.category);
    if (record.category?.id !== categoryId) {
      contactBody["category"] = ref("Category", categoryId);
      const before =
        record.category === undefined ? undefined : contactCategoryById(record.category.id);
      const after = CONTACT_CATEGORIES.find((entry) => entry.id === categoryId);
      facts.push({
        label: "Category",
        value: `${before === undefined ? show(record.category?.id) : categoryLabel(before)} → ${after === undefined ? categoryId : categoryLabel(after)}`,
      });
      changed.push("category");
    }
  }
  field("customerNumber", input.customerNumber, "Customer number");
  field("vatNumber", input.vatNumber, "VAT ID");
  field("taxNumber", input.taxNumber, "Tax number");
  field("buyerReference", input.buyerReference, "Buyer reference");
  const contact =
    Object.keys(contactBody).length === 0
      ? undefined
      : contactUpdatePayloadSchema.parse(contactBody);

  const warnings: string[] = [];
  let address: AddressChange | undefined;
  if (hasAddress) {
    address = await planAddressChange(client, input, details, country, facts, signal);
    if (address !== undefined) changed.push("address");
    if (!details.addressesComplete) {
      warnings.push(
        "sevDesk had more addresses than could be read; the address chosen may not be the billing address.",
      );
    }
  }

  const communicationWays: WayChange[] = [];
  for (const { field: key, type, label } of COMMUNICATION_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    const target = mainWay(details, type);
    if (target !== undefined) {
      if (sameValue(type, target.value, value)) continue;
      communicationWays.push({
        kind: "update",
        id: target.id,
        body: wayUpdatePayloadSchema.parse({ value }),
      });
      facts.push({ label: `${label} (id ${target.id})`, value: `${target.value} → ${value}` });
    } else {
      communicationWays.push({
        kind: "create",
        body: wayFieldsSchema.parse({
          type,
          value,
          key: ref("CommunicationWayKey", WORK_KEY),
          main: true,
        }),
      });
      facts.push({ label: `${label} (new)`, value });
    }
    changed.push(label.toLowerCase());
  }
  if (communicationWays.length > 0 && !details.communicationWaysComplete) {
    warnings.push(
      "sevDesk had more communication ways than could be read; the main entry may have been missed.",
    );
  }

  if (changed.length === 0) {
    throw validation(`Nothing to change: contact ${id} already has these values.`);
  }
  return {
    preview: {
      action: `Update contact ${name} (id ${id}): ${changed.join(", ")}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: { contactId: id, contact, address, communicationWays },
  };
}

/**
 * Sends the planned changes in order (contact, address, communication ways) and reads the contact
 * back. Never retries; a failure after the first write lists what was already changed.
 */
export async function executeContactUpdate(
  client: SevdeskClient,
  state: ContactUpdateState,
  signal?: AbortSignal,
): Promise<{ details: ContactDetails; affected: SevdeskObjectRef[] }> {
  const withSignal = signal === undefined ? {} : { signal };
  const completed: CompletedWrite[] = [];
  const contactRef = ref("Contact", state.contactId);
  try {
    if (state.contact !== undefined) {
      await client.request({
        method: "PUT",
        path: sevdeskPath("Contact", state.contactId),
        body: state.contact,
        ...withSignal,
      });
      completed.push({ objectName: "Contact", id: String(state.contactId) });
    }
    if (state.address?.kind === "update") {
      await client.request({
        method: "PUT",
        path: sevdeskPath("ContactAddress", state.address.id),
        body: state.address.body,
        ...withSignal,
      });
      completed.push({ objectName: "ContactAddress", id: String(state.address.id) });
    } else if (state.address?.kind === "create") {
      const body = addressCreatePayloadSchema.parse({ ...state.address.body, contact: contactRef });
      const answer = await client.request({
        method: "POST",
        path: "/ContactAddress",
        body,
        ...withSignal,
      });
      completed.push({
        objectName: "ContactAddress",
        id: String(createdId(answer, "contact address")),
      });
    }
    for (const way of state.communicationWays) {
      if (way.kind === "update") {
        await client.request({
          method: "PUT",
          path: sevdeskPath("CommunicationWay", way.id),
          body: way.body,
          ...withSignal,
        });
        completed.push({ objectName: "CommunicationWay", id: String(way.id) });
      } else {
        const body = wayCreatePayloadSchema.parse({ ...way.body, contact: contactRef });
        const answer = await client.request({
          method: "POST",
          path: "/CommunicationWay",
          body,
          ...withSignal,
        });
        completed.push({
          objectName: "CommunicationWay",
          id: String(createdId(answer, "communication way")),
        });
      }
    }
    const details = await getContactDetails(client, state.contactId, signal);
    return { details, affected: completed.map((entry) => ({ ...entry })) };
  } catch (error) {
    throw completed.length === 0 ? error : afterPartialWrite(error, completed);
  }
}

async function planAddressChange(
  client: SevdeskClient,
  input: ContactUpdateInput,
  details: ContactDetails,
  country: { readonly id: number; readonly name: string } | undefined,
  facts: ConfirmationFact[],
  signal: AbortSignal | undefined,
): Promise<AddressChange | undefined> {
  const target = targetAddress(details);
  if (target !== undefined) {
    const body: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const key of ["street", "zip", "city"] as const) {
      const next = input[key];
      if (next === undefined || next === target[key]) continue;
      body[key] = next;
      lines.push(`${key} ${show(target[key])} → ${next}`);
    }
    if (country !== undefined && country.id !== target.countryId) {
      body["country"] = ref("StaticCountry", country.id);
      lines.push(`country id ${show(target.countryId)} → ${country.name} (id ${country.id})`);
    }
    if (lines.length === 0) return undefined;
    facts.push({ label: `Address (id ${target.id})`, value: lines.join("; ") });
    return { kind: "update", id: target.id, body: addressUpdatePayloadSchema.parse(body) };
  }
  if ([input.street, input.zip, input.city].every((value) => value === undefined)) {
    throw validation(
      `Contact ${details.contact.id} has no address yet: a new one needs street, zip or city, ` +
        "not only a country.",
    );
  }
  const resolved = country ?? (await resolveCountry(client, DEFAULT_COUNTRY_CODE, signal));
  facts.push({
    label: "New billing address (Rechnungsanschrift)",
    value: formatAddress(input.street, input.zip, input.city, resolved.name),
  });
  return {
    kind: "create",
    body: addressFieldsSchema.parse({
      street: input.street,
      zip: input.zip,
      city: input.city,
      country: ref("StaticCountry", resolved.id),
      category: ref("Category", BILLING_ADDRESS_CATEGORY),
    }),
  };
}

/**
 * The address an update changes: the billing address (Rechnungsanschrift, lowest id first), else
 * the only address; `undefined` (add a billing address) when there is neither.
 */
function targetAddress(details: ContactDetails): ContactDetails["addresses"][number] | undefined {
  const sorted = [...details.addresses].sort((a, b) => a.id - b.id);
  return (
    sorted.find((address) => address.category?.id === BILLING_ADDRESS_CATEGORY) ??
    (sorted.length === 1 ? sorted[0] : undefined)
  );
}

/** The main communication way of a type, else the one with the lowest id. */
function mainWay(
  details: ContactDetails,
  type: CommunicationType,
): ContactDetails["communicationWays"][number] | undefined {
  const ofType = details.communicationWays
    .filter((way) => way.type.toUpperCase() === type)
    .sort((a, b) => a.id - b.id);
  return ofType.find((way) => way.main) ?? ofType[0];
}

function sameValue(type: CommunicationType, current: string, next: string): boolean {
  return type === "PHONE"
    ? current.trim() === next
    : current.trim().toLowerCase() === next.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Reads behind the checks
// ---------------------------------------------------------------------------------------------

interface ScanResult {
  /** Matching contact ids, ascending, de-duplicated. */
  readonly ids: readonly number[];
  /** True when the scan stopped at its cap before the end. */
  readonly truncated: boolean;
}

function emptyScan(): ScanResult {
  return { ids: [], truncated: false };
}

async function readContactRecord(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<ContactRecord> {
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Contact", id),
    ...(signal === undefined ? {} : { signal }),
  });
  return parseContactRecord(expectSingle(payload, `contact ${id}`));
}

/**
 * Contacts with the same name: `GET /Contact?depth=1&name=…` (persons included), compared here
 * case-insensitively on the organisation name, or first and last name for persons.
 */
async function findContactsByName(
  client: SevdeskClient,
  input: ContactCreateInput,
  kind: "organisation" | "person",
  signal: AbortSignal | undefined,
): Promise<ScanResult> {
  const query =
    kind === "organisation" ? input.organisationName : (input.lastName ?? input.firstName);
  const list = await client.listAll(
    "/Contact",
    { depth: "1", name: query },
    { max: NAME_SCAN_MAX, ...(signal === undefined ? {} : { signal }) },
  );
  const matches = list.items
    .map((raw) => parseContactRecord(raw))
    .filter((record) =>
      kind === "organisation"
        ? same(record.name, input.organisationName)
        : trimmedText(record.name) === undefined &&
          same(record.surename, input.firstName) &&
          same(record.familyname, input.lastName),
    );
  return { ids: uniqueIds(matches.map((record) => record.id)), truncated: list.truncated };
}

const emailRowSchema = z.object({ id: zId, contact: zOptionalRef, type: zText, value: zText });

/**
 * Contacts with this e-mail address: every `EMAIL` communication way (`GET
 * /CommunicationWay?type=EMAIL`, paged up to {@link EMAIL_SCAN_MAX}), compared case-insensitively.
 */
async function findContactsByEmail(
  client: SevdeskClient,
  email: string,
  signal: AbortSignal | undefined,
): Promise<ScanResult> {
  const list = await client.listAll(
    "/CommunicationWay",
    { type: "EMAIL" },
    { max: EMAIL_SCAN_MAX, pageSize: 1000, ...(signal === undefined ? {} : { signal }) },
  );
  const wanted = email.toLowerCase();
  const ids = list.items
    .map((raw) => parseUpstream(emailRowSchema, raw, "communication ways"))
    .filter(
      (row) =>
        row.type?.trim().toUpperCase() === "EMAIL" &&
        row.value?.trim().toLowerCase() === wanted &&
        row.contact !== undefined,
    )
    .map((row) => row.contact?.id ?? 0);
  return { ids: uniqueIds(ids), truncated: list.truncated };
}

/**
 * The id of the contact that has this customer number, if any (`GET /Contact?customerNumber=…`,
 * an exact filter, re-checked here in case sevDesk ignored it).
 */
async function findContactByCustomerNumber(
  client: SevdeskClient,
  customerNumber: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const page = await client.list(
    "/Contact",
    { depth: "1", customerNumber },
    { limit: 100, ...(signal === undefined ? {} : { signal }) },
  );
  return uniqueIds(
    page.items
      .map((raw) => parseContactRecord(raw))
      .filter((record) => trimmedText(record.customerNumber) === customerNumber)
      .map((record) => record.id),
  )[0];
}

/** The StaticCountry of an ISO alpha-2 code (`GET /StaticCountry`). */
async function resolveCountry(
  client: SevdeskClient,
  code: string,
  signal: AbortSignal | undefined,
): Promise<{ id: number; name: string }> {
  const list = await listCountries(client, signal);
  const wanted = code.toLowerCase();
  const country = list.items.find((entry) => entry.code?.trim().toLowerCase() === wanted);
  if (country === undefined) {
    throw validation(
      "sevDesk does not know this country code. Use an ISO 3166-1 alpha-2 code such as DE, AT " +
        "or CH; sevdesk_reference_lookup kind=countries lists them.",
    );
  }
  return { id: country.id, name: country.name };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function createKind(input: ContactCreateInput): "organisation" | "person" {
  const person = input.firstName !== undefined || input.lastName !== undefined;
  if (input.organisationName !== undefined && person) {
    throw validation(
      "Give either organisationName (a company) or firstName/lastName (a person), not both. " +
        "A person working for a company is a separate contact.",
    );
  }
  if (input.organisationName === undefined && !person) {
    throw validation(
      "A contact needs organisationName (a company) or firstName/lastName (a person).",
    );
  }
  return person ? "person" : "organisation";
}

function contactName(input: {
  readonly organisationName?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
}): string | undefined {
  const raw =
    input.organisationName ??
    [input.firstName, input.lastName].filter((part) => part !== undefined).join(" ");
  return cleanText(raw, DISPLAY_MAX);
}

function duplicateReasons(byName: readonly number[], byEmail: readonly number[]): string[] {
  const reasons: string[] = [];
  if (byName.length > 0) {
    reasons.push(`A contact with the same name already exists: ${contactList(byName)}.`);
  }
  if (byEmail.length > 0) {
    reasons.push(`A contact with the same e-mail address already exists: ${contactList(byEmail)}.`);
  }
  return reasons;
}

function contactList(ids: readonly number[]): string {
  const shown = ids.slice(0, 5).map((id) => `contact ${id}`);
  return ids.length > 5 ? `${shown.join(", ")} and ${ids.length - 5} more` : shown.join(", ");
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Case- and whitespace-insensitive equality; two absent values are equal. */
function same(a: string | undefined, b: string | undefined): boolean {
  return normalize(a) === normalize(b);
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

function categoryLabel(category: { readonly name: string; readonly nameEn: string }): string {
  return `${category.name} (${category.nameEn.toLowerCase()})`;
}

function formatAddress(
  street: string | undefined,
  zip: string | undefined,
  city: string | undefined,
  country: string,
): string {
  const place = [zip, city].filter((part) => part !== undefined).join(" ");
  return [street, place === "" ? undefined : place, country]
    .filter((part): part is string => part !== undefined)
    .map((part) => sanitizeUntrusted(part, DISPLAY_MAX))
    .join(", ");
}

function pushFact(facts: ConfirmationFact[], label: string, value: string | undefined): void {
  if (value !== undefined) facts.push({ label, value });
}

function wayCount(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? "1 communication way" : `${count} communication ways`;
}

function show(value: string | number | undefined): string {
  return value === undefined ? "(empty)" : String(value);
}

/** The id of a created record in a write answer (`objects` = the record, or an array of one). */
function createdId(payload: unknown, what: string): number {
  return parseUpstream(
    z.object({ id: zId }),
    expectSingle(payload, `created ${what}`),
    `the created ${what}`,
  ).id;
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}

/**
 * The error of a step that failed after other writes succeeded, carrying those writes as
 * `completedWrites` (the framework shows them and records them in the audit log). Non-sevDesk
 * failures become `aborted` (cancellation) or `unexpected_response` errors.
 */
function afterPartialWrite(error: unknown, completed: readonly CompletedWrite[]): SevdeskError {
  if (error instanceof SevdeskError) return withCompletedWrites(error, completed);
  const aborted = error instanceof Error && error.name === "AbortError";
  return new SevdeskError({
    kind: aborted ? "aborted" : "unexpected_response",
    message: aborted
      ? "The call was cancelled part-way through."
      : "The call failed part-way through for an unexpected reason.",
    cause: error,
    completedWrites: completed,
  });
}
