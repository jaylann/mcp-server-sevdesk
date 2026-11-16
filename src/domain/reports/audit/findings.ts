/**
 * What every check of `sevdesk_records_audit` returns. A check answers "what is wrong?" with
 * findings: the kind of finding (`code`), how sure it is (`severity`), a reason that cites the
 * law, what to check or do, the contact and the documents concerned (ids, numbers, deep links
 * into the web app) and their amounts. Findings are hints computed from sevDesk data, never tax
 * advice: whether a booking is wrong often depends on facts sevDesk does not hold (the contract,
 * where a service was performed, the supplier's registrations), and the finding then says what to
 * check instead of asserting an error. Every result says so in English and German.
 *
 * Trusted and untrusted text: `title`, `titleDe`, `reason`, `action` and the notes are written
 * here and never contain sevDesk text. Contact names, VAT ids and document numbers come from
 * sevDesk (sanitized by the mappers) and appear only as values of their own fields.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../../sevdesk/types.js";
import type { TaxRegime } from "../../account-settings.js";
import { compact, moneySchema } from "../../common.js";
import { contactLink, creditNoteLink, invoiceLink, voucherLink } from "../../links.js";
import { add, type Decimal, decimal, DEFAULT_CURRENCY, type Money, money } from "../../money.js";
import { taxRuleById } from "../../reference-data.js";
import {
  type DocumentHeader,
  type HeaderList,
  MAX_SCAN_DOCUMENTS,
  refOf,
} from "../positions-scan.js";
import { plural, REPORT_SCAN_MAX, type ReportRunOptions } from "../shared.js";
import type { ReportPeriod } from "../vat.js";

/** Documents listed per finding (the count and the sums cover all of them). */
export const MAX_FINDING_RECORDS = 20;
/** Findings one audit returns; more are counted in `findingsOmitted`. */
export const MAX_FINDINGS = 100;

/** Stated in every audit result (English). */
export const AUDIT_CAVEAT =
  "Hints computed by this server from sevDesk data, not tax advice: each finding says what to " +
  "check. Whether a booking is wrong often depends on facts sevDesk does not hold (the contract, " +
  "where a service was performed, the other side's registrations); ask your tax adviser " +
  "(Steuerberater) when in doubt.";

/** Stated in every audit result (German). */
export const AUDIT_CAVEAT_DE =
  "Hinweise, die dieser Server aus den sevDesk-Daten berechnet, keine Steuerberatung: Jeder " +
  "Befund sagt, was zu prüfen ist. Ob eine Buchung falsch ist, hängt oft von Tatsachen ab, die " +
  "sevDesk nicht kennt (Vertrag, Ort der Leistung, Registrierungen der Gegenseite); im Zweifel " +
  "die Steuerberatung fragen.";

const AUDIT_SEVERITIES = ["warning", "check"] as const;
type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** The words of one kind of finding: trusted text only. */
export interface FindingText {
  readonly severity: AuditSeverity;
  readonly title: string;
  readonly titleDe: string;
  /** Why, with the legal basis. */
  readonly reason: string;
  /** What to check or do. */
  readonly action: string;
}

/** The customer or supplier of a finding, as far as sevDesk knows it. */
export interface AuditContact {
  readonly id?: number | undefined;
  /** Text from sevDesk, sanitized. */
  readonly name?: string | undefined;
  /** USt-IdNr. as stored, normalized (upper case, no spaces). */
  readonly vatId?: string | undefined;
  /** ISO codes of the contact's addresses and the document address. */
  readonly countries?: readonly string[] | undefined;
}

/** One document a check flags; {@link buildFindings} groups them by kind and contact. */
export interface FindingDraft {
  /** Stable kind of finding, e.g. `foreign_supplier_charged_german_vat`. */
  readonly code: string;
  readonly text: FindingText;
  readonly contact: AuditContact | undefined;
  readonly header: DocumentHeader;
}

// ---------------------------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------------------------

export const taxRuleRefSchema = z.object({
  id: z.number().int(),
  name: z.string().optional().describe("German name (Steuerregel)."),
});

