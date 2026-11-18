/**
 * Deleting contacts and their details (Kontakte und Kontaktdaten löschen): the checks, previews and
 * requests behind `remove` of `sevdesk_contact_update` (one address or communication way) and
 * behind `sevdesk_contact_delete` (the whole contact).
 *
 * Recorded on a trial account (Update 2.0, 2026-11-16; spec/deviations.md D-084, D-085):
 * - `DELETE /Contact/{id}`, `/ContactAddress/{id}` and `/CommunicationWay/{id}` answer
 *   `{objects: [null]}`. Afterwards a GET by id answers 404, and a second DELETE answers 404 "No
 *   Model_<Name> with the id <id> was found": a 404 on a DELETE means "already gone".
 * - Deleting a contact deletes its addresses and communication ways with it (and its custom field
 *   values, recorded 2026-11-17, D-086), and deleting an
 *   organisation deletes its contact persons (the persons whose `parent` it is) as well (recorded
 *   again 2026-11-18 with two persons, probe `write-contact-delete-cascade`).
 * - sevDesk refuses to delete a contact a document references (recorded: a draft invoice), but
 *   inside HTTP 200: `{objects: null, error: {message: "Cannot delete because of existing
 *   necessary references"}}`, which the client raises as `unexpected_response` with status 200.
 *   Nothing is deleted. The same refusal comes for an organisation when a document references
 *   one of its contact persons, and then nothing is deleted either: the organisation, the person
 *   and the document stay unchanged (recorded 2026-11-18, D-084). The preview says so. It is
 *   reported as a refusal in our own words after a read confirms that the contact is still there;
 *   sevDesk's text never reaches the result. Every person is still read back afterwards, so an
 *   outcome that does not match this is reported, not assumed away.
 * - Not measured: what deleting a person does to contacts stored with that person as their
 *   parent (sevDesk stores any contact as a parent, D-083), so the preview says "may".
 * - An address or communication way can be deleted although it is the billing address, the main
 *   entry of its type or the last one, and sevDesk then makes no other entry the billing address or
 *   the main one; the update preview says so.
 *
 * Every id is checked against what was read before anything is sent, so a removal never touches
 * another contact's records. Nothing here retries a DELETE.
 */
import { z } from "zod";

