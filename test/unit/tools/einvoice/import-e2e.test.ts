/**
 * End to end through the real e-invoice planner and the real voucher import (prepare only): what
 * `sevdesk_einvoice_parse` reports as `readyToImport` must be what
 * `sevdesk_voucher_import_einvoice` accepts, also when the tax rule allows only 0 % and the VAT is
 * folded into the expense (the importer folds; the planner only flags it).
 *
 * KoSIT sample 01.01a (Apache-2.0): 314.86 net at 7 %, 22.04 VAT, 336.90 gross, seller in DE,
 * buyer "[Buyer name]" (the direction is assumed: expense).
 *
 * Assumption (no recording yet): on a Kleinunternehmer account sevDesk's ReceiptGuidance allows
 * rule 10 at 0 % for an expense account such as 4266 (6815 Bürobedarf). The recorded guidance is
 * from the regular-VAT account, where rule 10 appears for no account, so the test adds it.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import {
  planVoucherFromEInvoice,
  suggestVoucherFields,
} from "../../../../src/domain/einvoice/voucher-suggestion.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { voucherImportEInvoiceTool } from "../../../../src/tools/vouchers/import-einvoice.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsRoute,
  guidanceRoute,
  regularRoute,
  smallBusinessRoute,
  version2Route,
  voucherListRoute,
} from "../vouchers/routes.js";

const SAMPLE = new URL(
  "../../../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml",
  import.meta.url,
);
/** Account 4266 (6815 Bürobedarf, SKR04) of the recorded ReceiptGuidance. */
const ACCOUNT = 4266;
const NO_CONTACTS = { rows: [], scanned: 0, complete: true };

let folder: string;
let xml: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "sevdesk-einvoice-e2e-"));
  await copyFile(SAMPLE, join(folder, "xrechnung.xml"));
  xml = await readFile(SAMPLE, "utf8");
  // The same invoice from a seller in Austria: foreign VAT.
  const austrian = xml.replace(
    "<ram:CityName>[Seller city]</ram:CityName>\n                    <ram:CountryID>DE</ram:CountryID>",
    "<ram:CityName>[Seller city]</ram:CityName>\n                    <ram:CountryID>AT</ram:CountryID>",
  );
  expect(austrian).not.toBe(xml);
  await writeFile(join(folder, "xrechnung-at.xml"), austrian);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** The recorded guidance, with rule 10 at 0 % added to `ACCOUNT` (see the module doc). */
function guidanceWithRule10(): FakeRoute {
  const body = structuredClone(guidanceRoute.response) as { fixture: string };
  const recorded = structuredClone(loadFixture(body.fixture).body) as {
    objects: { accountDatevId: number; allowedTaxRules: unknown[] }[];
  };
  const account = recorded.objects.find((row) => row.accountDatevId === ACCOUNT);
  account?.allowedTaxRules.push({
    name: "NICHT_VORST_ABZUGSF_AUFW",
    id: 10,
    description: "Nicht vorsteuerabziehbare Aufwendungen",
    taxRates: ["ZERO"],
  });
  return { path: guidanceRoute.path, response: { body: recorded } };
}

function client(settings: FakeRoute, guidance: FakeRoute = guidanceRoute): FakeSevdeskClient {
  return new FakeSevdeskClient([
    version2Route,
    settings,
    guidance,
    accountsRoute,
    { path: "/Contact", response: { body: { objects: [] } } },
    voucherListRoute(),
  ]);
}

const tool = voucherImportEInvoiceTool(planVoucherFromEInvoice);

async function suggestionFor(text: string, regime: "regular" | "small_business") {
  const parsed = await parseEInvoice(new TextEncoder().encode(text));
  return suggestVoucherFields(parsed, {
    regime,
    company: undefined,
    contacts: NO_CONTACTS,
  });
}

describe("e-invoice → voucher import (planner and importer together)", () => {
  it("imports KoSIT 01.01a under rule 10 (Kleinunternehmer) with the VAT folded once", async () => {
    const suggestion = await suggestionFor(xml, "small_business");
    expect(suggestion).toMatchObject({ taxRuleId: 10, foldVatForZeroRule: true, blocking: [] });

    const plan = await prepareWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: ACCOUNT },
      client(smallBusinessRoute, guidanceWithRule10()),
      { fileDirs: [folder] },
    );
    const facts = new Map(plan.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts.get("Tax rule (Steuerregel)")).toBe("10 Nicht vorsteuerabziehbare Aufwendungen");
    expect(facts.get("Position 1")).toContain("336.90 EUR net, 0 % VAT");
    expect(facts.get("Total (expected)")).toBe("net 336.90 EUR, tax 0.00 EUR, gross 336.90 EUR");
  });

  it("imports KoSIT 01.01a under rule 9 at 7 % on a regular account (nothing folded)", async () => {
    const suggestion = await suggestionFor(xml, "regular");
    expect(suggestion).toMatchObject({ taxRuleId: 9, foldVatForZeroRule: false, blocking: [] });
    const plan = await prepareWrite(
      tool,
      { file: "xrechnung.xml", accountDatevId: ACCOUNT },
      client(regularRoute),
      { fileDirs: [folder] },
    );
    expect(JSON.stringify(plan.preview)).toContain("336.90");
  });

  it("refuses foreign VAT on a regular account in both places", async () => {
    const austrian = await readFile(join(folder, "xrechnung-at.xml"), "utf8");
    const suggestion = await suggestionFor(austrian, "regular");
    expect(suggestion.blocking).not.toEqual([]);
    const error: unknown = await prepareWrite(
      tool,
      { file: "xrechnung-at.xml", accountDatevId: ACCOUNT },
      client(regularRoute),
      { fileDirs: [folder] },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toContain("foreign VAT");
  });
});
