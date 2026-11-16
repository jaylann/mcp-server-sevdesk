/**
 * The checks of `sevdesk_records_audit` and what runs one.
 *
 * Adding a check: write its module (a `run` that gets an {@link AuditCheckContext} and returns
 * finding drafts, coverage and notes, plus its own section if it has one), add its name to
 * {@link AUDIT_CHECK_NAMES} and its entry to {@link AUDIT_CHECKS}. The tool's `check` enum and its
 * description come from here, so the tool offers exactly the checks that exist.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../../sevdesk/types.js";
import { compact } from "../../common.js";
import { plural, type ReportRunOptions } from "../shared.js";
import type { ReportPeriod } from "../vat.js";
import {
  AUDIT_CAVEAT,
  AUDIT_CAVEAT_DE,
  type AuditCheckContext,
  type AuditCheckResult,
  auditCoverageSchema,
  auditFindingSchema,
  buildFindings,
  MAX_FINDINGS,
} from "./findings.js";
import {
  reverseChargeCheck,
  type ReverseChargeSection,
  reverseChargeSectionSchema,
} from "./reverse-charge-check.js";
import { vatCheck } from "./vat-check.js";

/** The checks, in the order the tool lists them. */
export const AUDIT_CHECK_NAMES = ["vat", "reverse_charge"] as const;
export type AuditCheckName = (typeof AUDIT_CHECK_NAMES)[number];

/** Sections a check may add to its result (each check owns its own). */
interface AuditSections {
  readonly reverseCharge?: ReverseChargeSection | undefined;
}

/** One check. */
export interface AuditCheck {
  /** A few words for the `check` argument. */
  readonly label: string;
  /** What it finds, for the tool description (no leading capital, no final stop). */
  readonly summary: string;
  /** Its finding codes (documented in the output schema). */
  readonly codes: readonly string[];
  readonly run: (context: AuditCheckContext) => Promise<AuditCheckResult & AuditSections>;
}

export const AUDIT_CHECKS: Readonly<Record<AuditCheckName, AuditCheck>> = {
  vat: vatCheck,
  reverse_charge: reverseChargeCheck,
};

/** Stated in every audit result. */
const AUDIT_SOURCE =
  "Checked by this server on sevDesk records (documents, positions, contacts); not one of " +
  "sevDesk's own reports. Nothing was changed in sevDesk.";

const codesText = AUDIT_CHECK_NAMES.map(
  (name) => `${name}: ${AUDIT_CHECKS[name].codes.join(", ")}`,
).join("; ");

export const auditResultSchema = z.object({
  check: z.string().describe("The check that ran."),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  source: z.string(),
  caveat: z.string().describe("Findings are hints, not tax advice."),
  caveatDe: z.string().describe("The same in German."),
  regime: z
    .enum(["regular", "small_business"])
    .optional()
    .describe("The account's VAT regulation today; absent when it could not be read."),
  findings: z
    .array(
      auditFindingSchema.extend({
        code: z
          .string()
          .describe(
            `Kind of finding, stable; new codes may be added, treat an unknown one as other. ` +
              `${codesText}.`,
          ),
      }),
    )
    .describe(`Warnings first; at most ${String(MAX_FINDINGS)}.`),
  findingsOmitted: z.number().int().optional().describe("Findings not listed."),
  reverseCharge: reverseChargeSectionSchema
    .optional()
    .describe("check reverse_charge: the § 13b base of the period by tax rule."),
  coverage: auditCoverageSchema,
  notes: z.array(z.string()),
});

export type AuditResult = z.output<typeof auditResultSchema>;

export interface AuditParams {
  readonly period: ReportPeriod;
  /** Object the per-account caches belong to (tools pass `ctx.config`). */
  readonly cacheOwner: object;
  readonly limits?: AuditCheckContext["limits"];
  readonly today?: string | undefined;
}

/** Runs one check and shapes its result. Changes nothing in sevDesk. */
export async function runAudit(
  client: SevdeskClient,
  check: AuditCheckName,
  params: AuditParams,
  options: ReportRunOptions = {},
): Promise<AuditResult> {
  const result = await AUDIT_CHECKS[check].run({
    client,
    period: params.period,
    cacheOwner: params.cacheOwner,
    options,
    limits: params.limits,
    today: params.today,
  });
  const findings = buildFindings(check, result.drafts);
  const omitted = findings.length - MAX_FINDINGS;
  const { period } = params;
  return compact({
    check,
    period: { from: period.from, to: period.to, label: period.label },
    source: AUDIT_SOURCE,
    caveat: AUDIT_CAVEAT,
    caveatDe: AUDIT_CAVEAT_DE,
    regime: result.regime,
    findings: findings.slice(0, MAX_FINDINGS),
    findingsOmitted: omitted > 0 ? omitted : undefined,
    reverseCharge: result.reverseCharge,
    coverage: result.coverage,
    notes: [
      ...result.notes,
      ...(omitted > 0
        ? [`${plural(omitted, "further finding")} not listed: narrow the period to see them.`]
        : []),
    ],
  });
}

/** Trusted one-line summary: counts, the § 13b totals, whether reading was complete. */
export function auditSentence(result: AuditResult): string {
  const total = result.findings.length + (result.findingsOmitted ?? 0);
  const warnings = result.findings.filter((finding) => finding.severity === "warning").length;
  const findings =
    total === 0
      ? "no findings"
      : `${plural(total, "finding")} (${String(warnings)} ${warnings === 1 ? "warning" : "warnings"} listed)`;
  let text =
    `Audit ${result.check} ${result.period.label}: ${findings} in ` +
    `${plural(result.coverage.documentsInScope, "document")} in scope.`;
  const totals = result.reverseCharge?.totals;
  if (totals !== undefined) {
    text +=
      ` § 13b received: base ${totals.base.amount} EUR, tax owed ${totals.tax.amount} EUR, ` +
      `deductible ${totals.inputTax.amount} EUR.`;
  }
  if (result.coverage.truncated) {
    text +=
      result.coverage.timeBudgetReached === true
        ? " Incomplete: the time budget stopped reading; use a shorter period."
        : " Incomplete: not everything could be read (see the notes).";
  }
  return text;
}

/** The checks for the tool description: `name: summary` each. */
export function auditChecksDescription(): string {
  return AUDIT_CHECK_NAMES.map((name) => `${name}: ${AUDIT_CHECKS[name].summary}`).join("; ");
}

/** The checks for the `check` argument: `name (label)` each. */
export function auditChecksLabel(): string {
  return AUDIT_CHECK_NAMES.map((name) => `${name} (${AUDIT_CHECKS[name].label})`).join(", ");
}
