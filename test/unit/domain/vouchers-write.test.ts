/**
 * The voucher write domain below the tools: tax rule defaults per kind and regime, rates,
 * expected totals, account labels, duplicates, the strict saveVoucher body, the upload answer
 * (B6) and the e-invoice import mapping.
 */
import { describe, expect, it } from "vitest";

import { strictBody } from "../../../src/domain/drafts/payloads.js";
import {
  executeVoucherSave,
  prepareVoucherCreateSpec,
} from "../../../src/domain/drafts/voucher.js";
import {
  duplicateCheck,
  exactRate,
  expectedVoucherTotals,
  findVoucherDuplicates,
  resolveVoucherPositions,
  resolveVoucherRule,
  voucherAccountLabel,
  voucherRuleScope,
} from "../../../src/domain/drafts/voucher-checks.js";
import {
  assertImportable,
  importedVoucher,
  importRuleId,
  type VatBreakdownRow,
  type VoucherSuggestion,
} from "../../../src/domain/drafts/voucher-import.js";
import {
  exactJsonNumber,
  readUploadAnswer,
  saveVoucherBodySchema,
  uploadForm,
  voucherPosDelete,
} from "../../../src/domain/drafts/voucher-payload.js";
import { money } from "../../../src/domain/money.js";
import type { ReceiptGuide } from "../../../src/domain/receipt-guidance.js";
import { type TaxRule, taxRuleById } from "../../../src/domain/reference-data.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";
import {
  CREATE_READ_ROUTES,
  draftRow,
  readBackRoutes,
  saveRoute,
  voucherListRoute,
} from "../tools/vouchers/routes.js";

function rule(id: number): TaxRule {
  const found = taxRuleById(id);
  if (found === undefined) throw new Error(`no rule ${String(id)}`);
  return found;
}

function refusal(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    return (error as SevdeskError).message;
  }
}

describe("resolveVoucherRule", () => {
  it.each([
    ["expense", "regular", 9],
    ["expense", "small_business", 10],
    ["revenue", "regular", 1],
    ["revenue", "small_business", 11],
  ] as const)("defaults a %s voucher on a %s account to rule %d", (kind, regime, id) => {
    const resolved = resolveVoucherRule(kind, undefined, regime);
    expect(resolved.rule.id).toBe(id);
  });

  it("uses the regular default and warns when the regime is unknown", () => {
    const resolved = resolveVoucherRule("expense", undefined, undefined);
    expect(resolved.rule.id).toBe(9);
    expect(resolved.warnings[0]).toContain("could not be read");
  });

  it("scopes rules by direction, either-rules included, 18–21 refused later", () => {
    expect(voucherRuleScope("expense").allowedRuleIds).toEqual([8, 9, 10, 12, 13, 14, 15, 16]);
    expect(voucherRuleScope("revenue").allowedRuleIds).toEqual([
      1, 2, 3, 4, 5, 11, 15, 17, 18, 19, 20, 21, 22,
    ]);
    for (const id of [18, 19, 20, 21]) {
      expect(refusal(() => resolveVoucherRule("revenue", id, "regular"))).toContain(
        "is not supported for vouchers",
      );
    }
    expect(refusal(() => resolveVoucherRule("expense", 99, "regular"))).toContain(
      "Tax rule 99 does not exist.",
    );
  });
});

describe("positions", () => {
  it("defaults the only rate of a rule and converts rates exactly", () => {
    const positions = resolveVoucherPositions(
      rule(10),
      [{ accountDatevId: 1, amount: "10" }],
      "small_business",
    );
    expect(positions[0]).toMatchObject({ taxRate: "0", taxRateNumber: 0, isAsset: false });
    expect(exactRate("19", 0)).toBe(19);
    expect(exactRate("5.5", 0)).toBe(5.5);
    for (const bad of ["1e1", "101", "-1", "abc"]) {
      expect(refusal(() => exactRate(bad, 1))).toBe(
        "Position 2 has a tax rate that is not a plain percentage.",
      );
    }
  });

  it("computes the totals sevDesk will show, per position rounded", () => {
    const positions = resolveVoucherPositions(
      rule(9),
      [
        { accountDatevId: 1, amount: "10.01", taxRate: "19" },
        { accountDatevId: 1, amount: "10.01", taxRate: "7" },
      ],
      "regular",
    );
    expect(expectedVoucherTotals(positions, "net")).toEqual({
      net: "20.02",
      tax: "2.60",
      gross: "22.62",
    });
    expect(expectedVoucherTotals(positions, "gross")).toEqual({
      net: "17.77",
      tax: "2.25",
      gross: "20.02",
    });
  });
});

