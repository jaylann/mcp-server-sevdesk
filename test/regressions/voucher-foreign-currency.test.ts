/** D-082: recorded currency semantics, safe replacement updates and sum-based rate checks. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeVoucherSave } from "../../src/domain/drafts/voucher.js";
import { resolveVoucherCurrency } from "../../src/domain/drafts/voucher-currency.js";
import { planVoucherFromEInvoice } from "../../src/domain/einvoice/voucher-suggestion.js";
import { voucherCreateDraftTool as create } from "../../src/tools/vouchers/draft-create.js";
import { voucherUpdateDraftTool as update } from "../../src/tools/vouchers/draft-update.js";
import { voucherFinalizeTool as finalize } from "../../src/tools/vouchers/finalize.js";
import { voucherImportEInvoiceTool } from "../../src/tools/vouchers/import-einvoice.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import {
  CREATE_READ_ROUTES,
  draftRow,
  positionRow,
  positionsRoute,
  readBackRoutes,
  type Row,
  saveRoute,
  uploadRoute,
  voucherListRoute,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

const positions = [{ accountDatevId: 4266, amount: "100.00", taxRate: "19" }];
const args = {
  supplierId: 1001,
  date: "2026-11-02",
  number: "USD-1",
  currency: "USD",
  exchangeRate: "0.9",
  amountMode: "net",
  positions,
};
// Selected fields measured on 2026-11-13: neither rate property appeared on GET.
const usd = {
  currency: "USD",
  sumNet: "90",
  sumTax: "17.1",
  sumGross: "107.1",
  sumNetForeignCurrency: "100",
  sumTaxForeignCurrency: "19",
  sumGrossForeignCurrency: "119",
};
function client(overrides: Row = {}) {
  return new FakeSevdeskClient([
    ...CREATE_READ_ROUTES,
    saveRoute(),
    ...readBackRoutes(draftRow({ ...usd, ...overrides }), [positionRow({ ...usd, net: "1" })]),
  ]);
}

describe("foreign-currency voucher drafts (D-082)", () => {
  it("creates USD with an exact string rate and reconciles the live-probe sums", async () => {
    const fake = client();
    const { plan, output } = await executeWrite(create, args, fake);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]?.body).toMatchObject({
      voucher: { currency: "USD", propertyExchangeRate: "0.9", status: 50 },
      voucherPosSave: [{ net: true, sumNet: 100 }],
    });
    expect(plan.preview.facts).toContainEqual({ label: "Exchange rate", value: "1 USD = 0.9 EUR" });
    expect(plan.preview.facts).toContainEqual({
      label: "EUR equivalent (computed by this server)",
      value: "net 90.00 EUR, tax 17.10 EUR, gross 107.10 EUR",
    });
    expect(plan.previewDe?.facts).toContainEqual({
      label: "Wechselkurs",
      value: "1 USD = 0,9 EUR",
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.data.notesDe).toBeUndefined();
    expect(output.data.voucher.totals.gross?.amount).toBe("119.00");
    expect(output.data.voucher.totalsEur?.gross?.amount).toBe("107.10");
  });

  it("keeps the exchange-rate string exact and computes without float arithmetic", async () => {
    const rate = "0.123456789012345678";
    const { plan } = await executeWrite(create, { ...args, exchangeRate: rate }, client());
    expect(plan.state.body.voucher.propertyExchangeRate).toBe(rate);
    expect(plan.preview.facts.find((fact) => fact.label.startsWith("EUR equivalent"))?.value).toBe(
      "net 12.35 EUR, tax 2.35 EUR, gross 14.69 EUR",
    );
  });

  it("serializes a deadline and reports the EUR totals and approximate implied rate after saving", async () => {
    const { exchangeRate: _rate, ...input } = args;
    const { plan, output } = await executeWrite(
      create,
      { ...input, foreignCurrencyDeadline: "2026-11-12" },
      client({ sumNet: "90.18", sumTax: "17.13", sumGross: "107.31" }),
    );
    expect(plan.state.body.voucher).toHaveProperty("propertyForeignCurrencyDeadline", "12.11.2026");
    expect(plan.state.body.voucher).not.toHaveProperty("propertyExchangeRate");
    expect(plan.preview.facts.some((fact) => fact.label.startsWith("EUR equivalent"))).toBe(false);
    expect(plan.preview.warnings.join(" ")).toContain("EUR amounts are known after saving");
    expect(plan.previewDe?.warnings.join(" ")).toContain("erst nach dem Speichern");
    expect(output.data.notes?.join(" ")).toContain(
      "Stored EUR totals: net 90.18 EUR, tax 17.13 EUR, gross 107.31 EUR",
    );
    expect(output.data.notes?.join(" ")).toContain("1 USD = 0.901765 EUR");
    expect(output.data.notesDe?.join(" ")).toContain("ungefähr 1 USD = 0,901765 EUR");
  });

  it.each([
    { exchangeRate: undefined },
    { exchangeRate: "0" },
    { exchangeRate: "-1" },
    { exchangeRate: 0.9 },
    { exchangeRate: "NaN" },
    { exchangeRate: "1e-3" },
    { exchangeRate: "0.9", foreignCurrencyDeadline: "2026-11-12" },
    { exchangeRate: undefined, foreignCurrencyDeadline: "2026-02-30" },
    { currency: "eur" },
    { currency: "ZZZ" },
    { currency: "US" },
    { currency: "EUR" },
  ])("refuses invalid currency/rate choices without writes: %o", async (change) => {
    const fake = client();
    await expect(prepareWrite(create, { ...args, ...change }, fake)).rejects.toThrow();
    expect(fake.writes()).toEqual([]);
  });

  it("recognizes zero as a supplied, non-positive rate at the domain boundary", () => {
    expect(() => resolveVoucherCurrency("USD", { exchangeRate: "0" })).toThrow(
      "zero is not a positive rate",
    );
    expect(() => resolveVoucherCurrency("USD", {})).toThrow("exactly one");
  });

  it.each([
    { number: "new" },
    { exchangeRate: "0.8" },
    { foreignCurrencyDeadline: "2026-11-12" },
    { currency: "EUR" },
    { currency: "GBP", exchangeRate: "1.2" },
  ])("refuses foreign updates without replacement positions: %o", async (change) => {
    const fake = client();
    await expect(prepareWrite(update, { id: 2101, ...change }, fake)).rejects.toThrow(
      /positions|exchangeRate/,
    );
    expect(fake.writes()).toEqual([]);
  });

  it("resends original USD amounts instead of reusing stored EUR positions on a rate change", async () => {
    const fake = client();
    const plan = await prepareWrite(
      update,
      { id: 2101, exchangeRate: "0.8", amountMode: "net", positions },
      fake,
    );
    expect(plan.state.body).toMatchObject({
      voucher: { currency: "USD", propertyExchangeRate: "0.8" },
      voucherPosSave: [{ sumNet: 100 }],
      voucherPosDelete: [{ id: 3101, objectName: "VoucherPos" }],
    });
    expect(
      plan.preview.facts.find((fact) => fact.label.startsWith("EUR equivalent"))?.value,
    ).toContain("gross 95.20 EUR");
    expect(plan.previewDe?.facts.find((fact) => fact.label === "Wechselkurs")?.value).toBe(
      "1 USD = 0,8 EUR",
    );
    const after = client({ sumNet: "80", sumTax: "15.2", sumGross: "95.2" });
    const saved = await executeVoucherSave(after, plan.state, undefined);
    expect(after.writes()).toHaveLength(1);
    expect(saved.notes).toEqual([]);
    expect(saved.notesDe).toEqual([]);
  });

  it("allows EUR to USD with all target-currency positions", async () => {
    const fake = new FakeSevdeskClient([
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
      ...CREATE_READ_ROUTES,
    ]);
    const plan = await prepareWrite(
      update,
      { id: 2101, currency: "USD", exchangeRate: "0.9", positions },
      fake,
    );
    expect(plan.state.body.voucher.currency).toBe("USD");
    expect(plan.preview.facts).toContainEqual({ label: "Currency", value: "EUR → USD" });
  });

  it.each([
    { sumNetForeignCurrency: "101" },
    { sumTaxForeignCurrency: null },
    { sumGrossForeignCurrency: "0" },
    { sumGross: "85.68" },
    { currency: "GBP" },
    { sumNetForeignCurrency: null, sumTaxForeignCurrency: null, sumGrossForeignCurrency: null },
  ])("warns in both languages on mismatched or absent read-back sums: %o", async (stored) => {
    const { output } = await executeWrite(create, args, client(stored));
    expect(output.data.notes?.join(" ")).toMatch(/differs|missing|did not return/);
    expect(output.data.notesDe?.join(" ")).toMatch(/weicht|fehlt|nicht USD/);
    expect(output.data.notesDe?.length).toBe(output.data.notes?.length);
  });

  it("reports the implied rate on a conversion mismatch", async () => {
    const { output } = await executeWrite(
      create,
      args,
      client({ sumNet: "80", sumTax: "15.2", sumGross: "95.2" }),
    );
    expect(output.data.notes?.join(" ")).toContain("approximately 1 USD = 0.800000 EUR");
    expect(output.data.notesDe?.join(" ")).toContain("ungefähr 1 USD = 0,800000 EUR");
  });

  it("allows one cent per sent position but warns outside that tolerance", async () => {
    const two = {
      ...args,
      positions: positions
        .map((p) => ({ ...p, amount: "50" }))
        .concat([{ accountDatevId: 4266, amount: "50", taxRate: "19" }]),
    };
    const { output: within } = await executeWrite(create, two, client({ sumGross: "107.12" }));
    expect(within.data.notes?.join(" ") ?? "").not.toContain("by more than");
    const { output: outside } = await executeWrite(create, two, client({ sumGross: "107.13" }));
    expect(outside.data.notes?.join(" ")).toContain("by more than 0.02 EUR");
  });

  it("still refuses to finalize a foreign-currency draft", async () => {
    const fake = client();
    await expect(prepareWrite(finalize, { id: 2101 }, fake)).rejects.toThrow(
      "finalizing it is not supported",
    );
    expect(fake.writes()).toEqual([]);
  });

  it("checks duplicates in the voucher currency", async () => {
    const fake = new FakeSevdeskClient([
      voucherListRoute([draftRow({ ...usd, description: "USD-1" })]),
      ...CREATE_READ_ROUTES,
    ]);
    await expect(prepareWrite(create, args, fake)).rejects.toThrow("119.00 USD");
    expect(fake.writes()).toEqual([]);
  });

  it.each(["finalize", "update"])(
    "refuses %s if retained positions changed currency after the preview",
    async (action) => {
      const before = new FakeSevdeskClient([
        voucherRoute(draftRow()),
        positionsRoute(2101, [positionRow()]),
        ...CREATE_READ_ROUTES,
      ]);
      const plan =
        action === "finalize"
          ? await prepareWrite(finalize, { id: 2101 }, before)
          : await prepareWrite(update, { id: 2101, number: "new" }, before);
      const after = client();
      await expect(executeVoucherSave(after, plan.state, undefined)).rejects.toThrow(
        action === "finalize" ? "foreign currency" : "currency changed after the preview",
      );
      expect(after.writes()).toEqual([]);
    },
  );

  it("imports an actual USD XML through the real suggestion planner, with a rate or deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-usd-import-"));
    try {
      const sample = await readFile(
        new URL("../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml", import.meta.url),
        "utf8",
      );
      await writeFile(join(dir, "usd.xml"), sample.replaceAll("EUR", "USD"));
      const tool = voucherImportEInvoiceTool(planVoucherFromEInvoice);
      const refused = new FakeSevdeskClient([
        ...CREATE_READ_ROUTES,
        { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
      ]);
      await expect(
        prepareWrite(tool, { file: "usd.xml", accountDatevId: 4266 }, refused, { fileDirs: [dir] }),
      ).rejects.toThrow("exchangeRate or foreignCurrencyDeadline");
      expect(refused.writes()).toEqual([]);
      for (const choice of [{ exchangeRate: "0.9" }, { foreignCurrencyDeadline: "2026-11-12" }]) {
        const fake = new FakeSevdeskClient([
          ...CREATE_READ_ROUTES,
          { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
          uploadRoute,
          saveRoute(),
          ...readBackRoutes(
            draftRow({
              ...usd,
              sumNetForeignCurrency: "314.86",
              sumTaxForeignCurrency: "22.04",
              sumGrossForeignCurrency: "336.90",
              sumNet: "283.37",
              sumTax: "19.84",
              sumGross: "303.21",
            }),
          ),
        ]);
        const { plan } = await executeWrite(
          tool,
          { file: "usd.xml", accountDatevId: 4266, ...choice },
          fake,
          { fileDirs: [dir] },
        );
        expect(plan.state.body.voucher).toMatchObject({ currency: "USD", status: 50 });
        expect(plan.state.body.voucherPosSave).toMatchObject([{ sumNet: 314.86, taxRate: 7 }]);
        expect(plan.previewDe?.facts).toContainEqual({ label: "Währung", value: "USD" });
        expect(fake.writes().map((call) => call.path)).toEqual([
          "/Voucher/Factory/uploadTempFile",
          "/Voucher/Factory/saveVoucher",
        ]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
