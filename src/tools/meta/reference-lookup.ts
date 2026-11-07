import { z } from "zod";

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
] as const;
type LookupKind = (typeof LOOKUP_KINDS)[number];

const taxRuleItem = z.object({
  id: z.number().int(),
  code: z.string(),
  nameDe: z.string(),
  nameEn: z.string(),
  direction: z.enum(["revenue", "expense", "either"]),
  regimes: z.array(z.enum(["regular", "small_business"])),
  allowedTaxRates: z.array(z.number()).optional(),
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
    "units (Einheiten) and payment_methods (Zahlungsarten). Use query to filter by a " +
    "case-insensitive substring of names, codes or ids.",
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
  }),
  output,
  handler: async (args, ctx) => {
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

async function lookup(
  kind: LookupKind,
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
          : { allowedTaxRates: [...rule.allowedTaxRates] }),
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
