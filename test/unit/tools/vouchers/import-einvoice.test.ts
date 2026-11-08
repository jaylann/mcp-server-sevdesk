/**
 * `sevdesk_voucher_import_einvoice` with the real e-invoice parser on a KoSIT XRechnung sample
 * (Apache-2.0, `test/fixtures/einvoice/kosit/`) and a stand-in for the e-invoice module's planner
 * (its contract: one suggested position per VAT breakdown row, blocking and warning texts).
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { RECEIPT_UPLOADS } from "../../../../src/domain/drafts/voucher-checks.js";
import type { VoucherSuggestion } from "../../../../src/domain/drafts/voucher-import.js";
import type { ParsedEInvoice } from "../../../../src/domain/einvoice/model.js";
import { planVoucherFromEInvoice } from "../../../../src/domain/einvoice/voucher-suggestion.js";
import { money } from "../../../../src/domain/money.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { voucherImportEInvoiceTool } from "../../../../src/tools/vouchers/import-einvoice.js";
import { testConfig } from "../../../helpers/config.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsRoute,
  CREATE_READ_ROUTES,
  readBackRoutes,
  regularRoute,
  saveRoute,
  smallBusinessRoute,
  uploadRoute,
  version2Route,
  voucherListRoute,
} from "./routes.js";

const SAMPLE = fileURLToPath(
  new URL("../../../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml", import.meta.url),
);

/** A planner as the e-invoice module's: positions from the VAT breakdown, nothing blocking. */
function planner(overrides: Partial<VoucherSuggestion> = {}) {
  const calls: ParsedEInvoice[] = [];
  const plan = (parsed: ParsedEInvoice): Promise<VoucherSuggestion> => {
    calls.push(parsed);
    const eur = (amount: string) => money(amount, parsed.currency);
    return Promise.resolve({
      kind: "expense",
      counterparty: { name: parsed.seller.name, vatId: parsed.seller.vatId },
      supplierCandidates: [],
      taxRuleId: 9,
      taxRuleReason: "VAT category S: input VAT deductible (rule 9).",
      positions: parsed.vatBreakdown.map((row) => ({
        vatCategory: row.category,
        taxRate: row.rate ?? "0",
        net: eur(row.taxableAmount),
        tax: eur(row.taxAmount),
        gross: money(
          String(Number(row.taxableAmount) * 100 + Number(row.taxAmount) * 100),
          parsed.currency,
        ),
      })),
      voucherDate: parsed.issueDate,
      number: parsed.number,
      currency: parsed.currency,
      totals: {
        net: eur(parsed.totals.net),
        tax: eur(parsed.totals.tax),
        gross: eur(parsed.totals.gross),
        due: eur(parsed.totals.due),
      },
      blocking: [],
      warnings: [],
      ...overrides,
    });
  };
  return { plan, calls };
}

let folder: string | undefined;
afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

async function sampleFolder(): Promise<string> {
  folder = await mkdtemp(join(tmpdir(), "sevdesk-einvoice-"));
  await copyFile(SAMPLE, join(folder, "xrechnung.xml"));
  return folder;
}

function client(): FakeSevdeskClient {
  return new FakeSevdeskClient([
    ...CREATE_READ_ROUTES,
    uploadRoute,
    saveRoute(),
    ...readBackRoutes(),
  ]);
}