export const auditRecordSchema = z.object({
  objectName: z.enum(["Invoice", "CreditNote", "Voucher"]),
  id: z.number().int(),
  number: z
    .string()
    .optional()
    .describe("Rechnungs-, Gutschrifts- or Belegnummer (text from sevDesk)."),
  date: z.string().optional().describe("Document date, YYYY-MM-DD."),
  taxPoint: z
    .string()
    .optional()
    .describe("Day the tax arose (accrual, as in sevdesk_vat_summary), YYYY-MM-DD."),
  taxRule: taxRuleRefSchema.optional(),
  contact: z
    .object({ id: z.number().int().optional(), name: z.string().optional() })
    .optional()
    .describe("Customer or supplier; the name is text from sevDesk."),
  net: moneySchema.optional().describe("Net in EUR."),
  tax: moneySchema
    .optional()
    .describe("VAT in EUR as on the document; in reverseCharge the tax owed as recipient."),
  link: z.string().optional().describe("Opens the document in the sevDesk web app."),
});

export type AuditRecord = z.output<typeof auditRecordSchema>;

const auditContactSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional().describe("Name in sevDesk (text from sevDesk)."),
  vatId: z.string().optional().describe("USt-IdNr. as stored in sevDesk."),
  countries: z
    .array(z.string())
    .optional()
    .describe("ISO codes of the contact's addresses and of the document address."),
  link: z.string().optional().describe("Opens the contact in the sevDesk web app."),
});

export const auditFindingSchema = z.object({
  check: z.string().describe("The check that found it."),
  code: z
    .string()
    .describe("Kind of finding, stable; new codes may be added, treat an unknown one as other."),
  severity: z
    .enum(AUDIT_SEVERITIES)
    .describe(
      "warning: the data points to a wrong booking. check: it depends on facts sevDesk does " +
        "not hold; action says what to check.",
    ),
  title: z.string(),
  titleDe: z.string().describe("The title in German."),
  reason: z.string().describe("Why, with the legal basis."),
  action: z.string().describe("What to check or do."),
  contact: auditContactSchema.optional(),
  documents: z.number().int().describe("Documents of this finding."),
  records: z
    .array(auditRecordSchema)
    .describe(`The documents by date, at most ${String(MAX_FINDING_RECORDS)}.`),
  recordsOmitted: z.number().int().optional().describe("Documents not listed in records."),
  net: moneySchema
    .optional()
    .describe("Sum of the documents' net in EUR (documents without EUR values left out)."),
  tax: moneySchema.optional().describe("Sum of the documents' VAT in EUR."),
});

export type AuditFinding = z.output<typeof auditFindingSchema>;

export const auditCoverageSchema = z.object({
  rowsRead: z.number().int().describe("Document rows listed from sevDesk."),
  documentsInScope: z
    .number()
    .int()
    .describe("Documents this check looks at (in the period, under a tax rule it checks)."),
  documentsChecked: z.number().int().describe("Documents checked in full."),
  documentsLeftOut: z
    .number()
    .int()
    .describe(
      "Documents in scope not checked: a cap or the time budget stopped reading, or a " +
        "foreign-currency document has no EUR values.",
    ),
  notJudged: z
    .number()
    .int()
    .optional()
    .describe(
      "vat: documents whose contact has no usable data (no VAT id, no address) or German and " +
        "foreign data at once, so where it is established could not be told.",
    ),
  truncated: z
    .boolean()
    .describe(
      `True when a cap (${String(MAX_SCAN_DOCUMENTS)} documents, ${String(REPORT_SCAN_MAX)} rows) ` +
        "or the time budget left documents out: findings may be missing.",
    ),
  timeBudgetReached: z
    .boolean()
    .optional()
    .describe(
      "True when this server stopped reading to answer within its time limit (HTTP " +
        "deployments): narrow the period.",
    ),
  excluded: z
    .object({
      drafts: z.number().int(),
      recurringTemplates: z.number().int(),
      reminders: z.number().int(),
      unknownDirection: z.number().int(),
    })
    .describe("Listed documents no check looks at."),
  contacts: z
    .object({
      read: z.number().int(),
      addressesRead: z.number().int(),
      truncated: z.boolean(),
    })
    .optional()
    .describe("vat: the contact and address lists read to tell where contacts are established."),
});

export type AuditCoverage = z.output<typeof auditCoverageSchema>;

// ---------------------------------------------------------------------------------------------
// The contract of a check
// ---------------------------------------------------------------------------------------------