describe("voucherAccountLabel", () => {
  const guides: ReceiptGuide[] = [
    {
      accountDatevId: 7,
      accountNumber: "6815",
      accountName: "Bürobedarf",
      receiptTypes: [],
      taxRules: [],
    },
    { accountDatevId: 8, accountNumber: "X-1", receiptTypes: [], taxRules: [] },
  ];

  it("falls back from AccountDatev to the guidance to the bare id", () => {
    const accounts = {
      accounts: [
        { id: 7, number: "4930", name: "Bürobedarf 03", kind: "expense" as const, active: true },
      ],
      truncated: false,
    };
    expect(voucherAccountLabel(accounts, guides, 7)).toBe("4930 Bürobedarf 03 (account 7)");
    expect(voucherAccountLabel(undefined, guides, 7)).toBe("6815 Bürobedarf (account 7)");
    expect(voucherAccountLabel(undefined, guides, 8)).toBe("account 8");
    expect(voucherAccountLabel(undefined, guides, 9)).toBe("account 9");
  });
});

describe("duplicates", () => {
  const query = {
    kind: "expense" as const,
    supplierName: "Tankstelle Nord",
    date: "2026-11-02",
    gross: "119.00",
  };

  it("matches a typed-in supplier by name, without a Belegnummer", async () => {
    const rows = [
      draftRow({ id: "2060", supplier: null, supplierName: "tankstelle nord", description: null }),
      draftRow({ id: "2061", supplier: null, supplierName: "Andere", description: null }),
      draftRow({ id: "2062", supplier: null, supplierName: "Tankstelle Nord", currency: "USD" }),
    ];
    const fake = new FakeSevdeskClient([voucherListRoute(rows)]);
    expect(await findVoucherDuplicates(fake, query, undefined)).toEqual([2060]);
    expect(fake.calls[0]?.query).toMatchObject({
      creditDebit: "C",
      supplierName: "Tankstelle Nord",
      limit: 25,
    });
  });

  it("refuses several at once and words the warning without a Belegnummer", () => {
    expect(refusal(() => duplicateCheck([1, 2], query, false))).toBe(
      "Possible duplicate: vouchers 1, 2 with the same supplier, date (2026-11-02) and gross " +
        "total (119.00 EUR) already exist. Check it with sevdesk_voucher_get; if this really is " +
        "another receipt, call again with allowDuplicate: true.",
    );
    expect(duplicateCheck([1, 2], query, true)).toBe(
      "Possible duplicate (allowDuplicate is set): vouchers 1, 2 with the same supplier, date " +
        "(2026-11-02) and gross total (119.00 EUR) already exist.",
    );
    expect(duplicateCheck([], query, false)).toBeUndefined();
  });
});

