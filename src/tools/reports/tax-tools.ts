/**
 * Tax reports (M4): `sevdesk_vat_summary` (Umsatzsteuer-Voranmeldung estimate with ZM and OSS)
 * and `sevdesk_profit_and_loss` (EÜR-style income and expenses). Both are read tools: they list
 * documents, read positions and (cash basis) the bank reconciliation log, and never write.
 */
import { z } from "zod";

import { loadAccountSettings } from "../../domain/account-settings.js";
import { type AccountDatevList, loadAccountsDatev } from "../../domain/accounts-datev.js";
import { paymentsInPeriod } from "../../domain/reconciliation/transaction-log.js";
import {
  PNL_BASES,
  profitAndLoss,
  profitAndLossSchema,
  profitAndLossSentence,
} from "../../domain/reports/pnl.js";
import { MAX_SCAN_DOCUMENTS } from "../../domain/reports/positions-scan.js";
import { HTTP_REPORT_BUDGET_MS, type ReportRunOptions } from "../../domain/reports/shared.js";
import {
  resolvePeriod,
  VAT_BASES,
  vatSummary,
  vatSummarySchema,
  vatSummarySentence,
} from "../../domain/reports/vat.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineTool } from "../define-tool.js";
import type { AnyToolDefinition, ToolContext } from "../types.js";
import { periodInputShape } from "./period-input.js";

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Progress, cancellation and, in an HTTP deployment, the time budget: the HTTP router stops a
 * request after 120 s and the caller then gets nothing, while one position request per document
 * at the default pacing reads only a few hundred documents in that time. With the budget the
 * report stops reading in time and comes back as truncated, telling the caller to narrow the
 * period (review 2026-11, round 3). Over stdio there is no deadline, so no budget either.
 */
export function taxReportRunOptions(
  ctx: ToolContext,
  now: () => number = Date.now,
): ReportRunOptions {
  return {
    signal: ctx.signal,
    onProgress: (done, total, message) => ctx.progress(done, total, message),
    ...(ctx.config.deployment.kind === "http"
      ? { deadline: { at: now() + HTTP_REPORT_BUDGET_MS, now } }
      : {}),
  };
}

/** `sevdesk_vat_summary`: UStVA estimate (Kennzahlen, Kz 83), ZM and OSS for a period. */
export const vatSummaryTool = defineTool({
  name: "sevdesk_vat_summary",
  title: "VAT return estimate (UStVA)",
  description:
    "Umsatzsteuer-Voranmeldung (UStVA) estimate for a month, quarter or year: the form lines " +
    "(Kennzahlen, 2026 form) with base and tax, e.g. Kz 81/86 domestic sales, 41 intra-EU " +
    "supplies, 43 exports, 46/47 and 84/85 reverse charge (§13b), 89/93 acquisitions, 66/61/67 " +
    "input VAT (Vorsteuer), plus the Kz 83 estimate, the Zusammenfassende Meldung (ZM) per buyer " +
    "VAT id, OSS sales per country, and amounts it cannot place. Computed here from invoices, " +
    "credit notes and vouchers (positions read one by one, up to " +
    `${MAX_SCAN_DOCUMENTS.toLocaleString("en-US")} documents; slow for long periods). basis: ` +
    "accrual (Soll, default; sevDesk's API does not expose the account setting) or cash (Ist, " +
    "from reconciled payments). It reads the account's tax regime itself (no need for " +
    "sevdesk_account_info first); Kleinunternehmer accounts get no UStVA. An estimate to check, " +
    "not a filing: submit via ELSTER.",
  toolset: "reports",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({
    ...periodInputShape,
    basis: z
      .enum(VAT_BASES)
      .optional()
      .describe("accrual (Sollversteuerung, default) or cash (Istversteuerung)."),
  }),
  output: vatSummarySchema,
  handler: async (args, ctx) => {
    const period = resolvePeriod(args);
    const options = taxReportRunOptions(ctx);
    const settings = await loadAccountSettings(ctx.client, {
      cacheOwner: ctx.config,
      signal: ctx.signal,
    });
    // The account list finds the import VAT account by its number (Kz 62); see `import-vat.ts`.
    const accounts = await loadAccounts(ctx);
    const report = await vatSummary(
      ctx.client,
      { period, basis: args.basis, settings, payments: paymentsInPeriod, accounts },
      options,
    );
    return { data: report, summary: vatSummarySentence(report) };
  },
});

/** `sevdesk_profit_and_loss`: EÜR-style income and expenses for a period. */
export const profitAndLossTool = defineTool({
  name: "sevdesk_profit_and_loss",
  title: "Profit and loss (EÜR-style)",
  description:
    "Einnahmenüberschussrechnung (EÜR)-style profit and loss for a month, quarter or year: net " +
    "income by tax rule (Steuerregel), net expenses by booking account (Buchungskonto, number " +
    "and name), the result, and VAT flows apart (Umsatzsteuer collected, Vorsteuer paid, VAT " +
    "paid to or refunded by the Finanzamt). Fixed assets (Anlagegüter) are listed apart, " +
    "without depreciation (AfA). basis: cash (default, Zufluss-/Abflussprinzip: payments sevDesk " +
    "links to documents, by value date) or accrual (by document date). Positions are read one " +
    `by one (up to ${MAX_SCAN_DOCUMENTS.toLocaleString("en-US")} documents). Call it directly ` +
    "with the period: it reads the accounts and payments itself. Computed here from sevDesk " +
    "data: not the Anlage EÜR (which works gross) and not a tax return.",
  toolset: "reports",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({
    ...periodInputShape,
    basis: z
      .enum(PNL_BASES)
      .default("cash")
      .describe("cash (by payment day, default) or accrual (by document date)."),
  }),
  output: profitAndLossSchema,
  handler: async (args, ctx) => {
    const period = resolvePeriod(args);
    const options = taxReportRunOptions(ctx);
    const accounts = await loadAccounts(ctx);
    const chartOfAccounts = await loadChartOfAccounts(ctx);
    const report = await profitAndLoss(
      ctx.client,
      { period, basis: args.basis, payments: paymentsInPeriod, accounts, chartOfAccounts },
      options,
    );
    return { data: report, summary: profitAndLossSentence(report) };
  },
});

/**
 * The chart of accounts (skr03/skr04) only helps to find the import VAT account by its number:
 * when the settings cannot be read, the report still runs (the recorded account id is known).
 */
async function loadChartOfAccounts(ctx: ToolContext): Promise<string | undefined> {
  try {
    const settings = await loadAccountSettings(ctx.client, {
      cacheOwner: ctx.config,
      signal: ctx.signal,
    });
    return settings?.chartOfAccounts;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return undefined;
    throw error;
  }
}

/** Booking account names are a convenience: unreadable ones leave the accounts as ids. */
async function loadAccounts(ctx: ToolContext): Promise<AccountDatevList | undefined> {
  try {
    return await loadAccountsDatev(ctx.client, { cacheOwner: ctx.config, signal: ctx.signal });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") return undefined;
    throw error;
  }
}

/** Tax reports, M4: VAT summary (UStVA, ZM) and the EÜR-style profit and loss. */
export const REPORT_TAX_TOOLS: readonly AnyToolDefinition[] = [vatSummaryTool, profitAndLossTool];
