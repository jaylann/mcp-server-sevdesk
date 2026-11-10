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
 *
 * The account's VAT regulation (`account-settings.ts`, read first and cached) decides the default
 * tax rule (1, or 11 on a Kleinunternehmer account) and refuses rules that do not fit it; when it
 * cannot be read, the old behavior applies and the preview says the rule was not checked.
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import { getBookkeepingSystemVersion, type SystemVersion } from "../../sevdesk/system-version.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { loadAccountSettings, type TaxRegime, taxRegimeOf } from "../account-settings.js";
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
  checkTaxRuleRegime,
  checkTaxRuleUseCase,
  DEFAULT_TAX_RULE_ID,
  type DocumentTaxFields,
  documentTaxFields,
  LEGACY_TAX_TYPES,
  type RateLimit,
  regimeDefaultRuleId,
  type RegimeMessage,
  resolveTaxRates,
  ruleForLegacyTaxType,
  type RuleScope,
  SMALL_BUSINESS_RULE_ID,
  taxRuleFor,
  taxRuleWarnings,
  UNKNOWN_REGIME_WARNING,
} from "./tax.js";

/** Per-call context of a draft `prepare`. */
export interface DraftCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Owner of the account-settings cache: tools pass `ctx.config` (see `account-settings.ts`). */
  readonly cacheOwner: object;
}

/** How a document type validates its tax rule. */
export interface TaxOptions {
  readonly scope: RuleScope;
  /**
   * Rule used when the call gives none (create only). On a Kleinunternehmer account the regular
   * default (rule 1) becomes rule 11.
   */
  readonly defaultRuleId: number;
  readonly rateLimit?: RateLimit | undefined;
  /** A `notSupportedFor` entry that applies to this document, e.g. "e-invoices". */
  readonly useCase?: { readonly label: string; readonly noun: string } | undefined;
  /**
   * Keep `defaultRuleId` on every account (no rule 1 → rule 11 switch): a default taken from a
   * source document, which a rule that does not fit then refuses with `regimeMessage`.
   */
  readonly keepDefault?: boolean | undefined;
  /** Refusal text for a rule that does not fit the account's regime (default: `regimeRefusal`). */
  readonly regimeMessage?: RegimeMessage | undefined;
  /**
   * Rules, default and a preview warning on a Kleinunternehmer account, for documents whose rules
   * differ there beyond the default (provision credit notes).
   */
  readonly smallBusiness?:
    | {
        readonly scope: RuleScope;
        readonly defaultRuleId: number;
        readonly warning?: string | undefined;
      }
    | undefined;
}