import { canonicalJson, sha256Hex } from "../safety/hashing.js";
import type { ConfirmationFact } from "../safety/write-types.js";
import { type CompletedWrite, isReferenceRefusal, SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import {
  customFieldDtoSchema,
  type DisplayedCustomFields,
  readCustomFieldsForDisplay,
} from "./contact-custom-fields.js";
import {
  addressDtoSchema,
  communicationWayDtoSchema,
  type ContactDetails,
  type ContactDto,
  getContactDetails,
  parseContactRecord,
  toContactDto,
} from "./contacts.js";
import type { CountryReadOptions } from "./country-codes.js";
import {
  bothPreviews,
  inLanguage,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "./preview-text.js";
import { addressCategoryById, contactCategoryById } from "./reference-data.js";

/** Address category Rechnungsanschrift (invoice address), see `ADDRESS_CATEGORIES`. */
const BILLING_ADDRESS_CATEGORY = 47;
/** Contact persons listed by name and id in the delete preview; the rest are counted. */
const LISTED_PERSONS = 20;
/**
 * Contact persons an organisation may have for the delete tool: all of them are read for the
 * preview and read back one by one afterwards (about 25 s at sevDesk's pace for the maximum).
 */
const PERSON_SCAN_MAX = 100;
/** Longest sevDesk text (a name, an address) in a preview fact. */
const VALUE_MAX = 200;

// ---------------------------------------------------------------------------------------------
// What can be removed
// ---------------------------------------------------------------------------------------------

/**
 * What `remove` of `sevdesk_contact_update` takes off a contact: an address, one communication way
 * of a type (e-mail, phone, mobile, website), the link to the organisation a person belongs to, or
 * one custom field value (`contact-custom-fields.ts`).
 */
export const REMOVE_KINDS = [
  "address",
  "email",
  "phone",
  "mobile",
  "website",
  "parentOrganisation",
  "customField",
] as const;
type RemoveKind = (typeof REMOVE_KINDS)[number];

/** The kinds that name a communication way. */
export type WayKind = Exclude<RemoveKind, "address" | "parentOrganisation" | "customField">;

/** One entry of `remove`: the kind and the id `sevdesk_contact_get` shows for it. */
export interface RemoveInput {
  readonly kind: RemoveKind;
  readonly id: number;
}

/** sevDesk's communication way type of each kind, and how sentences name it. */
const WAYS: Readonly<
  Record<
    WayKind,
    { readonly type: string; readonly label: string; readonly noun: string; readonly aNoun: string }
  >
> = {
  email: { type: "EMAIL", label: "E-mail", noun: "e-mail address", aNoun: "an e-mail address" },
  phone: { type: "PHONE", label: "Phone", noun: "phone number", aNoun: "a phone number" },
  mobile: { type: "MOBILE", label: "Mobile", noun: "mobile number", aNoun: "a mobile number" },
  website: { type: "WEB", label: "Website", noun: "website", aNoun: "a website" },
};

const WAY_KINDS: readonly WayKind[] = ["email", "phone", "mobile", "website"];

/** The kind whose communication way type this is, if it is one we name. */
export function wayKindOfType(type: string): WayKind | undefined {
  const upper = type.trim().toUpperCase();
  return WAY_KINDS.find((kind) => WAYS[kind].type === upper);
}

type AddressRow = ContactDetails["addresses"][number];
type WayRow = ContactDetails["communicationWays"][number];

/** An address or communication way that an update deletes, as it was read. */
export type PlannedRemoval =
  | { readonly kind: "address"; readonly id: number; readonly address: AddressRow }
  | { readonly kind: WayKind; readonly id: number; readonly communicationWay: WayRow };

/** What an update's removals add to its preview and plan. */
export interface RemovalPlan {
  readonly removals: readonly PlannedRemoval[];
  /** One fact per removal, in the order of `remove`. */
  readonly facts: readonly ConfirmationFact[];
  /** For the action sentence, e.g. "remove address 3002". */
  readonly changes: readonly string[];
}

/**
 * Checks the addresses and communication ways of `remove` against the contact as read: every id
 * must be one of this contact's entries of that kind, and none may be listed twice. Throws a
 * `validation` SevdeskError (trusted text, ids only) before anything is sent otherwise.
 * `parentOrganisation` entries are the caller's (the contact itself changes, nothing is deleted),
 * and so are `customField` entries (`planCustomFieldRemovals`).
 */
export function planRemovals(details: ContactDetails, remove: readonly RemoveInput[]): RemovalPlan {
  const seen = new Set<string>();
  const removals: PlannedRemoval[] = [];
  for (const entry of remove) {
    if (entry.kind === "parentOrganisation" || entry.kind === "customField") continue;
    const resource = entry.kind === "address" ? "address" : "way";
    const key = `${resource}:${String(entry.id)}`;
    if (seen.has(key)) {
      throw validation(`remove lists ${describeEntry(entry)} twice; list each entry once.`);
    }
    seen.add(key);
    removals.push(
      entry.kind === "address"
        ? planAddressRemoval(details, entry.id)
        : planWayRemoval(details, entry.kind, entry.id),
    );
  }
  return {
    removals,
    facts: removals.map((removal) => removalFact(removal)),
    changes: removals.map((removal) => `remove ${describeEntry(removal)}`),
  };
}

/**
 * Added to "not one of the contact's …" when not every row could be read for certain (a cap, or
 * a read in several pages, D-146).
 */
const PARTIAL_NOTE = " that could be read (sevDesk may hold more than could be read for certain)";

function planAddressRemoval(details: ContactDetails, id: number): PlannedRemoval {
  const address = details.addresses.find((row) => row.id === id);
  if (address === undefined) {
    const partial = details.addressesComplete ? "" : PARTIAL_NOTE;
    throw validation(
      `Address ${String(id)} is not one of contact ${String(details.contact.id)}'s addresses` +
        `${partial}; nothing was changed. sevdesk_contact_get lists them with their ids.`,
    );
  }
  return { kind: "address", id, address };
}

function planWayRemoval(details: ContactDetails, kind: WayKind, id: number): PlannedRemoval {
  const contactId = String(details.contact.id);
  const way = details.communicationWays.find((row) => row.id === id);
  if (way === undefined) {
    const partial = details.communicationWaysComplete ? "" : PARTIAL_NOTE;
    throw validation(
      `Communication way ${String(id)} is not one of contact ${contactId}'s communication ways` +
        `${partial}; nothing was changed. sevdesk_contact_get lists them with their ids.`,
    );
  }
  const actual = wayKindOfType(way.type);
  if (actual !== kind) {
    const what = actual === undefined ? "an entry of another type" : WAYS[actual].aNoun;
    throw validation(
      `Communication way ${String(id)} of contact ${contactId} is ${what}, not ` +
        `${WAYS[kind].aNoun}; nothing was changed. Use the kind that matches the entry.`,
    );
  }
  return { kind, id, communicationWay: way };
}

/**
 * The consequences of an update's removals that sevDesk does not handle (D-084): a removed billing
 * address leaves no billing address unless another one remains or the same update adds a new one
 * (`newBillingAddress`), and a removed main entry leaves its type without a main entry unless the
 * same update adds a new main one (`newMainKinds`).
 */
export function removalWarnings(
  details: ContactDetails,
  removals: readonly PlannedRemoval[],
  newMainKinds: ReadonlySet<WayKind>,
  newBillingAddress: boolean,
): string[] {
  const removedIds = new Set(removals.map((removal) => `${removal.kind}:${String(removal.id)}`));
  const warnings: string[] = [];
  for (const removal of removals) {
    if (removal.kind === "address") {
      if (newBillingAddress || removal.address.category?.id !== BILLING_ADDRESS_CATEGORY) continue;
      const otherBilling = details.addresses.some(
        (row) =>
          row.id !== removal.id &&
          !removedIds.has(`address:${String(row.id)}`) &&
          row.category?.id === BILLING_ADDRESS_CATEGORY,
      );
      if (!otherBilling) {
        warnings.push(
          `Address ${String(removal.id)} is the billing address (Rechnungsanschrift); sevDesk ` +
            "makes no other address the billing address, so the contact has none afterwards.",
        );
      }
      continue;
    }
    if (!removal.communicationWay.main || newMainKinds.has(removal.kind)) continue;
    const { label, noun } = WAYS[removal.kind];
    warnings.push(
      `${label} ${String(removal.id)} is the main ${noun}; sevDesk makes no other entry the main ` +
        "one, so the contact has no main entry of this type afterwards.",
    );
  }
  return warnings;
}

/** An entry `remove` took off the contact, as it was before (tool output). */
export const removedEntrySchema = z.object({
  kind: z.enum(REMOVE_KINDS),
  id: z
    .number()
    .int()
    .describe("The removed entry's id; for parentOrganisation the organisation's contact id."),
  address: addressDtoSchema.optional().describe("kind address: the address as it was."),
  communicationWay: communicationWayDtoSchema
    .optional()
    .describe("email, phone, mobile, website: the entry as it was."),
  customField: customFieldDtoSchema
    .optional()
    .describe("customField: the value as it was (field id and name, value)."),
  alreadyGone: z
    .boolean()
    .optional()
    .describe("True when sevDesk no longer had the entry when it was deleted (404)."),
});

export type RemovedEntry = z.output<typeof removedEntrySchema>;

/**
 * Deletes the planned addresses and communication ways one by one, in order, and records each in
 * `completed` (the caller reports them when a later step fails). A 404 means the entry is gone
 * already (deleted in the meantime, D-084): it is reported as `alreadyGone`, not as an error.
 */
export async function executeRemovals(
  client: SevdeskClient,
  removals: readonly PlannedRemoval[],
  completed: CompletedWrite[],
  signal: AbortSignal | undefined,
): Promise<RemovedEntry[]> {
  const removed: RemovedEntry[] = [];
  for (const removal of removals) {
    const objectName = removal.kind === "address" ? "ContactAddress" : "CommunicationWay";
    const gone = await deleteRecord(client, objectName, removal.id, signal);
    completed.push({ objectName, id: String(removal.id) });
    removed.push({
      kind: removal.kind,
      id: removal.id,
      ...(removal.kind === "address"
        ? { address: removal.address }
        : { communicationWay: removal.communicationWay }),
      ...(gone ? { alreadyGone: true } : {}),
    });
  }
  return removed;
}

/** Sends one DELETE; true when sevDesk answered 404 (the record was gone already). */
async function deleteRecord(
  client: SevdeskClient,
  objectName: "ContactAddress" | "CommunicationWay",
  id: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await client.request({
      method: "DELETE",
      path: sevdeskPath(objectName, id),
      ...(signal === undefined ? {} : { signal }),
    });
    return false;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") return true;
    throw error;
  }
}

/**
 * The preview fact of one removal: the entry as it was read (sevDesk text, already cleaned in the
 * DTO and cleaned again here), so what is removed can be entered again.
 */
function removalFact(removal: PlannedRemoval): ConfirmationFact {
  if (removal.kind === "address") {
    const { address } = removal;
    const categoryId = address.category?.id;
    const category =
      categoryId === undefined
        ? undefined
        : (addressCategoryById(categoryId)?.name ?? `category ${String(categoryId)}`);
    const place = [address.zip, address.city].filter((part) => part !== undefined).join(" ");
    const text = [address.street, place === "" ? undefined : place, address.country]
      .filter((part): part is string => part !== undefined)
      .join(", ");
    const suffix = category === undefined || category === "" ? "" : ` (${category})`;
    return {
      label: `Remove address (id ${String(removal.id)})`,
      value: `${cleanText(text, VALUE_MAX) ?? "(no street, zip or city)"}${suffix}`,
    };
  }
  const way = removal.communicationWay;
  return {
    label: `Remove ${WAYS[removal.kind].label.toLowerCase()} (id ${String(removal.id)})`,
    value: `${cleanText(way.value, VALUE_MAX) ?? "(empty)"}${way.main ? " (main entry)" : ""}`,
  };
}

function describeEntry(entry: RemoveInput): string {
  if (entry.kind === "address") return `address ${String(entry.id)}`;
  if (entry.kind === "parentOrganisation") return `the link to organisation ${String(entry.id)}`;
  if (entry.kind === "customField") return `custom field value ${String(entry.id)}`;
  return `${WAYS[entry.kind].label.toLowerCase()} ${String(entry.id)}`;
}

// ---------------------------------------------------------------------------------------------
// Delete a contact
// ---------------------------------------------------------------------------------------------

/** A person whose `parent` is the organisation being deleted (its Ansprechpartner). */
export interface ContactPerson {
  readonly id: number;
  /** Cleaned display name on one line. */
  readonly name: string;
}

/** What `sevdesk_contact_delete` previewed, for its result and the audit log. */
interface ContactDeleteState {
  readonly contact: ContactDto;
  readonly addressIds: readonly number[];
  readonly communicationWayIds: readonly number[];
  /**
   * The contacts whose parent this contact is: an organisation's contact persons, which sevDesk
   * deletes with it (D-084), or those stored under a person, which it may delete; else empty.
   */
  readonly persons: readonly ContactPerson[];
}

/** The plan of a contact deletion: both previews (a human confirms it), binding and state. */
export interface ContactDeletePlan {
  readonly preview: DeletePreview;
  readonly previewDe: DeletePreview;
  /**
   * The approval binding (`WritePlan.binding`): SHA-256 of every record the deletion takes with
   * it, contact persons included, so a person added (or swapped beyond the listed ones) after the
   * human was asked asks again.
   */
  readonly binding: string;
  readonly state: ContactDeleteState;
}

interface DeletePreview {
  readonly action: string;
  readonly facts: readonly ConfirmationFact[];
  readonly warnings: readonly string[];
  readonly irreversible: boolean;
}

/**
 * Reads the contact with its addresses and communication ways and the contacts whose parent it is
 * (for any kind, since sevDesk stores a person as parent too, D-083) and builds the confirmation
 * in English and German: the contact by name and customer number, how many addresses,
 * communication ways and custom field values sevDesk deletes with it (the values: D-086; a failed
 * read of them is shown, not raised), the contact persons (listed by name and id up to
 * {@link LISTED_PERSONS}): an organisation's, which sevDesk deletes with it too, or those stored
 * under a person, which it may delete (not measured), and that this cannot be undone. Refuses a
 * contact that does not exist, and one whose contact persons cannot all be read (a partial list
 * would hide what goes). Whether documents still reference the contact only sevDesk knows, and it
 * refuses that itself (see {@link executeContactDelete}).
 */
export async function prepareContactDelete(
  client: SevdeskClient,
  contactId: number,
  options: CountryReadOptions,
): Promise<ContactDeletePlan> {
  const id = toSevdeskId(contactId);
  let details: ContactDetails;
  try {
    details = await getContactDetails(client, id, options);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw validation(`Contact ${String(id)} does not exist in sevDesk (or was deleted already).`);
    }
    throw error;
  }
  const { contact } = details;
  // Persons are read for every kind: sevDesk stores any contact as a parent (D-083), so a person
  // (or data from other clients) can have contacts whose parent it is, and the cascade may take
  // them too.
  const [persons, customFields] = await Promise.all([
    contactPersons(client, contact, options.signal),
    readCustomFieldsForDisplay(client, id, options.signal),
  ]);
  const organisation = contact.kind === "organisation";

  const addresses = countText(details.addresses.length, details.addressesComplete);
  const ways = countText(details.communicationWays.length, details.communicationWaysComplete);
  const customFieldValues: Record<PreviewLanguage, string> = customFields.readable
    ? countText(customFields.rows.length, customFields.complete)
    : { en: "could not be read", de: "nicht lesbar" };
  const warnings: Phrase[] = [
    phrase(
      `The contact, its ${addresses.en} address${details.addresses.length === 1 ? "" : "es"} ` +
        `and its ${ways.en} communication way${plural(details.communicationWays.length)} are ` +
        "deleted from sevDesk; this cannot be undone.",
      `Der Kontakt, seine ${addresses.de} ` +
        `${details.addresses.length === 1 ? "Adresse" : "Adressen"} und seine ${ways.de} ` +
        `${details.communicationWays.length === 1 ? "Kommunikationsweg" : "Kommunikationswege"} ` +
        "werden aus sevDesk gelöscht; das lässt sich nicht rückgängig machen.",
    ),
  ];
  const personCount = persons.length;
  const onePerson = personCount === 1;
  if (personCount > 0 && organisation) {
    // Recorded 2026-11-18 (D-084): a document that names one of the persons blocks the whole
    // deletion, inside HTTP 200, and nothing is deleted.
    warnings.push(
      phrase(
        `sevDesk deletes the organisation's ${String(personCount)} contact ` +
          `person${plural(personCount)} (Ansprechpartner) with it; this cannot be undone either. ` +
          `If a document uses the organisation or ${onePerson ? "its contact person" : "one of them"}, ` +
          "sevDesk refuses the whole deletion and deletes nothing.",
        `sevDesk löscht ${onePerson ? "den Ansprechpartner" : `die ${String(personCount)} Ansprechpartner`} ` +
          "der Organisation mit; das lässt sich ebenfalls nicht rückgängig machen. Verwendet ein " +
          `Dokument die Organisation oder ${onePerson ? "ihren Ansprechpartner" : "einen davon"}, ` +
          "lehnt sevDesk die ganze Löschung ab und löscht nichts.",
      ),
    );
  } else if (personCount > 0) {
    warnings.push(
      phrase(
        `sevDesk has ${String(personCount)} contact${plural(personCount)} stored with this ` +
          `person as ${onePerson ? "its" : "their"} organisation (parent, set outside this ` +
          `server). sevDesk may delete ${onePerson ? "it" : "them"} with it; this cannot be ` +
          "undone either.",
        `In sevDesk ${onePerson ? "ist 1 Kontakt" : `sind ${String(personCount)} Kontakte`} mit ` +
          "dieser Person als Organisation gespeichert (parent, außerhalb dieses Servers gesetzt). " +
          `sevDesk löscht ${onePerson ? "ihn" : "sie"} möglicherweise mit; das lässt sich ` +
          "ebenfalls nicht rückgängig machen.",
      ),
    );
  }
  const customFieldWarning = customFieldValuesWarning(customFields, personCount, organisation);
  if (customFieldWarning !== undefined) warnings.push(customFieldWarning);

  const name = cleanText(contact.displayName, VALUE_MAX) ?? `(unnamed contact ${String(id)})`;
  const customerNumber = cleanText(contact.customerNumber, VALUE_MAX);
  const addressIds = details.addresses.map((row) => row.id);
  const communicationWayIds = details.communicationWays.map((row) => row.id);
  return {
    ...bothPreviews((lang) => {
      const de = lang === "de";
      const none = de ? "(keine)" : "(none)";
      const facts: ConfirmationFact[] = [
        { label: de ? "Kontakt" : "Contact", value: `${name} (${de ? "ID" : "id"} ${String(id)})` },
        {
          label: de ? "Kundennummer" : "Customer number (Kundennummer)",
          value: customerNumber ?? none,
        },
        { label: de ? "Kategorie" : "Category", value: categoryText(contact, lang) ?? none },
      ];
      if (contact.parentOrganisationId !== undefined) {
        facts.push({
          label: de ? "Ansprechpartner von" : "Contact person of",
          value: `${de ? "Kontakt" : "contact"} ${String(contact.parentOrganisationId)}`,
        });
      }
      facts.push(
        {
          label: de ? "Adressen (werden mitgelöscht)" : "Addresses (deleted with it)",
          value: addresses[lang],
        },
        {
          label: de
            ? "Kommunikationswege (werden mitgelöscht)"
            : "Communication ways (deleted with it)",
          value: ways[lang],
        },
        {
          // sevDesk deletes a contact's custom field values with it (recorded 2026-11-17, D-086).
          label: de
            ? "Werte von Kontaktfeldern (werden mitgelöscht)"
            : "Custom field values (Kontaktfelder, deleted with it)",
          value: customFieldValues[lang],
        },
      );
      if (organisation || personCount > 0) facts.push(...personFacts(persons, organisation, lang));
      return {
        action: deleteAction(id, contact.kind, personCount, lang),
        facts,
        warnings: inLanguage(warnings, lang),
        irreversible: true,
      };
    }),
    binding: sha256Hex(
      canonicalJson({
        contact: id,
        addresses: addressIds,
        communicationWays: communicationWayIds,
        persons: persons.map((person) => person.id),
        // The values the fact row counts, so one swapped for another asks again; null when
        // they could not be read.
        customFieldValues: customFields.readable ? customFields.rows.map((row) => row.id) : null,
      }),
    ),
    state: { contact, addressIds, communicationWayIds, persons },
  };
}