describe("sevdesk_voucher_import_einvoice", () => {
  it("is offered only when SEVDESK_FILE_DIRS is set", () => {
    const tool = voucherImportEInvoiceTool(planner().plan);
    expect(tool.tier).toBe("write");
    expect(tool.localEffects).toBe("reads-files");
    expect(tool.available?.(testConfig())).toBe(false);
    expect(tool.available?.(testConfig({ fileDirs: ["/tmp/belege"] }))).toBe(true);
    expect(tool.description.length).toBeLessThanOrEqual(1000);
  });

  it("imports the XRechnung as a draft with one net position per VAT rate and attaches it", async () => {
    const dir = await sampleFolder();
    const stand = planner();
    const tool = voucherImportEInvoiceTool(stand.plan);
    const fake = client();
    const { plan, output } = await executeWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: 4266 },
      fake,
      { fileDirs: [dir] },
    );

    expect(stand.calls[0]?.number).toBe("123456XX");
    expect(plan.preview.action).toBe(
      "Create a draft expense voucher (Beleg) dated 2016-04-04 from an e-invoice, with 1 " +
        "position, gross 336.90 EUR, and attach the receipt file.",
    );
    expect(fake.writes().map((call) => call.path)).toEqual([
      "/Voucher/Factory/uploadTempFile",
      "/Voucher/Factory/saveVoucher",
    ]);
    const upload = fake.writes()[0]?.form?.get("file") as File;
    expect(upload.type).toBe("application/xml");
    const body = fake.writes()[1]?.body as {
      voucher: Record<string, unknown>;
      voucherPosSave: unknown[];
    };
    expect(body.voucher).toMatchObject({
      supplier: null,
      supplierName: "[Seller name]",
      description: "123456XX",
      voucherDate: "04.04.2016",
      status: 50,
      taxRule: { id: 9, objectName: "TaxRule" },
      creditDebit: "C",
    });
    expect(body.voucherPosSave).toEqual([
      {
        objectName: "VoucherPos",
        mapAll: true,
        accountDatev: { id: 4266, objectName: "AccountDatev" },
        taxRate: 7,
        net: true,
        sumNet: 314.86,
        comment: "E-Rechnung, USt 7 % (S)",
        isAsset: false,
      },
    ]);
    // The import itself suggested it, so no "use the import" hint even if sevDesk saw an e-invoice.
    expect(output.summary).toContain("Imported e-invoice as draft voucher 2101");
    expect(output.data.receipt).toMatchObject({ name: "xrechnung.xml", kind: "xml" });
  });

  it("refuses blocking findings before anything is sent", async () => {
    const dir = await sampleFolder();
    const tool = voucherImportEInvoiceTool(
      planner({ blocking: ["BR-CO-15: the total with VAT is not net plus VAT."] }).plan,
    );
    const fake = client();
    const error = await prepareWrite(tool, { file: "xrechnung.xml", accountDatevId: 4266 }, fake, {
      fileDirs: [dir],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toContain(
      "This e-invoice cannot be imported as a voucher: BR-CO-15",
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses an invoice whose totals differ from the voucher's", async () => {
    const dir = await sampleFolder();
    const tool = voucherImportEInvoiceTool(
      planner({
        totals: {
          net: money("314.86"),
          tax: money("22.04"),
          gross: money("337.00"),
          due: money("337.00"),
        },
      }).plan,
    );
    const error = (await prepareWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: 4266 },
      client(),
      { fileDirs: [dir] },
    ).catch((caught: unknown) => caught)) as SevdeskError;
    expect(error.message).toContain("does not match the e-invoice totals");
  });

  it("refuses a plain PDF receipt with the parser's hint, and reads only PDF or XML", async () => {
    const dir = await sampleFolder();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "beleg.pdf"), "%PDF-1.4\n%%EOF\n");
    await writeFile(
      join(dir, "beleg.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const tool = voucherImportEInvoiceTool(planner().plan);
    const pdf = (await prepareWrite(tool, { file: "beleg.pdf", accountDatevId: 4266 }, client(), {
      fileDirs: [dir],
    }).catch((caught: unknown) => caught)) as SevdeskError;
    expect(pdf).toBeInstanceOf(SevdeskError);
    expect(pdf.kind).toBe("validation");
    const png = (await prepareWrite(tool, { file: "beleg.png", accountDatevId: 4266 }, client(), {
      fileDirs: [dir],
    }).catch((caught: unknown) => caught)) as SevdeskError;
    expect(png.message).toContain("accepted: PDF, XML");
  });

  it("saves an XML e-invoice without attachment when sevDesk does not take bare XML", async () => {
    const dir = await sampleFolder();
    const uploads = RECEIPT_UPLOADS as { xml: boolean };
    uploads.xml = false;
    try {
      const fake = client();
      const { plan, output } = await executeWrite(
        voucherImportEInvoiceTool(planner().plan),
        { file: "xrechnung.xml", accountDatevId: 4266 },
        fake,
        { fileDirs: [dir] },
      );
      expect(fake.writes().map((call) => call.path)).toEqual(["/Voucher/Factory/saveVoucher"]);
      expect(plan.preview.action).not.toContain("attach");
      expect(plan.preview.warnings).toContain(
        "sevDesk does not take a bare XML file as a receipt, so the e-invoice is saved without " +
          "attachment. Attach its PDF (or a print) to the voucher in sevDesk (GoBD).",
      );
      expect(output.data.receipt).toBeUndefined();
    } finally {
      uploads.xml = true;
    }
  });
});