/** The account's regime (`undefined` when it cannot be read), read through the cache. */
async function accountRegime(
  client: SevdeskClient,
  options: DraftCallOptions,
): Promise<TaxRegime | undefined> {
  return taxRegimeOf(
    await loadAccountSettings(client, { cacheOwner: options.cacheOwner, signal: options.signal }),
  );
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateArgs extends AddressInput {
  readonly contactId: number;
  readonly contactPersonId?: number | undefined;
  readonly priceMode?: PriceMode | undefined;
  readonly taxRuleId?: number | undefined;
  readonly taxText?: string | undefined;
  readonly currency?: string | undefined;
  readonly positions: readonly PositionInput[];
}

export interface CreateBasics {
  readonly version: SystemVersion;
  /** The account's VAT regulation; `undefined` when it could not be read. */
  readonly regime: TaxRegime | undefined;
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

/**
 * Validates a create call and reads what its payload needs. Throws `validation` errors. The
 * account's regime is read first (it decides the default rule); everything else is validated
 * before the remaining reads.
 */
export async function resolveCreateBasics(
  client: SevdeskClient,
  args: CreateArgs,
  tax: TaxOptions,
  options: DraftCallOptions,
): Promise<CreateBasics> {
  const { signal } = options;
  const regime = await accountRegime(client, options);
  const special = regime === "small_business" ? tax.smallBusiness : undefined;
  const scope = special?.scope ?? tax.scope;
  const ruleId =
    args.taxRuleId ??
    special?.defaultRuleId ??
    (tax.keepDefault === true ? tax.defaultRuleId : regimeDefaultRuleId(tax.defaultRuleId, regime));
  const named = taxRuleById(ruleId);
  if (named !== undefined) checkTaxRuleRegime(named, regime, scope, tax.regimeMessage);
  const rule = taxRuleFor(ruleId, scope);
  if (tax.useCase !== undefined) checkTaxRuleUseCase(rule, tax.useCase.label, tax.useCase.noun);
  const positions = toDraftPositions(
    args.positions,
    resolveTaxRates(rule, args.positions, tax.rateLimit, regime),
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
    regime,
    contact,
    contactPerson,
    address: resolveAddress(contact, args, countries),
    rule,
    tax: documentTaxFields(rule, version, args.taxText, regime),
    positions,
    mode,
    currency,
    expected: expectedTotals(positions, mode),
    warnings: [
      ...(regime === undefined ? [UNKNOWN_REGIME_WARNING] : []),
      ...(special?.warning === undefined ? [] : [special.warning]),
      ...taxRuleWarnings(rule, regime),
      ...currencyWarnings(currency),
    ],
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
  readonly taxRuleId?: number | undefined;
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
  /** The account's VAT regulation; `undefined` when it could not be read. */
  readonly regime: TaxRegime | undefined;
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
  tax: Omit<TaxOptions, "defaultRuleId" | "smallBusiness" | "keepDefault">,
  options: DraftCallOptions,
): Promise<UpdateBasics> {
  const { signal } = options;
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

  const regime = await accountRegime(client, options);
  const storedRule =
    stored.taxRule === undefined
      ? ruleForLegacyTaxType(stored.taxType)
      : taxRuleById(stored.taxRule.id);
  const named = args.taxRuleId === undefined ? undefined : taxRuleById(args.taxRuleId);
  if (named !== undefined) checkTaxRuleRegime(named, regime, tax.scope, tax.regimeMessage);
  const rule = args.taxRuleId === undefined ? storedRule : taxRuleFor(args.taxRuleId, tax.scope);
  const taxChanged = args.taxRuleId !== undefined || args.taxText !== undefined;
  if (rule === undefined && (args.positions !== undefined || taxChanged)) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "The stored tax setting of this draft is not a tax rule this server knows (e.g. a " +
        "custom tax set), so the positions cannot be checked against it. Pass taxRuleId as well.",
    });
  }
  if (rule !== undefined && tax.useCase !== undefined) {
    checkTaxRuleUseCase(rule, tax.useCase.label, tax.useCase.noun);
  }
  let positions: DraftPosition[] | undefined;
  if (args.positions !== undefined && rule !== undefined) {
    positions = toDraftPositions(
      args.positions,
      resolveTaxRates(rule, args.positions, tax.rateLimit, regime),
    );
  } else if (args.taxRuleId !== undefined && rule !== undefined) {
    // The stored positions stay: each must be allowed by the new rule.
    resolveTaxRates(
      rule,
      storedPositions.map((row) => ({ taxRate: row.taxRate })),
      tax.rateLimit,
      regime,
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
          args.taxText ?? (args.taxRuleId === undefined ? cleanStored(stored.taxText) : undefined),
          regime,
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
    regime,
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
      ...(regime === undefined && (taxChanged || positions !== undefined)
        ? [UNKNOWN_REGIME_WARNING]
        : []),
      ...(args.taxRuleId === undefined &&
      rule !== undefined &&
      regime !== undefined &&
      !rule.regimes.includes(regime)
        ? [keptRuleWarning(rule, regime)]
        : []),
      ...(rule !== undefined && (taxChanged || positions !== undefined)
        ? taxRuleWarnings(rule, regime)
        : []),
      ...(currency !== storedCurrency ? currencyWarnings(currency) : []),
    ],
  };
}

/** Warning for a stored tax rule the update keeps although it does not fit the account. */
function keptRuleWarning(rule: TaxRule, regime: TaxRegime): string {
  const fix =
    regime === "small_business"
      ? `taxRuleId ${SMALL_BUSINESS_RULE_ID} (Kleinunternehmer, §19 UStG) with 0 % rates`
      : `taxRuleId ${DEFAULT_TAX_RULE_ID} (Umsatzsteuerpflichtige Umsätze) or another rule for ` +
        "regular VAT";
  const account =
    regime === "small_business"
      ? "the Kleinunternehmer regulation (§19 UStG)"
      : "regular VAT, not the Kleinunternehmer regulation";
  return (
    `The draft keeps tax rule ${rule.id} (${rule.nameDe}), which does not fit this account's ` +
    `VAT regulation (${account}): sevDesk will refuse to finalize it. Pass ${fix} to fix it.`
  );
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
      message: "This draft has no tax setting this server can keep. Pass taxRuleId to set one.",
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
