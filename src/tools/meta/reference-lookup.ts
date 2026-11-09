import { z } from "zod";

import { compact } from "../../domain/common.js";
import { loadReceiptGuidance, RECEIPT_TYPES } from "../../domain/receipt-guidance.js";
import {
  CONTACT_CATEGORIES,
  CONTACT_CATEGORY_KEYS,
  DOCUMENT_TYPES,
  listCountries,
  listPaymentMethods,
  listUnits,
  STATUS_CODES,
  STATUS_OBJECT_TYPES,
  TAX_RULES,
} from "../../domain/reference-data.js";
import { listUsers, userDtoSchema } from "../../domain/users.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineTool } from "../define-tool.js";
import type { ToolContext } from "../types.js";

const LOOKUP_KINDS = [
  "tax_rules",
  "contact_categories",
  "status_codes",
  "document_types",
  "users",
  "countries",
  "units",
  "payment_methods",
  "receipt_guidance",
] as const;
type LookupKind = (typeof LOOKUP_KINDS)[number];

/** Default and maximum page size of kind `receipt_guidance` (the other kinds are not paged). */
const GUIDANCE_PAGE = { limit: 25, max: 100 } as const;
/** Arguments that only apply to kind `receipt_guidance`. */
const GUIDANCE_ONLY_ARGS = [
  "accountNumber",
  "taxRuleId",
  "receiptType",
  "limit",
  "offset",
] as const;

const taxRuleItem = z.object({
  id: z.number().int(),
  code: z.string(),
  nameDe: z.string(),
  nameEn: z.string(),
  direction: z.enum(["revenue", "expense", "either"]),
  regimes: z.array(z.enum(["regular", "small_business"])),
  allowedTaxRates: z
    .array(z.string())
    .optional()
    .describe("Tax rates in percent the rule allows in positions, e.g. '19'."),
  legacyTaxType: z.string().optional(),
  notSupportedFor: z.array(z.string()).optional(),
  documented: z.boolean().describe("False: exists in sevDesk but missing from the API docs."),
  note: z.string().optional(),
});

const contactCategoryItem = z.object({
  id: z.number().int(),
  key: z.enum(CONTACT_CATEGORY_KEYS),
  name: z.string(),
  nameEn: z.string(),
});

const statusCodeItem = z.object({
  objectType: z.enum(STATUS_OBJECT_TYPES),
  code: z.number().int(),
  label: z.string(),
  labelDe: z.string(),
  note: z.string().optional(),
});

const documentTypeItem = z.object({
  objectType: z.enum(["invoice", "order", "voucher"]),
  code: z.string(),
  label: z.string(),
  labelDe: z.string(),
});

const countryItem = z.object({
  id: z.number().int(),
  code: z.string().optional(),
  name: z.string(),
  nameEn: z.string().optional(),
});

const unitItem = z.object({
  id: z.number().int(),
  name: z.string(),
  uneceCode: z.string().optional(),
});

const paymentMethodItem = z.object({
  id: z.number().int(),
  name: z.string(),
  text: z.string().optional(),
});

const receiptGuidanceItem = z.object({
  accountDatevId: z
    .number()
    .int()
    .describe("Booking account id (accountDatev) to use in voucher positions."),
  accountNumber: z.string().optional().describe("Number in the chart of accounts (SKR03/04)."),
  accountName: z.string().optional(),
  description: z.string().optional().describe("What the account is for, as sevDesk says."),
  receiptTypes: z.array(z.enum(RECEIPT_TYPES)).describe("expense (Ausgabe), revenue (Einnahme)."),
  taxRules: z
    .array(
      z.object({
        id: z.number().int().describe("Tax rule id (Steuerregel), see kind=tax_rules."),
        code: z.string().optional(),
        taxRates: z.array(z.string()).describe("Allowed tax rates in percent, e.g. '19'."),
        unknownTaxRates: z
          .array(z.string())
          .optional()
          .describe("Rate values sevDesk sent that this server cannot read."),
      }),
    )
    .describe("Tax rules this account allows, each with its allowed tax rates."),
});

const output = z.object({
  kind: z.enum(LOOKUP_KINDS),
  source: z
    .enum(["reference", "sevdesk"])
    .describe("reference: built-in, verified list; sevdesk: fetched from the account."),
  total: z.number().int().describe("Entries before the query filter."),
  returned: z.number().int(),
  truncated: z.boolean().describe("True when sevDesk reported more entries than were fetched."),
  taxRules: z.array(taxRuleItem).optional(),
  contactCategories: z.array(contactCategoryItem).optional(),
  statusCodes: z.array(statusCodeItem).optional(),
  documentTypes: z.array(documentTypeItem).optional(),
  users: z.array(userDtoSchema).optional(),
  countries: z.array(countryItem).optional(),
  units: z.array(unitItem).optional(),
  paymentMethods: z.array(paymentMethodItem).optional(),
  receiptGuidance: z
    .array(receiptGuidanceItem)
    .optional()
    .describe("Kind receipt_guidance: one page of accounts, filtered."),
  matched: z
    .number()
    .int()
    .optional()
    .describe("Kind receipt_guidance: entries matching the filters, before paging."),
  offset: z.number().int().optional().describe("Kind receipt_guidance: offset of this page."),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe("Kind receipt_guidance: pass as offset for the next page; absent on the last page."),
});

