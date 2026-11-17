/**
 * The workflow prompts of #97 (`missing_receipts`, `year_end_handoff`, `offer_follow_up`) on the
 * real tool catalog: when each is listed, which steps a configuration shows, and the setting each
 * missing step names (tier, toolset, folder or download links), worded for the deployment.
 */
import { describe, expect, it } from "vitest";

import type { Config, Deployment } from "../../../src/config.js";
import { PROMPTS } from "../../../src/prompts/catalog.js";
import { type PlannedPrompt, planPrompts, renderPrompt } from "../../../src/prompts/index.js";
import { ALL_TOOLS } from "../../../src/tools/index.js";
import { selectTools } from "../../../src/tools/registry.js";
import type { ToolsetName } from "../../../src/tools/toolsets.js";
import { allEnabledConfig, testConfig, tiers } from "../../helpers/config.js";

/** 2026-11-09 12:00 UTC. */
const NOW = () => Date.UTC(2026, 10, 9, 12);

const HTTP_BEARER: Deployment = {
  kind: "http",
  auth: "bearer",
  publicOrigin: "https://mcp.example.com",
  approvalsUrl: undefined,
};
const OAUTH_FILES: Deployment = { ...HTTP_BEARER, auth: "oauth", files: { ttlSeconds: 900 } };

function toolsets(...names: ToolsetName[]): ReadonlySet<ToolsetName> {
  return new Set(names);
}

/** The plan of prompt `name` in `config`, or undefined when it is not listed. */
function planned(name: string, config: Config): PlannedPrompt | undefined {
  const prompt = PROMPTS.find((candidate) => candidate.name === name);
  if (prompt === undefined) throw new Error(`no prompt ${name}`);
  return planPrompts(config, selectTools(ALL_TOOLS, config), ALL_TOOLS, [prompt])[0];
}

function textOf(plan: PlannedPrompt | undefined, args: Record<string, string> = {}): string {
  if (plan === undefined) throw new Error("prompt not listed");
  const content = renderPrompt(plan, args, NOW).messages[0]?.content;
  return content?.type === "text" ? content.text : "";
}

describe("missing_receipts", () => {
  it("is listed with the bank tools or the audit, not without both", () => {
    expect(planned("missing_receipts", testConfig())).toBeDefined();
    expect(
      planned("missing_receipts", testConfig({ toolsets: toolsets("banking") })),
    ).toBeDefined();
    expect(
      planned("missing_receipts", testConfig({ toolsets: toolsets("reports") })),
    ).toBeDefined();
    expect(
      planned("missing_receipts", testConfig({ toolsets: toolsets("contacts", "invoices") })),
    ).toBeUndefined();
  });

  it("names the toolset of the side that is missing", () => {
    const bankOnly = planned("missing_receipts", testConfig({ toolsets: toolsets("banking") }));
    expect(bankOnly?.unavailable).toEqual([
      "Checking regular suppliers for missing bills and receipts booked twice: needs the " +
        "`reports` toolset (SEVDESK_TOOLSETS).",
      "Checking for draft receipts (Belege): needs the `vouchers` toolset (SEVDESK_TOOLSETS).",
      "Filing a found receipt as a voucher draft: needs the `vouchers` toolset " +
        "(SEVDESK_TOOLSETS) and the `write` tier (SEVDESK_ALLOW).",
      "Finalizing the filed vouchers and booking their bank transactions: needs the " +
        "`vouchers` toolset (SEVDESK_TOOLSETS) and the `commit` tier (SEVDESK_ALLOW).",
    ]);
    expect(textOf(bankOnly)).not.toContain("sevdesk_vouchers_list");
    expect(textOf(bankOnly)).toContain('`direction: "out"`');

    const auditOnly = planned("missing_receipts", testConfig({ toolsets: toolsets("reports") }));
    expect(auditOnly?.unavailable[0]).toBe(
      "Checking the period's unbooked outgoing bank transactions: needs the `banking` toolset " +
        "(SEVDESK_TOOLSETS).",
    );
    expect(textOf(auditOnly)).not.toContain("sevdesk_transactions_list");
  });

  it("files found receipts only with the write tier", () => {
    const read = textOf(planned("missing_receipts", testConfig()));
    expect(read).not.toContain("sevdesk_voucher_create_draft");
    expect(read).toContain(
      "- Filing a found receipt as a voucher draft: needs the `write` tier (SEVDESK_ALLOW).",
    );
    const writePlan = planned(
      "missing_receipts",
      testConfig({ allowedTiers: tiers("read", "write") }),
    );
    const write = textOf(writePlan);
    expect(write).toContain("`sevdesk_voucher_create_draft` with `dryRun: true`");
    expect(write).toContain('`sevdesk_reference_lookup` with `kind: "receipt_guidance"`');
    expect(writePlan?.unavailable).toEqual([
      "Finalizing the filed vouchers and booking their bank transactions: needs the `commit` " +
        "tier (SEVDESK_ALLOW).",
    ]);

    const all = textOf(planned("missing_receipts", allEnabledConfig()));
    expect(all).toContain("`sevdesk_voucher_finalize` (`dryRun: true` first)");
    expect(all).toContain("`sevdesk_transaction_book`");
    expect(all).not.toContain("Not available with the current settings");
  });

  it("offers the upload step only where the server takes uploads", () => {
    const oauth = textOf(
      planned("missing_receipts", allEnabledConfig({ deployment: OAUTH_FILES })),
    );
    expect(oauth).toContain(
      '`sevdesk_upload_request` (`purpose: "receipt"`, or `"einvoice"` for an XRechnung or ' +
        "ZUGFeRD file)",
    );
    expect(oauth).toContain("pass the returned uploadId as `file` below");

    for (const config of [
      testConfig(),
      allEnabledConfig(),
      allEnabledConfig({ fileDirs: ["/srv/belege"] }),
    ]) {
      const plan = planned("missing_receipts", config);
      expect(textOf(plan)).not.toContain("sevdesk_upload_request");
      // No "needs" line either: a local server reads files from its folders instead.
      expect(plan?.unavailable.join(" ")).not.toMatch(/upload|SEVDESK_HTTP_FILES/i);
    }
  });

  it("scopes the suggestions like the transaction list, never with a transactionId too", () => {
    const text = textOf(planned("missing_receipts", testConfig()), { checkAccount: "17" });
    expect(text).toContain(
      '`sevdesk_reconcile_suggest` with `from: "2026-10-01", to: "2026-10-31"` and the ' +
        "resolved `checkAccountId` (page with `nextOffset`), or with a single `transactionId` " +
        "from the list above, not both",
    );
    expect(text).toContain("check that its receipt file is attached");
  });

  it("checks a receipt folder only where the server reads local folders", () => {
    const local = textOf(planned("missing_receipts", testConfig({ fileDirs: ["/srv/belege"] })));
    expect(local).toContain("`sevdesk_receipt_folder_check` with that folder");

    for (const config of [testConfig(), allEnabledConfig({ deployment: OAUTH_FILES })]) {
      const plan = planned("missing_receipts", config);
      expect(textOf(plan)).not.toContain("sevdesk_receipt_folder_check");
      // No "needs" line: uploads would not enable the folder check.
      expect(plan?.unavailable.join(" ")).not.toMatch(/SEVDESK_FILE_DIRS|SEVDESK_HTTP_FILES/);
    }
  });
});

