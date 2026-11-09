import { afterEach, describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { voucherCreateDraftTool as tool } from "../../../../src/tools/vouchers/draft-create.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsRoute,
  contactRoute,
  CREATE_READ_ROUTES,
  draftRow,
  guidanceRoute,
  PDF_BYTES,
  positionRow,
  readBackRoutes,
  receiptFolder,
  regularRoute,
  saveRoute,
  smallBusinessRoute,
  uploadRoute,
  version1Route,
  version2Route,
  voucherListRoute,
} from "./routes.js";

const args = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [
    { accountDatevId: 4266, amount: "119.00", taxRate: 19, comment: "Druckerpapier und Toner" },
  ],
};

const expectedBody = {
  voucher: {
    objectName: "Voucher",
    mapAll: true,
    voucherDate: "02.11.2026",
    supplier: { id: 1001, objectName: "Contact" },
    description: "ER-2026-0815",
    deliveryDate: "02.11.2026",
    status: 50,
    taxRule: { id: 9, objectName: "TaxRule" },
    creditDebit: "C",
    voucherType: "VOU",
    currency: "EUR",
  },
  voucherPosSave: [
    {
      objectName: "VoucherPos",
      mapAll: true,
      accountDatev: { id: 4266, objectName: "AccountDatev" },
      taxRate: 19,
      net: false,
      sumGross: 119,
      comment: "Druckerpapier und Toner",
      isAsset: false,
    },
  ],
  voucherPosDelete: null,
};

