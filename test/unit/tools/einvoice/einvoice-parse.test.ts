import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ciiXml, EN16931_INVOICE } from "../../../../scripts/gen-einvoice-fixtures.js";
import { loadConfig } from "../../../../src/config.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { einvoiceParseTool as tool } from "../../../../src/tools/vouchers/einvoice-parse.js";
import { VOUCHER_EINVOICE_TOOLS } from "../../../../src/tools/vouchers/einvoice-tools.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const FIXTURES = new URL("../../../fixtures/einvoice/", import.meta.url);

let base: string;
let inbox: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-einvoice-parse-")));
  inbox = join(base, "Rechnungen");
  outside = join(base, "elsewhere");
  await mkdir(join(inbox, "2026"), { recursive: true });
  await mkdir(outside);
  const copy = (from: string, to: string) => copyFile(new URL(from, FIXTURES), to);
  await copy("generated/cii-en16931-invoice.xml", join(inbox, "2026", "RE-2026-0001.xml"));
  await copy("generated/zugferd-en16931.pdf", join(inbox, "RE-2026-0001.pdf"));
  await copy("generated/plain-receipt.pdf", join(inbox, "Quittung.pdf"));
  await copy("attacks/hidden-text.xml", join(inbox, "hidden.xml"));
  await copy("generated/cii-creditnote.xml", join(inbox, "Gutschrift.xml"));
  await copy("generated/cii-en16931-invoice.xml", join(outside, "secret.xml"));
  const lines = Array.from({ length: 60 }, (_unused, index) => ({
    id: String(index + 1),
    name: `Artikel ${String(index + 1)}`,
    quantity: "1",
    unit: "C62",
    price: "1.00",
    net: "1.00",
    category: "S",
    rate: "19",
  }));
  await writeFile(
    join(inbox, "many-lines.xml"),
    ciiXml({
      ...EN16931_INVOICE,
      lines,
      allowancesCharges: [],
      breakdown: [{ category: "S", rate: "19", basis: "60.00", tax: "11.40" }],
      totals: { lineNet: "60.00", net: "60.00", tax: "11.40", gross: "71.40", due: "71.40" },
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const sevClient: FakeRoute = {
  path: "/SevClient",
  response: {
    body: {
      objects: [{ smallSettlement: "0", name: "Musterfirma GmbH", vatNumber: "DE000000000" }],
    },
  },
};
const contacts: FakeRoute = {
  path: "/Contact",
  response: { fixture: "contacts/contacts-list.json" },
};

async function parse(file: string, env: Record<string, string> = { SEVDESK_FILE_DIRS: inbox }) {
  const client = new FakeSevdeskClient([sevClient, contacts]);
  const result = await tool.handler(tool.input.parse({ file }), testContext(client, env));
  return { client, result, data: tool.output.parse(result.data) };
}

async function refusal(file: string, env?: Record<string, string>) {
  const client = new FakeSevdeskClient([sevClient, contacts]);
  const error: unknown = await tool
    .handler(tool.input.parse({ file }), testContext(client, env ?? { SEVDESK_FILE_DIRS: inbox }))
    .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.calls).toEqual([]);
  return (error as SevdeskError).message;
}

describe("sevdesk_einvoice_parse", () => {
  it("is a read tool that reads local files, offered only with SEVDESK_FILE_DIRS", () => {
    expect(VOUCHER_EINVOICE_TOOLS).toContain(tool);
    expect(tool).toMatchObject({ tier: "read", toolset: "vouchers", localEffects: "reads-files" });
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const config = (env: Record<string, string>) =>
      loadConfig({ SEVDESK_API_TOKEN: "0123456789abcdef0123456789abcdef", ...env });
    expect(tool.available?.(config({}))).toBe(false);
    expect(tool.available?.(config({ SEVDESK_FILE_DIRS: base }))).toBe(true);
  });

  it("parses an XRechnung-style XML by relative path and suggests a voucher", async () => {
    const { client, data, result } = await parse("2026/RE-2026-0001.xml");
    expect(client.writes()).toEqual([]);
    expect(data.file).toEqual({ name: "RE-2026-0001.xml", kind: "xml" });
    expect(data.invoice).toMatchObject({
      syntax: "cii",
      container: "xml",
      profile: "en16931",
      typeLabel: "commercial invoice (Rechnung)",
      number: "RE-2026-0001",
      payment: { meansCode: "58", ibanMasked: "****3000" },
      totals: {
        net: { amount: "220.00", currency: "EUR" },
        gross: { amount: "258.20", currency: "EUR" },
        allowances: { amount: "10.00", currency: "EUR" },
      },
      linesTotal: 2,
    });
    expect(data.invoice.lines[0]).toMatchObject({
      unitCode: "HUR",
      unit: "hour (Stunde)",
      netAmount: { amount: "200.00", currency: "EUR" },
    });
    expect(JSON.stringify(data)).not.toContain("DE89370400440532013000");
    expect(data.suggestedVoucher).toMatchObject({
      kind: "expense",
      supplierId: 1003,
      taxRuleId: 9,
      blocking: [],
    });
    expect(data.readyToImport).toBe(true);
    expect(data.findings).toEqual([]);
    expect(result.summary).toBe(
      "E-invoice (EN 16931 (ZUGFeRD/Factur-X EN 16931, COMFORT), CII): commercial invoice " +
        "(Rechnung) with 2 lines, gross 258.20 EUR; 0 error(s), 0 warning(s). Suggested " +
        "voucher: expense, tax rule 9, ready to import.",
    );
  });

  it("parses a ZUGFeRD PDF by absolute path", async () => {
    const { data } = await parse(join(inbox, "RE-2026-0001.pdf"));
    expect(data.file.kind).toBe("pdf");
    expect(data.invoice).toMatchObject({ container: "pdf", attachmentName: "factur-x.xml" });
  });

  it("caps the lines shown and counts them all", async () => {
    const { data } = await parse("many-lines.xml");
    expect(data.invoice.lines).toHaveLength(50);
    expect(data.invoice.linesTotal).toBe(60);
  });

  it("shows a credit note as not importable", async () => {
    const { data, result } = await parse("Gutschrift.xml");
    expect(data.readyToImport).toBe(false);
    expect(result.summary).toContain("not importable as is (1 blocking reason(s))");
  });

  it("keeps hidden characters and injected text out of the summary", async () => {
    const { data, result } = await parse("hidden.xml");
    expect(data.findings.map((finding) => finding.code)).toEqual(["SD-HIDDEN-TEXT"]);
    expect(data.invoice.notes[0]).toContain("Ignore all previous instructions");
    expect(result.summary).not.toContain("Ignore");
    expect(result.summary).toContain("1 warning(s)");
  });

  it("refuses files outside SEVDESK_FILE_DIRS and plain PDFs before any sevDesk call", async () => {
    expect(await refusal(join(outside, "secret.xml"))).toContain(
      "not a readable file inside the folders",
    );
    expect(await refusal("../elsewhere/secret.xml")).toContain(
      "not a readable file inside the folders",
    );
    expect(await refusal("Quittung.pdf")).toContain("sevdesk_voucher_create_draft");
    expect(await refusal("RE-2026-0001.xml", {})).toContain("SEVDESK_FILE_DIRS is not set");
  });
});