describe("year_end_handoff", () => {
  it("is listed with the profit and loss report", () => {
    expect(planned("year_end_handoff", testConfig())).toBeDefined();
    expect(
      planned("year_end_handoff", testConfig({ toolsets: toolsets("banking", "invoices") })),
    ).toBeUndefined();
  });

  it("names what the exports need on a local server", () => {
    const read = planned("year_end_handoff", testConfig());
    expect(read?.unavailable).toEqual([
      "The DATEV export for the Steuerberater: needs the `write` tier (SEVDESK_ALLOW) and an " +
        "output folder (SEVDESK_OUTPUT_DIR).",
      "Setting the DATEV numbers (Beraternummer, Mandantennummer) in sevDesk: needs the " +
        "`commit` tier (SEVDESK_ALLOW).",
      "The document archive (invoice PDFs and receipts) as ZIP files: needs the `write` tier " +
        "(SEVDESK_ALLOW) and an output folder (SEVDESK_OUTPUT_DIR).",
    ]);
    const text = textOf(read);
    expect(text).toContain("`sevdesk_profit_and_loss` with `year: 2025`");
    expect(text).not.toMatch(/sevdesk_(datev|archive)_/);
  });

  it("offers the exports with the write tier and an output folder, the settings with commit", () => {
    const write = planned(
      "year_end_handoff",
      testConfig({ allowedTiers: tiers("read", "write"), outputDir: "/srv/out" }),
    );
    expect(write?.unavailable).toEqual([
      "Setting the DATEV numbers (Beraternummer, Mandantennummer) in sevDesk: needs the " +
        "`commit` tier (SEVDESK_ALLOW).",
    ]);
    expect(textOf(write)).toContain('`sevdesk_archive_export` with `subject: "invoices"`');

    const all = textOf(planned("year_end_handoff", allEnabledConfig({ outputDir: "/srv/out" })));
    expect(all).toContain(
      "`sevdesk_datev_settings_update` with the numbers from the Steuerberater",
    );
    expect(all).not.toContain("Not available with the current settings");
  });

  it("words the exports for a remote server", () => {
    const bearer = planned(
      "year_end_handoff",
      testConfig({ deployment: HTTP_BEARER, allowedTiers: tiers("read", "write") }),
    );
    expect(bearer?.unavailable).toContain(
      "The document archive (invoice PDFs and receipts) as ZIP files: needs download links " +
        "(SEVDESK_HTTP_FILES) or SEVDESK_OUTPUT_DIR.",
    );
    const oauth = textOf(
      planned("year_end_handoff", allEnabledConfig({ deployment: OAUTH_FILES })),
    );
    expect(oauth).toContain("`sevdesk_datev_export` with `year: 2025`");
    expect(oauth).toContain("on a remote server it is stopped after 120 seconds");
    expect(oauth).toContain("on a remote server by month, or by one or two weeks (`from`/`to`)");
  });

  it("names the voucher toolset for the draft and unpaid receipts instead of dropping them", () => {
    const plan = planned(
      "year_end_handoff",
      testConfig({ toolsets: toolsets("meta", "banking", "invoices", "reports") }),
    );
    expect(plan?.unavailable).toEqual(
      expect.arrayContaining([
        "Checking for draft receipts (Belege): needs the `vouchers` toolset (SEVDESK_TOOLSETS).",
        "Listing the year's unpaid receipts (Belege): needs the `vouchers` toolset " +
          "(SEVDESK_TOOLSETS).",
      ]),
    );
    const text = textOf(plan);
    // The invoice half of the open items stays.
    expect(text).toContain('`sevdesk_invoices_list` with `status: "open"`');
    expect(text).not.toContain("sevdesk_vouchers_list");

    const noInvoices = planned(
      "year_end_handoff",
      testConfig({ toolsets: toolsets("meta", "banking", "vouchers", "reports") }),
    );
    expect(noInvoices?.unavailable).toEqual(
      expect.arrayContaining([
        "Listing the year's unpaid invoices: needs the `invoices` toolset (SEVDESK_TOOLSETS).",
      ]),
    );
    expect(textOf(noInvoices)).toContain('`sevdesk_vouchers_list` with `status: "open"`');
  });
});