describe("saveVoucher body (D-003, D-004, D-026)", () => {
  const voucher = {
    objectName: "Voucher",
    mapAll: true,
    voucherDate: "02.11.2026",
    supplier: null,
    supplierName: "X",
    deliveryDate: "02.11.2026",
    status: 50,
    taxRule: { id: 9, objectName: "TaxRule" },
    creditDebit: "C",
    voucherType: "VOU",
    currency: "EUR",
  };
  const position = (extra: Record<string, unknown>) => ({
    objectName: "VoucherPos",
    mapAll: true,
    accountDatev: { id: 1, objectName: "AccountDatev" },
    taxRate: 19,
    isAsset: false,
    ...extra,
  });

  it("keeps the key order voucher, voucherPosSave, voucherPosDelete, filename", () => {
    const body = strictBody(
      saveVoucherBodySchema,
      {
        filename: "abc.pdf",
        voucherPosDelete: null,
        voucherPosSave: [position({ net: false, sumGross: 1 })],
        voucher,
      },
      "voucher",
    );
    expect(Object.keys(body)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
      "filename",
    ]);
  });

  it.each([
    ["the spec's non-existent voucherPos", { voucherPos: [] }],
    ["a filename inside voucher", { voucher: { ...voucher, filename: "abc.pdf" } }],
    ["a derived voucher sum", { voucher: { ...voucher, sumGross: 1 } }],
    ["a legacy taxType", { voucher: { ...voucher, taxType: "default" } }],
    ["status 1000", { voucher: { ...voucher, status: 1000 } }],
    ["both position sums", { voucherPosSave: [position({ net: true, sumNet: 1, sumGross: 1 })] }],
    ["the wrong position sum", { voucherPosSave: [position({ net: true, sumGross: 1 })] }],
    [
      "mixed net and gross positions",
      {
        voucherPosSave: [position({ net: true, sumNet: 1 }), position({ net: false, sumGross: 1 })],
      },
    ],
    ["a filename that is not a token", { filename: "../etc/passwd" }],
  ])("refuses %s as an internal error", (_label, change) => {
    const body = {
      voucher,
      voucherPosSave: [position({ net: false, sumGross: 1 })],
      voucherPosDelete: null,
      ...change,
    };
    expect(() => strictBody(saveVoucherBodySchema, body, "voucher")).toThrow(
      /^Internal error: the voucher payload does not match its schema/,
    );
  });

  it("deletes stored positions as an array of refs (D-054, recorded)", () => {
    expect(voucherPosDelete([])).toBeNull();
    expect(voucherPosDelete([3, 4])).toEqual([
      { id: 3, objectName: "VoucherPos" },
      { id: 4, objectName: "VoucherPos" },
    ]);
  });

  it("sends exact JSON numbers only", () => {
    expect(exactJsonNumber("119.5")).toBe(119.5);
    expect(refusal(() => exactJsonNumber("12345678901234567.89"))).toBe(
      "An amount has too many digits to be sent to sevDesk exactly; use a smaller amount with " +
        "at most 2 decimals.",
    );
  });
});