/**
 * End to end with the e-invoice module's real planner: parse → suggestVoucherFields → import
 * prepare, on KoSIT 01.01a (314.86 net at 7 %, VAT 22.04, gross 336.90).
 */
describe("sevdesk_voucher_import_einvoice with planVoucherFromEInvoice", () => {
  const tool = voucherImportEInvoiceTool(planVoucherFromEInvoice);
  /** Account 4266 (6815 Bürobedarf) allowing rule 9 (0/7/19 %) and rule 10 (0 %) for expenses. */
  const guidance = {
    path: "/ReceiptGuidance/forAllAccounts",
    response: {
      body: {
        objects: [
          {
            accountDatevId: 4266,
            accountNumber: "6815",
            accountName: "Bürobedarf",
            description: null,
            allowedTaxRules: [
              {
                name: "VORST_ABZUGSF_AUFW",
                id: 9,
                description: null,
                taxRates: ["ZERO", "SEVEN", "NINETEEN"],
              },
              { name: "NICHT_VORST_ABZUGSF_AUFW", id: 10, description: null, taxRates: ["ZERO"] },
            ],
            allowedReceiptTypes: ["EXPENSE"],
          },
        ],
      },
    },
  };
  const routes = (settings: typeof regularRoute) => [
    settings,
    version2Route,
    guidance,
    accountsRoute,
    { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
    voucherListRoute(),
    uploadRoute,
    saveRoute(),
    ...readBackRoutes(),
  ];
  const position = (fake: FakeSevdeskClient) =>
    fake.writes().at(-1)?.body as {
      voucher: { taxRule: { id: number } };
      voucherPosSave: unknown[];
    };

  it("folds the VAT under rule 10 on a Kleinunternehmer account (gross at 0 %)", async () => {
    const dir = await sampleFolder();
    const fake = new FakeSevdeskClient(routes(smallBusinessRoute));
    const { plan } = await executeWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: 4266 },
      fake,
      {
        fileDirs: [dir],
      },
    );
    const body = position(fake);
    expect(body.voucher.taxRule.id).toBe(10);
    expect(body.voucherPosSave).toEqual([
      expect.objectContaining({ taxRate: 0, net: true, sumNet: 336.9 }),
    ]);
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 336.90 EUR, tax 0.00 EUR, gross 336.90 EUR",
    });
  });

  it("folds under an override to rule 10 on a regular account", async () => {
    const dir = await sampleFolder();
    const fake = new FakeSevdeskClient(routes(regularRoute));
    await executeWrite(tool, { file: "xrechnung.xml", accountDatevId: 4266, taxRuleId: 10 }, fake, {
      fileDirs: [dir],
    });
    expect(position(fake).voucherPosSave).toEqual([
      expect.objectContaining({ taxRate: 0, sumNet: 336.9 }),
    ]);
  });

  it("books the invoice's own 7 % under an override to rule 9 on a regular account", async () => {
    const dir = await sampleFolder();
    const fake = new FakeSevdeskClient(routes(regularRoute));
    await executeWrite(tool, { file: "xrechnung.xml", accountDatevId: 4266, taxRuleId: 9 }, fake, {
      fileDirs: [dir],
    });
    const body = position(fake);
    expect(body.voucher.taxRule.id).toBe(9);
    expect(body.voucherPosSave).toEqual([
      expect.objectContaining({ taxRate: 7, net: true, sumNet: 314.86 }),
    ]);
  });

  it("refuses an override to rule 9 on a Kleinunternehmer account (regime)", async () => {
    const dir = await sampleFolder();
    const fake = new FakeSevdeskClient(routes(smallBusinessRoute));
    const error = (await prepareWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: 4266, taxRuleId: 9 },
      fake,
      { fileDirs: [dir] },
    ).catch((caught: unknown) => caught)) as SevdeskError;
    expect(error.message).toContain("Kleinunternehmer regulation (§19 UStG), so tax rule 9");
    expect(fake.writes()).toEqual([]);
  });
});