describe("offer_follow_up", () => {
  it("is listed with the orders toolset", () => {
    expect(planned("offer_follow_up", testConfig())).toBeDefined();
    expect(
      planned("offer_follow_up", testConfig({ toolsets: toolsets("invoices") })),
    ).toBeUndefined();
  });

  it("only lists offers on the read tier and names the tiers of the follow-ups", () => {
    const read = planned("offer_follow_up", testConfig());
    expect(read?.unavailable).toEqual([
      "Marking offers as accepted or rejected: needs the `commit` tier (SEVDESK_ALLOW).",
      "Creating order confirmations (Auftragsbestätigungen): needs the `commit` tier " +
        "(SEVDESK_ALLOW).",
      "Creating delivery notes (Lieferscheine): needs the `write` tier (SEVDESK_ALLOW).",
      "Creating the invoice from the order: needs the `write` tier (SEVDESK_ALLOW).",
    ]);
    const text = textOf(read);
    expect(text).toContain('`sevdesk_orders_list` with `type: "offer"`, `status: "sent"`');
    expect(text).toContain("for me to send myself");
  });

  it("shows every follow-up with all tiers, and the invoice only with the invoices toolset", () => {
    const all = textOf(planned("offer_follow_up", allEnabledConfig()));
    for (const tool of [
      "sevdesk_order_set_offer_status",
      "sevdesk_order_create_confirmation",
      "sevdesk_order_create_delivery_note",
      "sevdesk_invoice_create_from_order",
    ]) {
      expect(all).toContain(`\`${tool}\``);
    }
    expect(all).not.toContain("Not available with the current settings");

    const ordersOnly = planned(
      "offer_follow_up",
      allEnabledConfig({ toolsets: toolsets("orders") }),
    );
    expect(ordersOnly?.unavailable).toEqual([
      "Creating the invoice from the order: needs the `invoices` toolset (SEVDESK_TOOLSETS).",
    ]);
  });

  it("words read-only mode and the OAuth consent page", () => {
    const readOnly = planned(
      "offer_follow_up",
      allEnabledConfig({ readOnly: true, allowedTiers: tiers("read") }),
    );
    expect(readOnly?.unavailable).toContain(
      "Marking offers as accepted or rejected: needs the `commit` tier (SEVDESK_READ_ONLY is on).",
    );
    const oauth = planned(
      "offer_follow_up",
      testConfig({ deployment: OAUTH_FILES, allowedTiers: tiers("read", "write") }),
    );
    expect(oauth?.unavailable).toEqual([
      "Marking offers as accepted or rejected: needs the `commit` tier (granted on the consent " +
        "page).",
      "Creating order confirmations (Auftragsbestätigungen): needs the `commit` tier (granted " +
        "on the consent page).",
    ]);
  });
});