type LookupOutput = z.output<typeof output>;

/** `sevdesk_reference_lookup`: ids and codes other tools need, instead of guessing them. */
export const referenceLookupTool = defineTool({
  name: "sevdesk_reference_lookup",
  title: "Look up sevDesk ids and codes",
  description:
    "Look up the ids and codes other sevDesk tools need instead of guessing them: tax_rules " +
    "(Steuerregeln for Update 2.0, e.g. 1 = steuerpflichtig, 11 = Kleinunternehmer §19), " +
    "contact_categories (Kunde, Lieferant, …), status_codes (Entwurf, offen, bezahlt per " +
    "document type), document_types (RE, AN, …), users (SevUser), countries (StaticCountry), " +
    "units (Einheiten), payment_methods (Zahlungsarten) and receipt_guidance (Kontierungshilfe: " +
    "which booking account (accountDatev) allows which tax rules and tax rates for expense or " +
    "revenue receipts (Belege); filter with accountNumber, taxRuleId and receiptType, paged " +
    "with limit/offset). Use query to filter by a case-insensitive substring of names, codes " +
    "or ids.",
  toolset: "meta",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    kind: z.enum(LOOKUP_KINDS).describe("Which list to return."),
    query: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Case-insensitive substring filter on names, codes and ids, e.g. 'reverse'."),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{1,12}$/, "expected an account number such as 4400")
      .optional()
      .describe("receipt_guidance only: exact account number in the chart of accounts."),
    taxRuleId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("receipt_guidance only: accounts that allow this tax rule id."),
    receiptType: z
      .enum(RECEIPT_TYPES)
      .optional()
      .describe("receipt_guidance only: accounts for expense or revenue receipts."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(GUIDANCE_PAGE.max)
      .optional()
      .describe(
        `receipt_guidance only: page size, 1–${GUIDANCE_PAGE.max} (default ${GUIDANCE_PAGE.limit}).`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("receipt_guidance only: entries to skip; pass the previous nextOffset."),
  }),
  output,
  handler: async (args, ctx) => {
    if (args.kind === "receipt_guidance") {
      const data = await lookupReceiptGuidance(args, ctx);
      return { data, summary: receiptGuidanceSummary(data) };
    }
    const misplaced = GUIDANCE_ONLY_ARGS.filter((key) => args[key] !== undefined);
    if (misplaced.length > 0) {
      throw new SevdeskError({
        kind: "validation",
        message: `${misplaced.join(", ")} only apply to kind=receipt_guidance; leave them out for kind=${args.kind}.`,
      });
    }
    const data = await lookup(args.kind, args.query, ctx);
    const filtered = args.query === undefined ? "" : " matching the query";
    return {
      data,
      summary:
        `${data.returned} of ${data.total} ${args.kind.replaceAll("_", " ")}${filtered}` +
        `${data.truncated ? " (sevDesk has more than could be fetched)" : ""}.`,
    };
  },
});

type LookupArgs = z.output<typeof referenceLookupTool.input>;

/**
 * Kind `receipt_guidance`: the account's cached `forAllAccounts` guidance (see
 * `loadReceiptGuidance`), filtered here by account number, tax rule, receipt type and query, then
 * paged. `total` counts all accounts, `matched` those that pass the filters.
 */
async function lookupReceiptGuidance(args: LookupArgs, ctx: ToolContext): Promise<LookupOutput> {
  const list = await loadReceiptGuidance(
    ctx.client,
    { kind: "all" },
    { cacheOwner: ctx.config, signal: ctx.signal },
  );
  const keep = matcher(args.query);
  const matches = list.guides.filter(
    (guide) =>
      (args.accountNumber === undefined || guide.accountNumber === args.accountNumber) &&
      (args.taxRuleId === undefined || guide.taxRules.some((rule) => rule.id === args.taxRuleId)) &&
      (args.receiptType === undefined || guide.receiptTypes.includes(args.receiptType)) &&
      keep(
        guide.accountDatevId,
        guide.accountNumber,
        guide.accountName,
        guide.description,
        ...guide.taxRules.map((rule) => rule.code),
      ),
  );
  const offset = args.offset ?? 0;
  const limit = args.limit ?? GUIDANCE_PAGE.limit;
  const page = matches.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    kind: "receipt_guidance",
    source: "sevdesk",
    total: list.guides.length,
    returned: page.length,
    truncated: list.truncated,
    matched: matches.length,
    offset,
    ...(end < matches.length ? { nextOffset: end } : {}),
    receiptGuidance: page.map((guide) =>
      compact({
        accountDatevId: guide.accountDatevId,
        accountNumber: guide.accountNumber,
        accountName: guide.accountName,
        description: guide.description,
        receiptTypes: [...guide.receiptTypes],
        taxRules: guide.taxRules.map((rule) =>
          compact({
            id: rule.id,
            code: rule.code,
            taxRates: rule.taxRates.map(String),
            unknownTaxRates:
              rule.unknownTaxRates.length === 0 ? undefined : [...rule.unknownTaxRates],
          }),
        ),
      }),
    ),
  };
}