/**
 * The warning that custom field values go with the contact (D-086), and with an organisation's
 * contact persons, whom sevDesk deletes too (D-084), or with the contacts stored under a person,
 * which it may delete. The persons' values are not read, so they are "any". Left out when the
 * contact has no values (all of them read) and no persons.
 */
function customFieldValuesWarning(
  customFields: DisplayedCustomFields,
  personCount: number,
  organisation: boolean,
): Phrase | undefined {
  if (personCount > 0 && !organisation) {
    return phrase(
      "Its custom field values (Kontaktfelder) are deleted with it, and so are those of any " +
        "contact sevDesk deletes with it.",
      "Auch die Werte seiner Kontaktfelder werden mitgelöscht, ebenso die jedes Kontakts, den " +
        "sevDesk mitlöscht.",
    );
  }
  if (personCount > 0) {
    const one = personCount === 1;
    return phrase(
      "Any custom field values (Kontaktfelder) of the contact and of its " +
        `${one ? "contact person" : `${String(personCount)} contact persons`} are deleted with ` +
        "them.",
      "Auch die Werte von Kontaktfeldern des Kontakts und " +
        `${one ? "seines Ansprechpartners" : `seiner ${String(personCount)} Ansprechpartner`} ` +
        "werden mitgelöscht.",
    );
  }
  if (customFields.readable && customFields.complete && customFields.rows.length === 0) {
    return undefined;
  }
  return phrase(
    "Its custom field values (Kontaktfelder) are deleted with it.",
    "Auch die Werte seiner Kontaktfelder werden mitgelöscht.",
  );
}