function client(routes: readonly FakeRoute[] = []): FakeSevdeskClient {
  return new FakeSevdeskClient([
    ...routes,
    ...CREATE_READ_ROUTES,
    saveRoute(),
    uploadRoute,
    ...readBackRoutes(),
  ]);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("sevdesk_voucher_create_draft", () => {
  it("is a write tool that may read local files", () => {
    expect(tool.tier).toBe("write");
    expect(tool.localEffects).toBe("reads-files");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.description.length).toBeLessThanOrEqual(1000);
  });

  it("creates an expense draft with tax rule 9 and the exact body (D-004: voucherPosSave)", async () => {
    const fake = client();
    const { plan, output } = await executeWrite(tool, args, fake);

    const [save] = fake.writes();
    expect(fake.writes()).toHaveLength(1);
    expect(save).toMatchObject({ method: "POST", path: "/Voucher/Factory/saveVoucher" });
    expect(save?.tier).toBe("write");
    expect(save?.body).toEqual(expectedBody);
    expect(Object.keys(save?.body as object)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
    ]);
    expect(JSON.stringify(save?.body)).not.toContain('voucherPos"');

    expect(plan.preview.action).toBe(
      "Create a draft expense voucher (Beleg) dated 2026-11-02, with 1 position, gross 119.00 EUR.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Supplier (Lieferant)",
      value: "Musterfirma GmbH (contact 1001)",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Belegnummer", value: "ER-2026-0815" });
    expect(plan.preview.facts).toContainEqual({
      label: "Position 1",
      value:
        "6815 Bürobedarf (account 4266): 119.00 EUR gross, 19 % VAT → net 100.00, tax 19.00, " +
        "gross 119.00; Druckerpapier und Toner",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Tax rule (Steuerregel)",
      value: "9 Vorsteuerabziehbare Aufwendungen",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 100.00 EUR, tax 19.00 EUR, gross 119.00 EUR",
    });
    expect(plan.preview.irreversible).toBe(false);

    expect(output.data.voucher.id).toBe(2101);
    expect(output.data.positions).toHaveLength(1);
    expect(output.data.notes).toBeUndefined();
    expect(output.affected).toEqual([{ objectName: "Voucher", id: "2101" }]);
    expect(output.summary).toBe("Created draft voucher 2101 (1 position, gross 119.00 EUR).");
  });

  it("reads before it writes and writes nothing in prepare", async () => {
    const fake = client();
    await prepareWrite(tool, args, fake);
    expect(fake.writes()).toEqual([]);
    expect(fake.calls.map((call) => call.path)).toContain("/ReceiptGuidance/forAllAccounts");
  });

  it("books revenue with tax rule 1 and creditDebit D, amounts net when asked", async () => {
    const fake = client();
    await executeWrite(
      tool,
      {
        kind: "revenue",
        supplierName: "Barverkauf Markt",
        date: "2026-11-02",
        amountMode: "net",
        positions: [{ accountDatevId: 5192, amount: "100", taxRate: "19" }],
      },
      fake,
    );
    const body = fake.writes()[0]?.body as typeof expectedBody;
    expect(body.voucher).toMatchObject({
      supplier: null,
      supplierName: "Barverkauf Markt",
      taxRule: { id: 1, objectName: "TaxRule" },
      creditDebit: "D",
    });
    expect(body.voucherPosSave[0]).toEqual({
      objectName: "VoucherPos",
      mapAll: true,
      accountDatev: { id: 5192, objectName: "AccountDatev" },
      taxRate: 19,
      net: true,
      sumNet: 100,
      isAsset: false,
    });
  });

  it("defaults to tax rule 10 with 0 % on a Kleinunternehmer account", async () => {
    // The recorded guidance is a regular-VAT account: 4266 does not allow rule 10, which shows
    // the default reached the ReceiptGuidance check with rule 10 and rate 0.
    const message = await refusal(
      prepareWrite(
        tool,
        { ...args, positions: [{ accountDatevId: 4266, amount: "119.00" }] },
        client([smallBusinessRoute]),
      ),
    );
    expect(message).toContain(
      "Position 1: Tax rule 10 (NICHT_VORST_ABZUGSF_AUFW) is not allowed with account 4266 " +
        "(no. 6815).",
    );
  });

  it("attaches a receipt: uploads first, then sends filename at the top level, last (B5)", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const fake = client();
    const { plan, output } = await executeWrite(
      tool,
      { ...args, file: "Rechnung-0815.pdf" },
      fake,
      { fileDirs: [folder.dir] },
    );

    expect(fake.writes().map((call) => call.path)).toEqual([
      "/Voucher/Factory/uploadTempFile",
      "/Voucher/Factory/saveVoucher",
    ]);
    const [upload, save] = fake.writes();
    expect(upload?.tier).toBe("write");
    const part = upload?.form?.get("file");
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe("Rechnung-0815.pdf");
    expect((part as File).type).toBe("application/pdf");
    expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(PDF_BYTES);

    expect(Object.keys(save?.body as object)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
      "filename",
    ]);
    expect((save?.body as { filename: string }).filename).toBe(
      "f019bec36c65f5a0e7d2c63cc33f0681.pdf",
    );
    expect((save?.body as { voucher: object }).voucher).not.toHaveProperty("filename");

    expect(plan.preview.action).toContain(", and attach the receipt file.");
    expect(plan.preview.action).not.toContain("Rechnung-0815");
    expect(plan.preview.facts.find((f) => f.label === "Receipt file (Belegbild)")?.value).toMatch(
      /^Rechnung-0815\.pdf \(PDF, \d+ bytes, SHA-256 [0-9a-f]{16}…\)$/,
    );
    expect(output.data.receipt).toEqual({
      name: "Rechnung-0815.pdf",
      kind: "pdf",
      bytes: PDF_BYTES.length,
      pages: 1,
    });
    expect(output.summary).toContain("receipt attached");
    // The read-back draft has `document: null`: the read-back says so.
    expect(output.data.notes).toEqual([
      "sevDesk reports no attached file although the receipt was uploaded and sent as the " +
        "voucher's filename. Check the voucher in sevDesk and attach the receipt there.",
    ]);
  });

  it("notes when the read-back does not say whether the file is attached (D-044)", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const withoutKey = draftRow();
    delete withoutKey["document"];
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      saveRoute(),
      uploadRoute,
      ...readBackRoutes(withoutKey),
    ]);
    const { output } = await executeWrite(tool, { ...args, file: folder.file }, fake, {
      fileDirs: [folder.dir],
    });
    expect(output.data.notes?.[0]).toContain("does not say whether the receipt file is attached");
  });

  it("hints at the e-invoice import when sevDesk recognizes the file as an e-invoice", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const upload = {
      method: "POST" as const,
      path: "/Voucher/Factory/uploadTempFile",
      response: { body: { objects: { filename: "abc.pdf", pages: 1, isEInvoice: true } } },
    };
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      upload,
      saveRoute(),
      ...readBackRoutes(draftRow({ document: { id: "7101", objectName: "Document" } })),
    ]);
    const { output } = await executeWrite(tool, { ...args, file: folder.file }, fake, {
      fileDirs: [folder.dir],
    });
    expect(output.data.notes).toEqual([
      "sevDesk recognized the attached file as an e-invoice. Its data was not used: " +
        "sevdesk_voucher_import_einvoice can check it and prefill a voucher from it.",
    ]);
  });

  it("refuses a file when SEVDESK_FILE_DIRS is not set, before any request", async () => {
    const fake = client();
    const message = await refusal(prepareWrite(tool, { ...args, file: "beleg.pdf" }, fake));
    expect(message).toContain("SEVDESK_FILE_DIRS is not set");
    expect(fake.calls).toEqual([]);
  });

  it("says the upload happened but nothing was saved when the save fails", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      uploadRoute,
      {
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        response: {
          error: new SevdeskError({ kind: "validation", status: 422, message: "Rejected." }),
        },
      },
    ]);
    const error = await executeWrite(tool, { ...args, file: folder.file }, fake, {
      fileDirs: [folder.dir],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    const failure = error as SevdeskError;
    expect(failure.kind).toBe("validation");
    expect(failure.status).toBe(422);
    expect(failure.message).toBe(
      "Rejected. The receipt file had been uploaded to sevDesk's temporary file storage first; " +
        "that upload is not a voucher or a document and needs no cleanup. The voucher was not " +
        "saved.",
    );
    expect(failure.completedWrites).toEqual([]);
  });

  it("says the outcome is unknown when the save times out after the upload", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      uploadRoute,
      {
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        response: { error: new SevdeskError({ kind: "timeout", message: "Timed out." }) },
      },
    ]);
    const error = (await executeWrite(tool, { ...args, file: folder.file }, fake, {
      fileDirs: [folder.dir],
    }).catch((caught: unknown) => caught)) as SevdeskError;
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("Whether the voucher itself was saved is unknown");
  });

  it("passes a save failure without upload through unchanged", async () => {
    const failure = new SevdeskError({ kind: "validation", message: "Rejected." });
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      { method: "POST", path: "/Voucher/Factory/saveVoucher", response: { error: failure } },
    ]);
    await expect(executeWrite(tool, args, fake)).rejects.toBe(failure);
  });

  it("refuses a bookkeeping 1.0 account", async () => {
    const message = await refusal(prepareWrite(tool, args, client([version1Route])));
    expect(message).toContain("still uses bookkeeping system 1.0. Voucher writes need sevDesk");
  });

  it("refuses a revenue rule on an expense voucher", async () => {
    const message = await refusal(prepareWrite(tool, { ...args, taxRuleId: 1 }, client()));
    expect(message).toBe(
      "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) cannot be used for expense vouchers. Use " +
        "tax rule 8, 9, 10, 12, 13, 14, 15, 16; sevdesk_reference_lookup kind=tax_rules " +
        "explains them.",
    );
  });

  it("refuses tax rules 18–21 on vouchers", async () => {
    const message = await refusal(
      prepareWrite(
        tool,
        {
          ...args,
          kind: "revenue",
          taxRuleId: 21,
          positions: [{ accountDatevId: 5192, amount: "1" }],
        },
        client(),
      ),
    );
    expect(message).toContain("is not supported for vouchers");
  });

  it("refuses a rule that does not fit the Kleinunternehmer regime", async () => {
    const message = await refusal(
      prepareWrite(tool, { ...args, taxRuleId: 9 }, client([smallBusinessRoute])),
    );
    expect(message).toContain("Kleinunternehmer regulation (§19 UStG), so tax rule 9");
    expect(message).toContain("Use tax rule 10 or 13 or 15 or 16.");
  });

  it("refuses a rate the rule does not allow", async () => {
    const message = await refusal(
      prepareWrite(
        tool,
        { ...args, positions: [{ accountDatevId: 4266, amount: "116", taxRate: 16 }] },
        client(),
      ),
    );
    expect(message).toContain("Position 1 has a tax rate of 16 %");
  });

  it("refuses account × rule × rate combinations the ReceiptGuidance rejects (B2)", async () => {
    const fake = client();
    const message = await refusal(
      prepareWrite(
        tool,
        { ...args, positions: [{ accountDatevId: 5192, amount: "119", taxRate: 19 }] },
        fake,
      ),
    );
    expect(message).toContain("Position 1: account 5192 (no. 4400) cannot be used for expense");
    expect(message).toContain("Tax rule 9 (VORST_ABZUGSF_AUFW) is not allowed");
    expect(message).toContain("Nothing was sent to sevDesk.");
    expect(fake.writes()).toEqual([]);
  });

  it("refuses an unknown supplier contact", async () => {
    const message = await refusal(
      prepareWrite(tool, { ...args, supplierId: 4242 }, client([missingContact(4242)])),
    );
    expect(message).toBe(
      "Contact 4242 does not exist in sevDesk. Find the supplier with sevdesk_contacts_search, " +
        "or pass supplierName instead of supplierId.",
    );
  });

  it("needs exactly one of supplierId and supplierName", async () => {
    expect(await refusal(prepareWrite(tool, { ...args, supplierName: "X" }, client()))).toBe(
      "Pass either supplierId (a contact) or supplierName (text), not both.",
    );
    const { supplierId: _drop, ...noSupplier } = args;
    expect(await refusal(prepareWrite(tool, noSupplier, client()))).toContain(
      "Name the supplier (Lieferant",
    );
  });

  it("refuses a delivery period that ends before it starts", async () => {
    const message = await refusal(
      prepareWrite(
        tool,
        { ...args, deliveryDate: "2026-11-02", deliveryDateUntil: "2026-11-01" },
        client(),
      ),
    );
    expect(message).toContain("deliveryDateUntil 2026-11-01 is before the delivery date");
  });

  it("refuses a duplicate unless allowDuplicate, then warns", async () => {
    const duplicate = {
      ...draftRow(),
      id: "2050",
      voucherDate: "2026-11-02T00:00:00+01:00",
      status: "100",
    };
    const routes = [voucherListRoute([duplicate])];
    const message = await refusal(prepareWrite(tool, args, client(routes)));
    expect(message).toBe(
      "Possible duplicate: voucher 2050 with the same supplier, Belegnummer, date (2026-11-02) " +
        "and gross total (119.00 EUR) already exists. Check it with sevdesk_voucher_get; if " +
        "this really is another receipt, call again with allowDuplicate: true.",
    );
    const { preview } = await prepareWrite(tool, { ...args, allowDuplicate: true }, client(routes));
    expect(preview.warnings[0]).toContain(
      "Possible duplicate (allowDuplicate is set): voucher 2050",
    );
  });

  it("ignores vouchers that differ in Belegnummer, gross or supplier", async () => {
    const rows = [
      { ...draftRow(), id: "2051", description: "ER-2026-0816" },
      { ...draftRow(), id: "2052", sumGross: "118" },
      { ...draftRow(), id: "2053", supplier: { id: "1002", objectName: "Contact" } },
    ];
    const { preview } = await prepareWrite(tool, args, client([voucherListRoute(rows)]));
    expect(preview.warnings.join(" ")).not.toContain("duplicate");
  });

  it("notes a gross total that differs from the preview", async () => {
    const fake = new FakeSevdeskClient([
      ...CREATE_READ_ROUTES,
      saveRoute(),
      ...readBackRoutes(draftRow({ sumGross: "120" }), [positionRow()]),
    ]);
    const { output } = await executeWrite(tool, args, fake);
    expect(output.data.notes).toEqual([
      "sevDesk computed a gross total of 120.00 EUR; the preview expected 119.00 EUR. Check the " +
        "positions and amountMode (gross/net) before finalizing.",
    ]);
  });

  it("warns about a payment deadline before the voucher date", async () => {
    const { preview } = await prepareWrite(
      tool,
      { ...args, paymentDeadline: "2026-11-01" },
      client(),
    );
    expect(preview.warnings).toContain(
      "The payment deadline 2026-11-01 is before the voucher date 2026-11-02.",
    );
    expect(preview.facts).toContainEqual({
      label: "Payment deadline (Fälligkeit)",
      value: "2026-11-01",
    });
  });

  it("keeps working when the undocumented AccountDatev list fails (labels from the guidance)", async () => {
    const fake = new FakeSevdeskClient([
      {
        path: "/AccountDatev",
        response: { error: new SevdeskError({ kind: "server", message: "Down." }) },
      },
      version2Route,
      regularRoute,
      guidanceRoute,
      contactRoute,
      voucherListRoute(),
    ]);
    const { preview } = await prepareWrite(tool, args, fake);
    expect(preview.facts.find((f) => f.label === "Position 1")?.value).toMatch(
      /^6815 Bürobedarf \(account 4266\)/,
    );
  });

  it("rethrows an AccountDatev failure that breaks every read (auth)", async () => {
    const auth = new SevdeskError({ kind: "auth", status: 401, message: "Token rejected." });
    const fake = new FakeSevdeskClient([
      { path: "/AccountDatev", response: { error: auth } },
      ...CREATE_READ_ROUTES.filter((route) => route !== accountsRoute),
    ]);
    await expect(prepareWrite(tool, args, fake)).rejects.toBe(auth);
  });
});

function missingContact(id: number): FakeRoute {
  return {
    path: `/Contact/${String(id)}`,
    response: { error: new SevdeskError({ kind: "not_found", message: "Not found." }) },
  };
}