describe("receipt upload (D-011, B6)", () => {
  it("builds one multipart part `file` with the sniffed MIME type", async () => {
    for (const [kind, type] of [
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
      ["xml", "application/xml"],
      ["pdf", "application/pdf"],
    ] as const) {
      const form = uploadForm({ name: `beleg.${kind}`, kind, bytes: new Uint8Array([1, 2]) });
      expect([...form.keys()]).toEqual(["file"]);
      const part = form.get("file") as File;
      expect(part.type).toBe(type);
      expect(part.name).toBe(`beleg.${kind}`);
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    }
  });

  it("keeps the token and page count, never the preview content", () => {
    const objects = (loadFixture("vouchers/upload-temp-file.json").body as { objects: unknown })
      .objects;
    const answer = readUploadAnswer(objects);
    expect(answer).toEqual({ filename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf", pages: 1 });
    expect(JSON.stringify(answer)).not.toContain("PREVIEW");
    expect(readUploadAnswer({ filename: "a.pdf", isEInvoice: false })).toEqual({
      filename: "a.pdf",
    });
    expect(readUploadAnswer({ filename: "a.pdf", isEInvoice: "1" })).toEqual({
      filename: "a.pdf",
      isEInvoice: true,
    });
    expect(() => readUploadAnswer({ content: ["x"] })).toThrow(SevdeskError);
    expect(() => readUploadAnswer({ filename: "../x" })).toThrow(SevdeskError);
  });
});

describe("e-invoice import mapping", () => {
  const eur = (amount: string) => money(amount, "EUR");
  const suggestion = (overrides: Partial<VoucherSuggestion> = {}): VoucherSuggestion => ({
    kind: "expense",
    counterparty: { name: "Lieferant GmbH", vatId: "DE123456789" },
    supplierCandidates: [],
    taxRuleId: 9,
    taxRuleReason: "VAT category S at 19 % and 7 %: input VAT deductible (rule 9).",
    voucherDate: "2026-11-02",
    number: "RE-4711",
    deliveryDate: "2026-11-01",
    paymentDeadline: "2026-11-16",
    currency: "EUR",
    totals: { net: eur("150"), tax: eur("22.5"), gross: eur("172.5"), due: eur("172.5") },
    blocking: [],
    warnings: ["BR-DE-15: buyer reference missing."],
    ...overrides,
  });
  const breakdown: VatBreakdownRow[] = [
    { category: "S", rate: "19", taxableAmount: "100.00", taxAmount: "19.00" },
    { category: "S", rate: "7.00", taxableAmount: "50.00", taxAmount: "3.50" },
  ];

  it("refuses blocking findings and foreign currency", () => {
    expect(
      refusal(() => {
        assertImportable(suggestion({ blocking: ["The totals do not add up."] }));
      }),
    ).toBe(
      "This e-invoice cannot be imported as a voucher: The totals do not add up. Nothing was " +
        "sent to sevDesk. Create the voucher with sevdesk_voucher_create_draft from the checked " +
        "invoice and attach the file there.",
    );
    expect(
      refusal(() => {
        assertImportable(suggestion({ currency: "CHF" }));
      }),
    ).toContain("not in EUR");
    expect(
      refusal(() => {
        assertImportable(suggestion());
      }),
    ).toBeUndefined();
    expect(
      refusal(() => importedVoucher(suggestion(), [], { accountDatevId: 1 }, rule(9), "regular")),
    ).toContain("no VAT breakdown");
  });

  it("maps one net position per BG-23 row (original rates) to the caller's accounts", () => {
    const { spec, extras } = importedVoucher(
      suggestion(),
      breakdown,
      { accountDatevId: 4266, accounts: [{ taxRate: "7", accountDatevId: 4236 }] },
      rule(9),
      "regular",
    );
    expect(spec).toEqual({
      kind: "expense",
      supplierName: "Lieferant GmbH",
      number: "RE-4711",
      date: "2026-11-02",
      deliveryDate: "2026-11-01",
      deliveryDateUntil: undefined,
      paymentDeadline: "2026-11-16",
      taxRule: 9,
      amountsAre: "net",
      positions: [
        { accountDatevId: 4266, amount: "100", taxRate: "19", comment: "E-Rechnung, USt 19 % (S)" },
        { accountDatevId: 4236, amount: "50", taxRate: "7", comment: "E-Rechnung, USt 7 % (S)" },
      ],
      allowDuplicate: false,
    });
    expect(extras.facts).toContainEqual({
      label: "Issuer (from the e-invoice)",
      value: "Lieferant GmbH, VAT id DE123456789",
    });
    expect(extras.warnings).toEqual([
      "BR-DE-15: buyer reference missing.",
      "No sevDesk contact matches the issuer; the voucher is saved with the issuer's name only. " +
        "Pass supplierId to link a contact.",
    ]);
    expect(() =>
      extras.checkTotals?.({ net: "150.00", tax: "22.50", gross: "172.50" }, [], rule(9)),
    ).not.toThrow();
    expect(
      refusal(() =>
        extras.checkTotals?.({ net: "150.00", tax: "22.51", gross: "172.51" }, [], rule(9)),
      ),
    ).toContain("does not match the e-invoice totals");
  });

  it("lets the caller's supplier and rule win, and names several candidates", () => {
    const withCandidates = suggestion({
      supplierCandidates: [
        { contactId: 1, matchedBy: "name" },
        { contactId: 2, matchedBy: "name" },
      ],
    });
    expect(importRuleId(withCandidates, { taxRuleId: 8 })).toBe(8);
    expect(importRuleId(withCandidates, {})).toBe(9);
    const { spec, extras } = importedVoucher(
      withCandidates,
      breakdown,
      { accountDatevId: 1, supplierId: 1003, taxRuleId: 9 },
      rule(9),
      "regular",
    );
    expect(spec.supplierId).toBe(1003);
    expect(spec.supplierName).toBeUndefined();
    expect(extras.facts?.map((fact) => fact.label)).not.toContain("Tax rule basis");
    const named = importedVoucher(
      withCandidates,
      breakdown,
      { accountDatevId: 1 },
      rule(9),
      "regular",
    );
    expect(named.extras.warnings).toContain(
      "The issuer matches several contacts (1, 2); the voucher is saved with the issuer's name " +
        "only. Pass supplierId to link one.",
    );
  });

  it("folds VAT into the gross amount at 0 % under a 0 %-only rule, checking gross only", () => {
    const { spec, extras } = importedVoucher(
      suggestion({
        totals: { net: eur("150"), tax: eur("22.5"), gross: eur("172.5"), due: eur("100") },
      }),
      breakdown,
      { accountDatevId: 1 },
      rule(10),
      "small_business",
    );
    expect(spec.positions.map((position) => [position.amount, position.taxRate])).toEqual([
      ["119", "0"],
      ["53.5", "0"],
    ]);
    expect(extras.warnings).toContain(
      "Tax rule 10 allows no input-VAT deduction, so the VAT of 19, 7 % is booked as part of " +
        "the gross amount at 0 % (Kleinunternehmer, §19 UStG).",
    );
    expect(extras.warnings?.at(-1)).toContain("The amount due (100.00 EUR) differs");
    expect(() =>
      extras.checkTotals?.({ net: "172.50", tax: "0.00", gross: "172.50" }, [], rule(10)),
    ).not.toThrow();
    expect(
      refusal(() =>
        extras.checkTotals?.({ net: "172.51", tax: "0.00", gross: "172.51" }, [], rule(10)),
      ),
    ).toContain("does not match the e-invoice totals");
  });

  it("uses the module's fold reason under the suggested rule, its own text under an override", () => {
    const folding = suggestion({ taxRuleId: 10, foldVatReason: "Rule 10: VAT not deductible." });
    expect(
      importedVoucher(folding, breakdown, { accountDatevId: 1 }, rule(10), "regular").extras
        .warnings,
    ).toContain("Rule 10: VAT not deductible.");
    const override = importedVoucher(
      folding,
      breakdown,
      { accountDatevId: 1, taxRuleId: 10 },
      rule(10),
      "regular",
    );
    expect(override.extras.warnings).toContain(
      "Tax rule 10 allows no input-VAT deduction, so the VAT of 19, 7 % is booked as part of " +
        "the gross amount at 0 %.",
    );
  });

  it("does not fold under a rule that allows the invoice's rates (override back to 9)", () => {
    const { spec } = importedVoucher(
      suggestion({ taxRuleId: 10, foldVatReason: "folded" }),
      breakdown,
      { accountDatevId: 1, taxRuleId: 9 },
      rule(9),
      "regular",
    );
    expect(spec.positions.map((position) => [position.amount, position.taxRate])).toEqual([
      ["100", "19"],
      ["50", "7"],
    ]);
  });

  it("refuses a rate without an account and a non-positive or sub-cent row", () => {
    expect(
      refusal(() =>
        importedVoucher(
          suggestion(),
          breakdown,
          { accounts: [{ taxRate: "19", accountDatevId: 1 }] },
          rule(9),
          "regular",
        ),
      ),
    ).toContain("VAT rate of 7 % without a booking account");
    const negative: VatBreakdownRow[] = [
      { category: "S", rate: "19", taxableAmount: "-1", taxAmount: "0" },
    ];
    expect(
      refusal(() =>
        importedVoucher(suggestion(), negative, { accountDatevId: 1 }, rule(9), "regular"),
      ),
    ).toContain("zero, negative or sub-cent amount");
    const exempt: VatBreakdownRow[] = [
      { category: "E", taxableAmount: "10", taxAmount: "0", exemptionReason: "§4" },
    ];
    expect(
      importedVoucher(suggestion(), exempt, { accountDatevId: 1 }, rule(9), "regular").spec
        .positions,
    ).toEqual([
      { accountDatevId: 1, amount: "10", taxRate: "0", comment: "E-Rechnung, USt 0 % (E)" },
    ]);
  });

  it("runs the full create check with the import's extras, no third-party text in the action", async () => {
    const { spec, extras } = importedVoucher(
      suggestion({
        totals: { net: eur("100"), tax: eur("19"), gross: eur("119"), due: eur("119") },
      }),
      [breakdown[0] as VatBreakdownRow],
      { accountDatevId: 4266 },
      rule(9),
      "regular",
    );
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      voucherListRoute(),
      saveRoute(),
      ...readBackRoutes(),
    ]);
    const plan = await prepareVoucherCreateSpec(
      fake,
      spec,
      { name: "rechnung.xml", kind: "xml", bytes: new TextEncoder().encode("<Invoice/>") },
      { cacheOwner: {}, fileDirs: [] },
      extras,
    );
    expect(plan.preview.action).toBe(
      "Create a draft expense voucher (Beleg) dated 2026-11-02 from an e-invoice, with 1 " +
        "position, gross 119.00 EUR, and attach the receipt file.",
    );
    expect(plan.preview.facts).toContainEqual({ label: "Belegnummer", value: "RE-4711" });
    expect(plan.state.body.voucherPosSave?.[0]).toMatchObject({
      net: true,
      sumNet: 100,
      taxRate: 19,
    });
    expect(fake.writes()).toEqual([]);
    const result = await executeVoucherSave(
      new FakeSevdeskClient([
        {
          method: "POST",
          path: "/Voucher/Factory/uploadTempFile",
          response: { fixture: "vouchers/upload-temp-file.json" },
        },
        saveRoute(),
        ...readBackRoutes(),
      ]),
      plan.state,
      undefined,
    );
    expect(result.receipt).toEqual({ name: "rechnung.xml", kind: "xml", bytes: 10, pages: 1 });
  });
});
