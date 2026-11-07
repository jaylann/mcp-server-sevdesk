import { describe, expect, it } from "vitest";

import { selectDocumentFileKinds } from "../../../src/resources/index.js";
import type { Tier } from "../../../src/safety/tiers.js";
import type { ToolsetName } from "../../../src/tools/toolsets.js";
import { allEnabledConfig, testConfig } from "../../helpers/config.js";

describe("selectDocumentFileKinds", () => {
  it("exposes every kind with the default toolsets", () => {
    expect(selectDocumentFileKinds(testConfig())).toEqual([
      "invoice_pdf",
      "credit_note_pdf",
      "order_pdf",
      "invoice_xml",
    ]);
    expect(selectDocumentFileKinds(allEnabledConfig())).toHaveLength(4);
  });

  it.each([
    [["meta"], []],
    [
      ["meta", "invoices"],
      ["invoice_pdf", "invoice_xml"],
    ],
    [["meta", "credit-notes"], ["credit_note_pdf"]],
    [["meta", "orders", "contacts"], ["order_pdf"]],
  ] as const)("toolsets %j → %j", (toolsets, expected) => {
    const config = testConfig({ toolsets: new Set<ToolsetName>(toolsets) });
    expect(selectDocumentFileKinds(config)).toEqual(expected);
  });

  it("exposes nothing without the read tier (defensive: config always includes it)", () => {
    const config = testConfig({ allowedTiers: new Set<Tier>(["write"]) });
    expect(selectDocumentFileKinds(config)).toEqual([]);
  });
});
