/**
 * What every draft tool resolves before it can build a payload, in one place for invoices, credit
 * notes and orders: local validation first (tax rule, rates, positions, currency: no request is
 * made for a call that cannot work), then the reads (bookkeeping system version, contact with
 * addresses, contact person, countries, units).
 *
 * Create: everything comes from the arguments and defaults. Update: every field the arguments
 * leave out keeps its stored value, and changes that would silently alter stored positions are
 * refused (a new price mode re-reads every stored price; a new tax rule must allow every stored
 * rate).
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import { getBookkeepingSystemVersion, type SystemVersion } from "../../sevdesk/system-version.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, currencyCode } from "../common.js";
import type { ContactDetails } from "../contacts.js";
import type { PositionRecord } from "../document-positions.js";
import { type Country, listUnits, type TaxRule, taxRuleById } from "../reference-data.js";
import { resolveCurrency } from "./fields.js";
import {
  type Amounts,
  type DraftPosition,
  expectedTotals,
  type PositionInput,
  type PriceMode,
  toDraftPositions,
} from "./positions.js";
import {
  type AddressBase,
  type AddressInput,
  addressLines,
  contactAddressBase,
  type ContactPerson,
  countryName,
  type DocumentAddress,
  hasAddressInput,
  loadContact,
  loadCountries,
  mergeAddress,
  resolveAddress,
  resolveContactPerson,
} from "./recipient.js";
import {
  checkTaxRuleUseCase,
  type DocumentTaxFields,
  documentTaxFields,
  LEGACY_TAX_TYPES,
  type RateLimit,
  resolveTaxRates,
  ruleForLegacyTaxType,
  type RuleScope,
  taxRuleFor,
  taxRuleWarnings,
} from "./tax.js";

/** How a document type validates its tax rule. */
export interface TaxOptions {
  readonly scope: RuleScope;
  /** Rule used when the call gives none (create only). */
  readonly defaultRuleId: number;
  readonly rateLimit?: RateLimit | undefined;
  /** A `notSupportedFor` entry that applies to this document, e.g. "e-invoices". */
  readonly useCase?: { readonly label: string; readonly noun: string } | undefined;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateArgs extends AddressInput {
  readonly contactId: number;
  readonly contactPersonId?: number | undefined;
  readonly priceMode?: PriceMode | undefined;
  readonly taxRule?: number | undefined;
  readonly taxText?: string | undefined;
  readonly currency?: string | undefined;
  readonly positions: readonly PositionInput[];
}

export interface CreateBasics {
  readonly version: SystemVersion;
  readonly contact: ContactDetails;
  readonly contactPerson: ContactPerson;
  readonly address: DocumentAddress;
  readonly rule: TaxRule;
  readonly tax: DocumentTaxFields;
  readonly positions: readonly DraftPosition[];
  readonly mode: PriceMode;
  readonly currency: string;
  readonly expected: Amounts;
  /** Trusted preview warnings (tax rule, currency). */
  readonly warnings: readonly string[];
}

/** Validates a create call and reads what its payload needs. Throws `validation` errors. */
export async function resolveCreateBasics(
  client: SevdeskClient,
  args: CreateArgs,
  tax: TaxOptions,
  signal?: AbortSignal,
): Promise<CreateBasics> {
  const rule = taxRuleFor(args.taxRule ?? tax.defaultRuleId, tax.scope);
  if (tax.useCase !== undefined) checkTaxRuleUseCase(rule, tax.useCase.label, tax.useCase.noun);
  const positions = toDraftPositions(
    args.positions,
    resolveTaxRates(rule, args.positions, tax.rateLimit),
  );
  const currency = resolveCurrency(args.currency);
  const mode = args.priceMode ?? "net";

  const [version, contact, contactPerson, countries] = await Promise.all([
    getBookkeepingSystemVersion(client, signal),
    loadContact(client, args.contactId, signal),
    resolveContactPerson(client, args.contactPersonId, signal),
    loadCountries(client, signal),
    checkUnits(client, args.positions, signal),
  ]);
  return {
    version,
    contact,
    contactPerson,
    address: resolveAddress(contact, args, countries),
    rule,
    tax: documentTaxFields(rule, version, args.taxText),
    positions,
    mode,
    currency,
    expected: expectedTotals(positions, mode),
    warnings: [...taxRuleWarnings(rule), ...currencyWarnings(currency)],
  };
}

/**
 * Checks the unit ids the call names explicitly against `GET /Unity` (the default, 1 "Stk", is a
 * system unit). Throws a `validation` error for an unknown unit.
 */
async function checkUnits(
  client: SevdeskClient,
  positions: readonly PositionInput[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (positions.every((position) => position.unitId === undefined)) return;
  const known = new Set((await listUnits(client, signal)).items.map((unit) => unit.id));
  positions.forEach((position, index) => {
    if (position.unitId !== undefined && !known.has(position.unitId)) {
      throw new SevdeskError({
        kind: "validation",
        message:
          `Position ${index + 1} uses unit ${position.unitId}, which this sevDesk account does ` +
          "not have. sevdesk_reference_lookup kind=units lists the units and their ids.",
      });
    }
  });
}

function currencyWarnings(currency: string): string[] {
  return currency === "EUR"
    ? []
    : [
        `The document is in ${currency}. Foreign-currency drafts are not verified against a ` +
          "live sevDesk account yet; check the amounts in sevDesk before finalizing.",
      ];
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

/** Stored fields every updatable draft has (see `current.ts`). */
export interface StoredDocument {
  readonly contact?: { readonly id: number } | undefined;
  readonly contactPerson?: { readonly id: number } | undefined;
  readonly showNet?: boolean | undefined;
  readonly taxRule?: { readonly id: number } | undefined;
  readonly taxType?: string | undefined;
  readonly taxSet?: { readonly id: number } | undefined;
  readonly taxText?: string | undefined;
  readonly smallSettlement?: boolean | undefined;
  readonly currency?: string | undefined;
}

/** The stored recipient address of a draft, as an update sees it. */
export interface StoredAddress {
  /** What the call's address fields are merged onto. */
  readonly base: AddressBase;
  /** The stored address parts or text, for the preview. */
  readonly lines: readonly (string | undefined)[];
  readonly countryId?: number | undefined;
}

export interface UpdateArgs extends AddressInput {
  readonly contactId?: number | undefined;
  readonly contactPersonId?: number | undefined;
  readonly priceMode?: PriceMode | undefined;
  readonly taxRule?: number | undefined;
  readonly taxText?: string | undefined;
  readonly currency?: string | undefined;
  readonly positions?: readonly PositionInput[] | undefined;
}

/** The tax fields of an update body: new ones, or the stored ones carried over. */
interface UpdateTaxFields {
  readonly taxRule?: { readonly id: number; readonly objectName: "TaxRule" };
  readonly taxType?: (typeof LEGACY_TAX_TYPES)[number] | "custom";
  readonly taxSet?: { readonly id: number; readonly objectName: "TaxSet" };
  readonly taxRate: 0;
  readonly taxText?: string;
  readonly smallSettlement: boolean;
}

export interface UpdateBasics {
  readonly version: SystemVersion;
  readonly contact: ContactDetails;
  readonly contactChanged: boolean;
  readonly contactPerson: { readonly id: number; readonly name?: string | undefined };
  readonly contactPersonChanged: boolean;
  readonly mode: PriceMode;
  readonly modeChanged: boolean;
  /** The effective rule; `undefined` for a stored custom tax set the call does not replace. */
  readonly rule: TaxRule | undefined;
  readonly tax: UpdateTaxFields;
  readonly taxChanged: boolean;
  readonly currency: string;
  readonly currencyChanged: boolean;
  /** New positions replacing all stored ones, or `undefined` to keep them. */
  readonly positions: readonly DraftPosition[] | undefined;
  /** A new recipient address, or `undefined` to keep the stored one. */
  readonly address: DocumentAddress | undefined;
  /** The stored address as one preview line (country named) when `address` is set. */
  readonly addressBefore: string | undefined;
  readonly warnings: readonly string[];
}

/**
 * Merges an update call into a stored draft. Throws `validation` errors for changes that would
 * alter stored positions behind the caller's back and for tax settings that cannot be validated.
 */
export async function resolveUpdateBasics(
  client: SevdeskClient,
  stored: StoredDocument,
  storedAddress: StoredAddress,
  storedPositions: readonly PositionRecord[],
  args: UpdateArgs,
  tax: Omit<TaxOptions, "defaultRuleId">,
  signal?: AbortSignal,
): Promise<UpdateBasics> {
  const storedMode: PriceMode = stored.showNet === false ? "gross" : "net";
  const mode = args.priceMode ?? storedMode;
  const modeChanged = mode !== storedMode;
  if (modeChanged && args.positions === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Changing priceMode from ${storedMode} to ${mode} would make sevDesk read every stored ` +
        `price as ${mode}. Pass the positions again with prices in the new mode.`,
    });
  }

  const storedRule =
    stored.taxRule === undefined
      ? ruleForLegacyTaxType(stored.taxType)
      : taxRuleById(stored.taxRule.id);
  const rule = args.taxRule === undefined ? storedRule : taxRuleFor(args.taxRule, tax.scope);
  const taxChanged = args.taxRule !== undefined || args.taxText !== undefined;
  if (rule === undefined && (args.positions !== undefined || taxChanged)) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "The stored tax setting of this draft is not a tax rule this server knows (e.g. a " +
        "custom tax set), so the positions cannot be checked against it. Pass taxRule as well.",
    });
  }
  if (rule !== undefined && tax.useCase !== undefined) {
    checkTaxRuleUseCase(rule, tax.useCase.label, tax.useCase.noun);
  }
  let positions: DraftPosition[] | undefined;
  if (args.positions !== undefined && rule !== undefined) {
    positions = toDraftPositions(
      args.positions,
      resolveTaxRates(rule, args.positions, tax.rateLimit),
    );
  } else if (args.taxRule !== undefined && rule !== undefined) {
    // The stored positions stay: each must be allowed by the new rule.
    resolveTaxRates(
      rule,
      storedPositions.map((row) => ({ taxRate: row.taxRate })),
      tax.rateLimit,
    );
  }

  const storedCurrency = currencyCode(stored.currency);
  const currency = args.currency === undefined ? storedCurrency : resolveCurrency(args.currency);
  const contactId = args.contactId ?? stored.contact?.id;
  if (contactId === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message: "This draft has no contact. Pass contactId (find it with sevdesk_contacts_search).",
    });
  }
  const contactChanged = stored.contact?.id !== contactId;
  const addressChanged = contactChanged || hasAddressInput(args);

  const [version, contact, contactPerson, countries] = await Promise.all([
    getBookkeepingSystemVersion(client, signal),
    loadContact(client, contactId, signal),
    args.contactPersonId !== undefined || stored.contactPerson === undefined
      ? resolveContactPerson(client, args.contactPersonId, signal)
      : Promise.resolve({ id: stored.contactPerson.id }),
    addressChanged ? loadCountries(client, signal) : Promise.resolve(undefined),
    args.positions === undefined ? undefined : checkUnits(client, args.positions, signal),
  ]);

  const newTax =
    taxChanged && rule !== undefined
      ? documentTaxFields(
          rule,
          version,
          args.taxText ?? (args.taxRule === undefined ? cleanStored(stored.taxText) : undefined),
        )
      : undefined;
  // A new contact brings its invoice address; otherwise the call's fields change the stored one
  // (or the contact's, when the draft has none).
  const addressBase =
    contactChanged || storedAddress.base.kind === "none"
      ? contactAddressBase(contact)
      : storedAddress.base;
  return {
    version,
    contact,
    contactChanged,
    contactPerson,
    contactPersonChanged: contactPerson.id !== stored.contactPerson?.id,
    mode,
    modeChanged,
    rule,
    tax: newTax ?? storedTaxFields(stored),
    taxChanged,
    currency,
    currencyChanged: currency !== storedCurrency,
    positions,
    address:
      countries === undefined ? undefined : mergeAddress(addressBase, args, contact, countries),
    addressBefore:
      countries === undefined ? undefined : storedAddressPreview(storedAddress, countries),
    warnings: [
      ...(rule !== undefined && (taxChanged || positions !== undefined)
        ? taxRuleWarnings(rule)
        : []),
      ...(currency !== storedCurrency ? currencyWarnings(currency) : []),
    ],
  };
}

/** A stored tax text kept as is (raw), unless it is blank. */
function cleanStored(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === "" ? undefined : text;
}

/** The stored tax fields, carried over unchanged. */
function storedTaxFields(stored: StoredDocument): UpdateTaxFields {
  const taxText = cleanStored(stored.taxText);
  const common = {
    taxRate: 0 as const,
    smallSettlement: stored.smallSettlement ?? false,
    ...(taxText === undefined ? {} : { taxText }),
  };
  if (stored.taxRule !== undefined) {
    return { taxRule: { id: stored.taxRule.id, objectName: "TaxRule" }, ...common };
  }
  const taxType = [...LEGACY_TAX_TYPES, "custom" as const].find(
    (type) => type === stored.taxType?.trim().toLowerCase(),
  );
  if (taxType === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message: "This draft has no tax setting this server can keep. Pass taxRule to set one.",
    });
  }
  return {
    taxType,
    ...(taxType === "custom" && stored.taxSet !== undefined
      ? { taxSet: { id: stored.taxSet.id, objectName: "TaxSet" as const } }
      : {}),
    ...common,
  };
}

/** The stored address as one preview line with its country named (cleaned upstream text). */
function storedAddressPreview(stored: StoredAddress, countries: readonly Country[]): string {
  const text = stored.lines
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ")
    .replaceAll("\n", ", ");
  const country =
    stored.countryId === undefined ? undefined : countryName(stored.countryId, countries);
  const parts = [cleanText(text, 200), country].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? "(none)" : parts.join(", ");
}

/** The printed lines of a new address joined for the multi-line `address` field. */
export function addressBlock(address: DocumentAddress): string {
  return addressLines(address).join("\n");
}