/**
 * "Delete contact 1001 (organisation) and its 2 contact persons from sevDesk."; for a person that
 * other contacts name as parent, that sevDesk may delete them with it.
 */
function deleteAction(
  id: number,
  kind: ContactDto["kind"],
  persons: number,
  lang: PreviewLanguage,
): string {
  const contact = String(id);
  const organisation = kind === "organisation";
  if (lang === "de") {
    const noun = organisation ? "Organisation" : "Person";
    if (!organisation && persons > 0) {
      const them =
        persons === 1 ? "seinen Ansprechpartner" : `seine ${String(persons)} Ansprechpartner`;
      return `Kontakt ${contact} (Person) aus sevDesk löschen; sevDesk löscht möglicherweise ${them} mit.`;
    }
    const alsoPersons =
      persons === 0
        ? ""
        : persons === 1
          ? " und seinen Ansprechpartner"
          : ` und seine ${String(persons)} Ansprechpartner`;
    return `Kontakt ${contact} (${noun})${alsoPersons} aus sevDesk löschen.`;
  }
  const them = `its ${String(persons)} contact person${plural(persons)}`;
  if (!organisation && persons > 0) {
    return `Delete contact ${contact} (person) from sevDesk; sevDesk may delete ${them} with it.`;
  }
  return `Delete contact ${contact} (${kind})${persons === 0 ? "" : ` and ${them}`} from sevDesk.`;
}

