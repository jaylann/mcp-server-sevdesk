import { describe, expect, it } from "vitest";

import { renderToolDocs } from "../../../scripts/tool-docs.js";
import { PROMPTS } from "../../../src/prompts/catalog.js";

describe("docs/tools.md prompt section", () => {
  const docs = renderToolDocs([], PROMPTS);

  it("documents every shipped prompt, sorted by name", () => {
    const headings = [...docs.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]);
    expect(headings).toEqual(PROMPTS.map((prompt) => prompt.name).sort());
    for (const prompt of PROMPTS) {
      expect(docs).toContain(prompt.description);
    }
  });

  it("names what each prompt needs and its arguments", () => {
    expect(docs).toContain(
      "**File a receipt (Beleg erfassen)** · needs `sevdesk_vouchers_list` and one of " +
        "`sevdesk_voucher_create_draft` or `sevdesk_einvoice_parse`",
    );
    expect(docs).toContain(
      "**Bank reconciliation (Kontoabgleich)** · needs `sevdesk_bank_accounts_list`, " +
        "`sevdesk_transactions_list` and `sevdesk_reconcile_suggest`",
    );
    expect(docs).toContain("**VAT pre-check (UStVA-Vorprüfung)** · needs `sevdesk_vat_summary`");
    expect(docs).toContain(
      "| `month` | no | Month to close, YYYY-MM (e.g. 2026-10). Default: the previous month. |",
    );
    expect(docs).toMatch(/### `dunning_run`\n\n[^\n]+\n\n[^\n]+\n\nNo arguments\./);
  });

  it("leaves the section out without prompts", () => {
    expect(renderToolDocs([], [])).not.toContain("## Prompts");
  });
});
