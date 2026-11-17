/**
 * `sevdesk_records_audit`: account audits that answer "what is wrong?" instead of "what are the
 * numbers?". A read tool: each check lists documents, contacts and positions and changes nothing.
 * The checks live in `src/domain/reports/audit/` (`registry.ts`).
 */
import { z } from "zod";

import {
  AUDIT_CHECK_NAMES,
  auditChecksDescription,
  auditChecksLabel,
  auditResultSchema,
  auditSentence,
  runAudit,
} from "../../domain/reports/audit/registry.js";
import { MAX_SCAN_DOCUMENTS } from "../../domain/reports/positions-scan.js";
import { resolvePeriod } from "../../domain/reports/vat.js";
import { defineTool } from "../define-tool.js";
import { periodInputShape } from "./period-input.js";
import { taxReportRunOptions } from "./tax-tools.js";

/** `sevdesk_records_audit`: findings with documents, links and reasons for one check. */
export const recordsAuditTool = defineTool({
  name: "sevdesk_records_audit",
  title: "Audit sevDesk records (findings)",
  description:
    "Prüfung (audit) of the books for a month, quarter or year that answers 'what is wrong?': " +
    "findings, each with the documents (Belege, Rechnungen; ids and links), the contact, a " +
    "reason citing the law (UStG) and what to check. One check per call: " +
    `${auditChecksDescription()}. Findings are hints, not tax advice (Hinweise, keine ` +
    "Steuerberatung). Reads documents, contacts and positions (up to " +
    `${MAX_SCAN_DOCUMENTS.toLocaleString("en-US")} documents; slow for long periods) and ` +
    "changes nothing. For the UStVA figures use sevdesk_vat_summary.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    check: z.enum(AUDIT_CHECK_NAMES).describe(`Which check: ${auditChecksLabel()}.`),
    ...periodInputShape,
  }),
  output: auditResultSchema,
  handler: async (args, ctx) => {
    const period = resolvePeriod(args);
    const result = await runAudit(
      ctx.client,
      args.check,
      { period, cacheOwner: ctx.config },
      taxReportRunOptions(ctx),
    );
    return { data: result, summary: auditSentence(result) };
  },
});