/**
 * The facts that name the contact persons (contacts whose parent the contact is): how many, then
 * one fact per person (cleaned name and id) up to {@link LISTED_PERSONS}, then how many more are
 * not listed. `certain` (an organisation, recorded, D-084): "deleted with it"; for a person, whose
 * cascade is not measured: "may be deleted with it".
 */
function personFacts(
  persons: readonly ContactPerson[],
  certain: boolean,
  lang: PreviewLanguage,
): ConfirmationFact[] {
  const de = lang === "de";
  const perhaps = certain ? "" : "möglicherweise ";
  const many = de ? `werden ${perhaps}mitgelöscht` : `${certain ? "" : "may be "}deleted with it`;
  const one = de ? `wird ${perhaps}mitgelöscht` : many;
  const facts: ConfirmationFact[] = [
    {
      label: de ? `Ansprechpartner (${many})` : `Contact persons (${many})`,
      value: persons.length === 0 ? (de ? "keine" : "none") : String(persons.length),
    },
    ...persons.slice(0, LISTED_PERSONS).map((person) => ({
      label: de ? `Ansprechpartner (${one})` : `Contact person (${one})`,
      value: `${person.name} (${de ? "Kontakt" : "contact"} ${String(person.id)})`,
    })),
  ];
  const rest = persons.length - LISTED_PERSONS;
  if (rest > 0) {
    facts.push({
      label: de ? "Weitere Ansprechpartner" : "More contact persons",
      value: de
        ? `${String(rest)} weitere, werden ${perhaps}ebenfalls gelöscht, hier nicht aufgeführt`
        : `${String(rest)} more, ${certain ? "" : "may be "}deleted as well, not listed here`,
    });
  }
  return facts;
}

