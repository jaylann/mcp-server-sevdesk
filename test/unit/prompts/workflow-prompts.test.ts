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
      "Filing a found receipt as a voucher draft: needs the `vouchers` toolset " +
        "(SEVDESK_TOOLSETS) and the `write` tier (SEVDESK_ALLOW).",
    ]);
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
    const write = textOf(
      planned("missing_receipts", testConfig({ allowedTiers: tiers("read", "write") })),
    );
    expect(write).toContain("`sevdesk_voucher_create_draft` with `dryRun: true`");
    expect(write).not.toContain("Not available with the current settings");
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
