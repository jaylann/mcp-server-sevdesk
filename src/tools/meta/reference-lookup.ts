import { z } from "zod";

import { cleanText, compact } from "../../domain/common.js";
import {
  customFieldSettingDtoSchema,
  listCustomFieldSettings,
} from "../../domain/contact-custom-fields.js";
import { costCentreDtoSchema, listCostCentres } from "../../domain/cost-centres.js";
import { listLetterpapers, listTemplates } from "../../domain/layouts.js";
import type { SalesKind } from "../../domain/lifecycle/documents.js";
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
import { listTextTemplates } from "../../domain/text-templates.js";
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
  "cost_centres",
  "receipt_guidance",
  "letterpapers",
  "templates",
  "text_templates",
  "contact_custom_fields",
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

/** The document types of kinds `templates` and `text_templates`. */
const DOCUMENT_TYPE_ARGS = ["invoice", "order", "credit_note"] as const;
type DocumentTypeArg = (typeof DOCUMENT_TYPE_ARGS)[number];

const DOCUMENT_TYPE_KINDS: Readonly<Record<DocumentTypeArg, SalesKind>> = {
  invoice: "invoice",
  order: "order",
  credit_note: "creditNote",
};

/**
 * The text template type (`objectType`) the draft tools resolve each document type against:
 * invoices `RE`, orders `AN` (the only order type text templates carry, D-115). Credit notes have
 * no known type and are refused.
 */
const TEXT_TEMPLATE_TYPES: Readonly<Record<Exclude<DocumentTypeArg, "credit_note">, string>> = {
  invoice: "RE",
  order: "AN",
};

/** Characters of a text template's text the lookup shows. */
const TEXT_TEMPLATE_PREVIEW = 1000;

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

const letterpaperItem = z.object({
  id: z.string().describe("Pass as letterpaper to sevdesk_document_set_layout."),
  name: z.string().optional(),
  default: z.boolean().describe("The account's default letterhead."),
  custom: z.boolean().optional().describe("An own upload (sevDesk's isCustom)."),
  stock: z.boolean().describe("One of sevDesk's own entries."),
});

const templateItem = z.object({
  id: z.string().describe("Pass as template to sevdesk_document_set_layout."),
  name: z.string().optional(),
  type: z.string().optional().describe("sevDesk's document type: Invoice, Order or Creditnote."),
  default: z.boolean().describe("The default template of this document type."),
  custom: z.boolean().optional().describe("An own template (sevDesk's isCustom)."),
  premium: z.boolean().optional(),
  stock: z.boolean().describe("One of sevDesk's own templates."),
});

const textTemplateItem = z.object({
  id: z.number().int(),
  name: z.string().optional().describe("Pass as headTextTemplate or footTextTemplate."),
  textType: z.string().optional().describe("HEAD (Kopftext), FOOT (Fußtext), TEXT (e-mail)."),
  documentType: z
    .string()
    .optional()
    .describe("sevDesk's objectType: RE invoice, AN offer, MA reminder, ALL, …"),
  category: z.string().optional().describe("DOCUMENT or MAIL."),
  default: z.boolean().describe("The default text of its type (sevDesk's main)."),
  text: z
    .string()
    .optional()
    .describe(`The text, up to ${String(TEXT_TEMPLATE_PREVIEW)} chars.`),
});