/** What a read after the deletion found for one contact person. */
const PERSON_OUTCOMES = ["deleted", "remaining", "unchecked"] as const;

/** A contact person of a deleted organisation and what the read afterwards found (tool output). */
export const contactPersonOutcomeSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  outcome: z
    .enum(PERSON_OUTCOMES)
    .describe(
      "deleted: a read afterwards found it gone (404); remaining: it is still in sevDesk; " +
        "unchecked: the read failed.",
    ),
});

type ContactPersonOutcome = z.output<typeof contactPersonOutcomeSchema>;

/** How a contact deletion ended. */
export interface ContactDeleteResult {
  /** True only when a read afterwards found the contact gone (404). */
  readonly deleted: boolean;
  /** True when sevDesk refused because documents still reference the contact (D-085). */
  readonly stillReferenced: boolean;
  /** Each contact person of an organisation, read back after the DELETE; empty for a person. */
  readonly persons: readonly ContactPersonOutcome[];
  /** Trusted sentences for the result; never sevDesk's own text. */
  readonly notes: readonly string[];
}

/**
 * Sends `DELETE /Contact/{id}` once, then reads the contact back: `deleted` is true only when that
 * read is a 404. A 404 on the DELETE itself means it was gone already. sevDesk's refusal of a
 * contact that documents reference arrives inside HTTP 200 (D-085); it becomes `stillReferenced`
 * with a note in our own words once the read shows the contact is still there. Other failures of
 * the DELETE pass through unchanged. The contact persons (`persons`, from the preview) are read
 * back one by one too, since sevDesk deletes an organisation's with it (D-084) and may delete
 * those stored under a person; one whose fate does not match the contact's, or could not be read,
 * gets a note. `kind` is the deleted contact's.
 */