function receiptGuidanceSummary(data: LookupOutput): string {
  const more =
    data.nextOffset === undefined ? "" : ` More: call again with offset ${data.nextOffset}.`;
  const truncated = data.truncated ? " sevDesk has more accounts than could be fetched." : "";
  return (
    `${data.returned} of ${data.matched ?? 0} matching receipt guidance accounts ` +
    `(${data.total} in total).${more}${truncated}`
  );
}

async function lookup(
  kind: Exclude<LookupKind, "receipt_guidance">,
  query: string | undefined,
  ctx: ToolContext,
): Promise<LookupOutput> {
  const keep = matcher(query);
  switch (kind) {
    case "tax_rules": {
      const items = TAX_RULES.map((rule) => ({
        id: rule.id,
        code: rule.code,
        nameDe: rule.nameDe,
        nameEn: rule.nameEn,
        direction: rule.direction,
        regimes: [...rule.regimes],
        ...(rule.allowedTaxRates === undefined
          ? {}
          : { allowedTaxRates: rule.allowedTaxRates.map(String) }),
        ...(rule.legacyTaxType === undefined ? {} : { legacyTaxType: rule.legacyTaxType }),
        ...(rule.notSupportedFor === undefined
          ? {}
          : { notSupportedFor: [...rule.notSupportedFor] }),
        documented: rule.documented,
        ...(rule.note === undefined ? {} : { note: rule.note }),
      }));
      const taxRules = items.filter((rule) =>
        keep(rule.id, rule.code, rule.nameDe, rule.nameEn, rule.direction, rule.note),
      );
      return { ...counts(kind, "reference", items.length, taxRules.length), taxRules };
    }
    case "contact_categories": {
      const contactCategories = CONTACT_CATEGORIES.filter((category) =>
        keep(category.id, category.key, category.name, category.nameEn),
      ).map((category) => ({ ...category }));
      return {
        ...counts(kind, "reference", CONTACT_CATEGORIES.length, contactCategories.length),
        contactCategories,
      };
    }
    case "status_codes": {
      const statusCodes = STATUS_CODES.filter((status) =>
        keep(status.code, status.objectType, status.label, status.labelDe),
      ).map((status) => ({ ...status }));
      return {
        ...counts(kind, "reference", STATUS_CODES.length, statusCodes.length),
        statusCodes,
      };
    }
    case "document_types": {
      const documentTypes = DOCUMENT_TYPES.filter((type) =>
        keep(type.code, type.objectType, type.label, type.labelDe),
      ).map((type) => ({ ...type }));
      return {
        ...counts(kind, "reference", DOCUMENT_TYPES.length, documentTypes.length),
        documentTypes,
      };
    }
    case "users": {
      const list = await listUsers(ctx.client, ctx.signal);
      const users = list.items.filter((user) => keep(user.id, user.name, user.email));
      return { ...upstreamCounts(kind, list, users.length), users };
    }
    case "countries": {
      const list = await listCountries(ctx.client, ctx.signal);
      const countries = list.items
        .filter((country) => keep(country.id, country.code, country.name, country.nameEn))
        .map((country) => ({ ...country }));
      return { ...upstreamCounts(kind, list, countries.length), countries };
    }
    case "units": {
      const list = await listUnits(ctx.client, ctx.signal);
      const units = list.items
        .filter((unit) => keep(unit.id, unit.name, unit.uneceCode))
        .map((unit) => ({ ...unit }));
      return { ...upstreamCounts(kind, list, units.length), units };
    }
    case "payment_methods": {
      const list = await listPaymentMethods(ctx.client, ctx.signal);
      const paymentMethods = list.items
        .filter((method) => keep(method.id, method.name, method.text))
        .map((method) => ({ ...method }));
      return { ...upstreamCounts(kind, list, paymentMethods.length), paymentMethods };
    }
  }
}

function counts(
  kind: LookupKind,
  source: "reference" | "sevdesk",
  total: number,
  returned: number,
) {
  return { kind, source, total, returned, truncated: false };
}

function upstreamCounts(
  kind: LookupKind,
  list: { readonly items: readonly unknown[]; readonly total: number },
  returned: number,
) {
  return {
    kind,
    source: "sevdesk" as const,
    total: list.total,
    returned,
    truncated: list.total > list.items.length,
  };
}

/** Case-insensitive substring match over the given fields; no query keeps everything. */
function matcher(query: string | undefined) {
  const needle = query?.toLocaleLowerCase("de-DE");
  return (...fields: readonly (string | number | undefined)[]): boolean =>
    needle === undefined ||
    fields.some(
      (field) => field !== undefined && String(field).toLocaleLowerCase("de-DE").includes(needle),
    );
}