const output = z.object({
  kind: z.enum(LOOKUP_KINDS),
  source: z
    .enum(["reference", "sevdesk"])
    .describe("reference: built-in, verified list; sevdesk: fetched from the account."),
  total: z.number().int().describe("Entries before the query filter."),
  returned: z.number().int(),
  hasMore: z
    .boolean()
    .describe("Another local page is available at nextOffset; separate from upstream truncation."),
  limit: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Effective receipt_guidance page size; null for unpaged kinds."),
  truncated: z.boolean().describe("True when sevDesk reported more entries than were fetched."),
  taxRules: z.array(taxRuleItem).optional(),
  contactCategories: z.array(contactCategoryItem).optional(),
  statusCodes: z.array(statusCodeItem).optional(),
  documentTypes: z.array(documentTypeItem).optional(),
  users: z.array(userDtoSchema).optional(),
  countries: z.array(countryItem).optional(),
  units: z.array(unitItem).optional(),
  paymentMethods: z.array(paymentMethodItem).optional(),
  costCentres: z
    .array(costCentreDtoSchema)
    .optional()
    .describe("Kind cost_centres: the account's Kostenstellen."),
  contactCustomFields: z
    .array(customFieldSettingDtoSchema)
    .optional()
    .describe("Kind contact_custom_fields: the account's custom contact fields (Kontaktfelder)."),
  receiptGuidance: z
    .array(receiptGuidanceItem)
    .optional()
    .describe("Kind receipt_guidance: one page of accounts, filtered."),
  letterpapers: z.array(letterpaperItem).optional(),
  templates: z.array(templateItem).optional(),
  textTemplates: z.array(textTemplateItem).optional(),
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
    "units (Einheiten), payment_methods (Zahlungsarten), cost_centres (Kostenstellen: id, " +
    "number, name) and receipt_guidance (Kontierungshilfe: " +
    "which booking account (accountDatev) allows which tax rules and tax rates for expense or " +
    "revenue receipts (Belege); filter with accountNumber, taxRuleId and receiptType, paged " +
    "with limit/offset), letterpapers (Briefpapiere), templates (Vorlagen, with documentType), " +
    "text_templates (Textvorlagen: head and foot texts, documentType optional) and " +
    "contact_custom_fields (the custom contact fields, Kontaktfelder, defined in the sevDesk web " +
    "app; their ids go into customFields of the contact tools). Use query to filter by a " +
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
    documentType: z
      .enum(DOCUMENT_TYPE_ARGS)
      .optional()
      .describe("templates (required) and text_templates: invoice, order or credit_note."),
  }),
  output,
  handler: async (args, ctx) => {
    if (args.kind === "receipt_guidance") {
      if (args.documentType !== undefined) {
        throw new SevdeskError({
          kind: "validation",
          message: "documentType only applies to kind=templates and kind=text_templates.",
        });
      }
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
    if (args.kind === "templates" || args.kind === "text_templates") {
      const data = await lookupLayout(args.kind, args.documentType, args.query, ctx);
      return { data, summary: lookupSummary(data, args.kind, args.query) };
    }
    if (args.documentType !== undefined) {
      throw new SevdeskError({
        kind: "validation",
        message: `documentType only applies to kind=templates and kind=text_templates; leave it out for kind=${args.kind}.`,
      });
    }
    const data = await lookup(args.kind, args.query, ctx);
    return { data, summary: lookupSummary(data, args.kind, args.query) };
  },
});

/** "3 of 21 templates matching the query." for the unpaged kinds. */
function lookupSummary(data: LookupOutput, kind: LookupKind, query: string | undefined): string {
  const filtered = query === undefined ? "" : " matching the query";
  return (
    `${data.returned} of ${data.total} ${kind.replaceAll("_", " ")}${filtered}` +
    `${data.truncated ? " (sevDesk has more than could be fetched)" : ""}.`
  );
}

/**
 * Kinds `templates` (one document type, required) and `text_templates` (all, or those of one
 * document type). Base64 thumbnails, PDFs and HTML never leave `listTemplates`; a text template's
 * text is cut to {@link TEXT_TEMPLATE_PREVIEW} characters.
 */