export async function executeContactDelete(
  client: SevdeskClient,
  contactId: number,
  kind: ContactDto["kind"],
  persons: readonly ContactPerson[],
  signal: AbortSignal | undefined,
): Promise<ContactDeleteResult> {
  const result = await deleteAndCheck(client, contactId, signal);
  const outcomes: ContactPersonOutcome[] = [];
  for (const person of persons) {
    outcomes.push({
      id: person.id,
      displayName: person.name,
      outcome: await personOutcome(client, person.id, signal),
    });
  }
  const personGone = outcomes.some((entry) => entry.outcome === "deleted");
  return {
    ...result,
    persons: outcomes,
    notes: [
      ...(result.stillReferenced ? [refusalNote(contactId, persons.length > 0, personGone)] : []),
      ...result.notes,
      ...personNotes(contactId, kind, result.deleted, outcomes),
    ],
  };
}

/** One read of a contact person after the deletion. */
async function personOutcome(
  client: SevdeskClient,
  personId: number,
  signal: AbortSignal | undefined,
): Promise<ContactPersonOutcome["outcome"]> {
  try {
    await client.request({
      method: "GET",
      path: sevdeskPath("Contact", personId),
      ...(signal === undefined ? {} : { signal }),
    });
    return "remaining";
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    return error.kind === "not_found" ? "deleted" : "unchecked";
  }
}

/**
 * The notes on contact persons whose read afterwards does not match the fate of the contact they
 * belong to (`parent`, an organisation or a person).
 */
function personNotes(
  parentId: number,
  parentKind: ContactDto["kind"],
  parentDeleted: boolean,
  outcomes: readonly ContactPersonOutcome[],
): string[] {
  const ids = (outcome: ContactPersonOutcome["outcome"]): string[] =>
    outcomes.filter((entry) => entry.outcome === outcome).map((entry) => String(entry.id));
  const parent = `${parentKind} ${String(parentId)}`;
  const notes: string[] = [];
  const remaining = ids("remaining");
  if (parentDeleted && remaining.length > 0) {
    const one = remaining.length === 1;
    notes.push(
      `Contact ${one ? "person" : "persons"} ${remaining.join(", ")} ` +
        `${one ? "is" : "are"} still in sevDesk although ${parent} was deleted; ` +
        (parentKind === "organisation"
          ? "sevDesk deleted an organisation's contact persons with it when this was recorded. "
          : `whether sevDesk deletes contacts stored under a person is not recorded. `) +
        "Check with sevdesk_contact_get.",
    );
  }
  const gone = ids("deleted");
  if (!parentDeleted && gone.length > 0) {
    notes.push(
      `Contact ${gone.length === 1 ? "person" : "persons"} ${gone.join(", ")} ` +
        `${gone.length === 1 ? "is" : "are"} gone although ${parent} is still in sevDesk. ` +
        "Check with sevdesk_contact_get.",
    );
  }
  const unchecked = ids("unchecked");
  if (unchecked.length > 0) {
    notes.push(
      `Whether contact ${unchecked.length === 1 ? "person" : "persons"} ` +
        `${unchecked.join(", ")} ${unchecked.length === 1 ? "was" : "were"} deleted could not ` +
        "be checked. Check with sevdesk_contact_get.",
    );
  }
  return notes;
}

/**
 * sevDesk's refusal (D-085) in our words. "Nothing was deleted" only while no contact person read
 * back as gone: a refusal deleted nothing when recorded (D-084, 2026-11-18), but the reads
 * afterwards decide what the note claims.
 */
function refusalNote(contactId: number, hasPersons: boolean, personGone: boolean): string {
  const referenced = hasPersons ? "it or one of its contact persons" : "it";
  return (
    `sevDesk refused to delete contact ${String(contactId)}: documents still reference ` +
    `${referenced} (sevDesk keeps a contact that invoices or other documents use, drafts ` +
    `included). ${personGone ? "The contact" : "Nothing was deleted; the contact"}, its ` +
    "addresses and its communication ways are unchanged. Give those drafts another contact or " +
    "delete them first; finalized documents keep their contact."
  );
}