/** Caps of one audit run; tests lower them. */
interface AuditLimits {
  /** Document rows listed; defaults to the listing's cap. */
  readonly maxRows?: number | undefined;
  /** Documents whose positions are read; defaults to `MAX_SCAN_DOCUMENTS`. */
  readonly maxDocuments?: number | undefined;
  /** Rows of the contact and address lists; defaults to `REPORT_SCAN_MAX`. */
  readonly maxContactRows?: number | undefined;
}

/** What a check gets to run. */
export interface AuditCheckContext {
  readonly client: SevdeskClient;
  readonly period: ReportPeriod;
  /** Object the per-account caches belong to (tools pass `ctx.config`). */
  readonly cacheOwner: object;
  readonly options: ReportRunOptions;
  readonly limits?: AuditLimits | undefined;
  /** Berlin `YYYY-MM-DD` for the document mappers; tests pin it. */
  readonly today?: string | undefined;
}

/** What every check returns; a check may add its own section (see `registry.ts`). */
export interface AuditCheckResult {
  /** One per flagged document; grouped into findings by {@link buildFindings}. */
  readonly drafts: readonly FindingDraft[];
  readonly coverage: AuditCoverage;
  /** Trusted text. */
  readonly notes: readonly string[];
  /** The account's VAT regulation today, when the check read it. */
  readonly regime?: TaxRegime | undefined;
}

/** The `excluded` coverage block from a header listing. */
export function excludedOf(excluded: HeaderList["excluded"]): AuditCoverage["excluded"] {
  return {
    drafts: excluded.draft,
    recurringTemplates: excluded.recurring_template,
    reminders: excluded.reminder,
    unknownDirection: excluded.unknown_direction,
  };
}