async function lookupLayout(
  kind: "templates" | "text_templates",
  documentType: DocumentTypeArg | undefined,
  query: string | undefined,
  ctx: ToolContext,
): Promise<LookupOutput> {
  const keep = matcher(query);
  if (kind === "templates") {
    if (documentType === undefined) {
      throw new SevdeskError({
        kind: "validation",
        message: "kind=templates needs documentType (invoice, order or credit_note).",
      });
    }
    const list = await listTemplates(ctx.client, DOCUMENT_TYPE_KINDS[documentType], ctx.signal);
    const templates = list
      .filter((item) => keep(item.id, item.name, item.type))
      .map((item) =>
        compact({
          id: item.id,
          name: item.name,
          type: item.type,
          default: item.isDefault,
          custom: item.custom,
          premium: item.premium,
          stock: item.stock,
        }),
      );
    return { ...counts(kind, "sevdesk", list.length, templates.length), templates };
  }
  if (documentType === "credit_note") {
    throw new SevdeskError({
      kind: "validation",
      message:
        "Text templates of credit notes are not offered: their type code in sevDesk is not " +
        "known yet. Leave documentType out to list every text template.",
    });
  }
  const type = documentType === undefined ? undefined : TEXT_TEMPLATE_TYPES[documentType];
  const list = await listTextTemplates(ctx.client, ctx.signal);
  const textTemplates = list.items
    .filter(
      (item) =>
        (type === undefined || item.objectType === type) &&
        keep(item.id, item.name, item.textType, item.objectType, item.category),
    )
    .map((item) =>
      compact({
        id: item.id,
        name: item.name,
        textType: item.textType,
        documentType: item.objectType,
        category: item.category,
        default: item.isDefault,
        text: cleanText(item.text, TEXT_TEMPLATE_PREVIEW),
      }),
    );
  return {
    kind,
    source: "sevdesk",
    total: list.total,
    returned: textTemplates.length,
    truncated: list.truncated,
    hasMore: false,
    limit: null,
    textTemplates,
  };
}

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
    limit,
    hasMore: end < matches.length,
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
  kind: Exclude<LookupKind, "receipt_guidance" | "templates" | "text_templates">,
  query: string | undefined,
  ctx: ToolContext,
): Promise<LookupOutput> {
  const keep = matcher(query);
  switch (kind) {
    case "letterpapers": {
      const list = await listLetterpapers(ctx.client, ctx.signal);
      const letterpapers = list
        .filter((item) => keep(item.id, item.name))
        .map((item) =>
          compact({
            id: item.id,
            name: item.name,
            default: item.isDefault,
            custom: item.custom,
            stock: item.stock,
          }),
        );
      return { ...counts(kind, "sevdesk", list.length, letterpapers.length), letterpapers };
    }
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
    case "cost_centres": {
      const list = await listCostCentres(ctx.client, ctx.signal);
      const costCentres = list.items
        .filter((centre) => keep(centre.id, centre.number, centre.name))
        .map((centre) => ({ ...centre }));
      // The domain's flag: it also counts a full page without `total` as cut.
      return { ...upstreamCounts(kind, list, costCentres.length, list.truncated), costCentres };
    }
    case "contact_custom_fields": {
      const list = await listCustomFieldSettings(ctx.client, ctx.signal);
      const contactCustomFields = list.items
        .filter((setting) => keep(setting.id, setting.name, setting.description))
        .map((setting) => ({ ...setting }));
      // The domain's flag, like the cost centres: a full page without `total` counts as cut.
      return {
        ...upstreamCounts(kind, list, contactCustomFields.length, list.truncated),
        contactCustomFields,
      };
    }
  }
}

function counts(
  kind: LookupKind,
  source: "reference" | "sevdesk",
  total: number,
  returned: number,
) {
  return { kind, source, total, returned, truncated: false, hasMore: false, limit: null };
}

/**
 * The counts of a list read from sevDesk. `truncated` defaults to "sevDesk's total is larger than
 * what was read"; a domain reader that knows better (a full page without `total`) passes its own.
 */
function upstreamCounts(
  kind: LookupKind,
  list: { readonly items: readonly unknown[]; readonly total: number },
  returned: number,
  truncated = list.total > list.items.length,
) {
  return {
    kind,
    source: "sevdesk" as const,
    total: list.total,
    returned,
    truncated,
    hasMore: false,
    limit: null,
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