/** The DELETE and the read of the contact itself (see {@link executeContactDelete}). */
async function deleteAndCheck(
  client: SevdeskClient,
  contactId: number,
  signal: AbortSignal | undefined,
): Promise<Omit<ContactDeleteResult, "persons">> {
  const id = String(contactId);
  const withSignal = signal === undefined ? {} : { signal };
  let refused = false;
  let goneBefore = false;
  try {
    await client.request({
      method: "DELETE",
      path: sevdeskPath("Contact", contactId),
      ...withSignal,
    });
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    if (error.kind === "not_found") goneBefore = true;
    else if (isReferenceRefusal(error)) refused = true;
    else throw error;
  }

  let stillThere: boolean;
  try {
    await client.request({ method: "GET", path: sevdeskPath("Contact", contactId), ...withSignal });
    stillThere = true;
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    if (error.kind !== "not_found") {
      throw new SevdeskError({
        kind: error.kind,
        message: refused
          ? `sevDesk refused to delete contact ${id} because documents still reference it, and ` +
            `the check afterwards failed: ${error.message} Check with sevdesk_contact_get ` +
            "whether it still exists; do not delete again before."
          : `sevDesk accepted the deletion of contact ${id}, but the check afterwards failed: ` +
            `${error.message} Do not delete again; check with sevdesk_contact_get.`,
        cause: error,
        ...(refused ? {} : { completedWrites: [{ objectName: "Contact", id }] }),
      });
    }
    stillThere = false;
  }

  if (refused) {
    // The refusal's note depends on what the reads of the contact persons find; the caller writes
    // it (refusalNote).
    return stillThere
      ? { deleted: false, stillReferenced: true, notes: [] }
      : {
          deleted: true,
          stillReferenced: false,
          notes: [
            `sevDesk answered that documents still reference contact ${id}, but a read afterwards ` +
              "no longer finds it: it is gone.",
          ],
        };
  }
  if (stillThere) {
    return {
      deleted: false,
      stillReferenced: false,
      notes: [
        `sevDesk accepted the deletion, but still returns contact ${id}. Check it with ` +
          "sevdesk_contact_get.",
      ],
    };
  }
  return {
    deleted: true,
    stillReferenced: false,
    notes: goneBefore ? [`Contact ${id} was already gone in sevDesk when it was deleted.`] : [],
  };
}

/**
 * The contacts whose `parent` is this contact, by id, with their cleaned names on one line
 * (D-083: the parent filter works; checked again here). For an organisation these are its contact
 * persons; a person has them only when it was stored as a parent outside this server (sevDesk
 * checks nothing, D-083). Refuses when there are more than {@link PERSON_SCAN_MAX}: sevDesk
 * deletes an organisation's persons with it (D-084), and a preview that names only some of them
 * would hide what goes.
 */
async function contactPersons(
  client: SevdeskClient,
  contact: ContactDto,
  signal: AbortSignal | undefined,
): Promise<ContactPerson[]> {
  const parentId = contact.id;
  const list = await client.listAll(
    "/Contact",
    { depth: "1", "parent[id]": parentId, "parent[objectName]": "Contact" },
    { max: PERSON_SCAN_MAX, ...(signal === undefined ? {} : { signal }) },
  );
  if (list.truncated) {
    throw validation(
      contact.kind === "organisation"
        ? `Contact ${String(parentId)} is an organisation with more than ` +
            `${String(PERSON_SCAN_MAX)} contact persons (Ansprechpartner), and sevDesk deletes ` +
            "them all with it. Not all of them could be read, so this deletion is not offered " +
            "here; nothing was changed."
        : `Contact ${String(parentId)} is a person that more than ${String(PERSON_SCAN_MAX)} ` +
            "contacts name as their organisation (parent), and sevDesk may delete them with it. " +
            "Not all of them could be read, so this deletion is not offered here; nothing was " +
            "changed.",
    );
  }
  const persons = new Map<number, ContactPerson>();
  for (const raw of list.items) {
    const record = parseContactRecord(raw);
    if (record.parent?.id !== parentId || record.id === parentId) continue;
    const name = cleanText(toContactDto(record).displayName.replace(/\s+/g, " "), VALUE_MAX);
    persons.set(record.id, {
      id: record.id,
      name: name ?? `(unnamed contact ${String(record.id)})`,
    });
  }
  return [...persons.values()].sort((a, b) => a.id - b.id);
}

/** "Kunde (customer)", in German "Kunde"; `undefined` for a contact without a category. */
function categoryText(contact: ContactDto, lang: PreviewLanguage): string | undefined {
  if (contact.category === undefined) return undefined;
  const category = contactCategoryById(contact.category.id);
  if (category === undefined) {
    return `${lang === "de" ? "Kategorie" : "category"} ${String(contact.category.id)}`;
  }
  return lang === "de" ? category.name : `${category.name} (${category.nameEn.toLowerCase()})`;
}

/** A count in both languages, "at least" when the list was cut. */
function countText(count: number, complete: boolean): Record<PreviewLanguage, string> {
  return complete
    ? { en: String(count), de: String(count) }
    : { en: `at least ${String(count)}`, de: `mindestens ${String(count)}` };
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