/** Trusted notes on a position scan that did not read everything it was asked to. */
export function scanNotes(input: {
  /** Documents not read because of the cap or the time budget. */
  readonly notRead: number;
  /** The cap that applied; defaults to `MAX_SCAN_DOCUMENTS`. */
  readonly maxDocuments?: number | undefined;
  readonly timedOut: boolean;
  readonly documentsRead: number;
  readonly documentsToRead: number;
  readonly positionsIncomplete: number;
  /** Foreign-currency documents without EUR values (never read). */
  readonly unconvertible: number;
}): string[] {
  const notes: string[] = [];
  if (input.timedOut) {
    notes.push(
      "This server stopped reading positions when its time budget for one request ran out " +
        `(${String(input.documentsRead)} of ${String(input.documentsToRead)} documents read; a ` +
        "request over HTTP must answer within two minutes): the rest was not checked. Use a " +
        "shorter period.",
    );
  } else if (input.notRead > 0) {
    notes.push(
      `The positions of ${plural(input.notRead, "document")} were not read (cap of ` +
        `${String(input.maxDocuments ?? MAX_SCAN_DOCUMENTS)} documents per request): they were ` +
        "not checked. Use a shorter period.",
    );
  }
  if (input.positionsIncomplete > 0) {
    notes.push(
      `The positions of ${plural(input.positionsIncomplete, "document")} could not all be read; ` +
        "they were checked on the positions that were read.",
    );
  }
  if (input.unconvertible > 0) {
    notes.push(
      `${plural(input.unconvertible, "foreign-currency document")} without EUR values in ` +
        `sevDesk ${input.unconvertible === 1 ? "was" : "were"} not checked.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Building findings
// ---------------------------------------------------------------------------------------------

/** EUR amount of an exact decimal. */
export function eur(value: Decimal): Money {
  return money(value, DEFAULT_CURRENCY);
}

/** A tax rule reference with its German name from `TAX_RULES`. */
export function taxRuleRef(id: number): z.output<typeof taxRuleRefSchema> {
  const rule = taxRuleById(id);
  return rule === undefined ? { id } : { id, name: rule.nameDe };
}

/** The deep link of a document, when the web app has a route for it. */
function documentLink(header: DocumentHeader): string | undefined {
  switch (header.kind) {
    case "invoice":
      return header.invoiceType === undefined
        ? undefined
        : invoiceLink(header.id, header.invoiceType, header.statusCode);
    case "credit_note":
      return creditNoteLink(header.id, header.statusCode);
    case "voucher":
      return voucherLink(header.id);
  }
}

/**
 * A document as findings and sections list it: reference, date, tax rule, link and, unless
 * `amounts` says otherwise, the EUR net and VAT of the document itself.
 */
export function recordOf(
  header: DocumentHeader,
  extra: {
    readonly net?: Decimal | undefined;
    readonly tax?: Decimal | undefined;
    readonly taxPoint?: string | undefined;
    /** List the contact on the record (sections; findings name it once). */
    readonly withContact?: boolean | undefined;
  } = {},
): AuditRecord {
  const net = extra.net ?? header.eur?.net;
  const tax = extra.tax ?? header.eur?.tax;
  const contact =
    extra.withContact === true && header.contact !== undefined
      ? compact({ id: header.contact.id, name: header.contact.name })
      : undefined;
  return compact({
    ...refOf(header),
    date: header.date,
    taxPoint: extra.taxPoint,
    taxRule: header.taxRuleId === undefined ? undefined : taxRuleRef(header.taxRuleId),
    contact: contact === undefined || Object.keys(contact).length === 0 ? undefined : contact,
    net: net === undefined ? undefined : eur(net),
    tax: tax === undefined ? undefined : eur(tax),
    link: documentLink(header),
  });
}

/** Documents by date, then id (stable output order). */
export function byDateThenId(a: DocumentHeader, b: DocumentHeader): number {
  return (a.date ?? "").localeCompare(b.date ?? "") || a.kind.localeCompare(b.kind) || a.id - b.id;
}

const SEVERITY_ORDER: Readonly<Record<AuditSeverity, number>> = { warning: 0, check: 1 };

/**
 * Groups `drafts` into findings, one per kind and contact (a supplier with twelve vouchers under
 * the same wrong treatment is one finding with twelve documents), lists at most
 * {@link MAX_FINDING_RECORDS} documents each and sums the EUR amounts of all of them. Sorted by
 * severity (warnings first), then kind, then contact id.
 */
export function buildFindings(check: string, drafts: readonly FindingDraft[]): AuditFinding[] {
  const groups = new Map<string, FindingDraft[]>();
  for (const draft of drafts) {
    const key = `${draft.code}|${String(draft.contact?.id ?? "none")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [draft]);
    else group.push(draft);
  }
  const findings: { finding: AuditFinding; contactId: number | undefined }[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    findings.push({ finding: toFinding(check, first, group), contactId: first.contact?.id });
  }
  return findings
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        a.finding.code.localeCompare(b.finding.code) ||
        (a.contactId ?? Number.MAX_SAFE_INTEGER) - (b.contactId ?? Number.MAX_SAFE_INTEGER),
    )
    .map((entry) => entry.finding);
}

function toFinding(
  check: string,
  first: FindingDraft,
  group: readonly FindingDraft[],
): AuditFinding {
  const headers = group.map((draft) => draft.header).sort(byDateThenId);
  let net: Decimal | undefined;
  let tax: Decimal | undefined;
  for (const header of headers) {
    if (header.eur === undefined) continue;
    net = add(net ?? decimal(0), header.eur.net);
    tax = add(tax ?? decimal(0), header.eur.tax);
  }
  const { contact } = first;
  const omitted = headers.length - MAX_FINDING_RECORDS;
  return compact({
    check,
    code: first.code,
    severity: first.text.severity,
    title: first.text.title,
    titleDe: first.text.titleDe,
    reason: first.text.reason,
    action: first.text.action,
    contact: contact === undefined ? undefined : contactOutput(contact),
    documents: headers.length,
    records: headers.slice(0, MAX_FINDING_RECORDS).map((header) => recordOf(header)),
    recordsOmitted: omitted > 0 ? omitted : undefined,
    net: net === undefined ? undefined : eur(net),
    tax: tax === undefined ? undefined : eur(tax),
  });
}

function contactOutput(contact: AuditContact): z.output<typeof auditContactSchema> {
  return compact({
    id: contact.id,
    name: contact.name,
    vatId: contact.vatId,
    countries:
      contact.countries === undefined || contact.countries.length === 0
        ? undefined
        : [...contact.countries],
    link: contact.id === undefined ? undefined : contactLink(contact.id),
  });
}
