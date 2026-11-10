import { describe, expect, it } from "vitest";

import type { Tier } from "../../../../src/safety/tiers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { sendEmailTool } from "../../../../src/tools/lifecycle/send-email.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
  type Row,
  StagedClient,
  writeRoute,
} from "./helpers.js";

const tool = sendEmailTool("invoice");
const message = {
  to: "kunde@example.com",
  subject: "Ihre Rechnung",
  text: "Guten Tag,\nanbei Ihre Rechnung.",
};

function staged(before: Row, after: Row = before): StagedClient {
  return new StagedClient(
    [documentRoute("invoice", before)],
    [
      writeRoute("POST", "/Invoice/1001/sendViaEmail", "invoice-send-via-email.json"),
      documentRoute("invoice", after),
    ],
  );
}

describe("sevdesk_invoice_send_email (spec request body; community record shapes)", () => {
  it("is an external tool that reaches the open world", () => {
    expect(tool.name).toBe("sevdesk_invoice_send_email");
    expect(tool.tier).toBe("external");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("posts exactly the email body, stamped external, and reads the invoice back", async () => {
    const draft = invoiceRow({ status: "100", invoiceNumber: null });
    const client = staged(draft, invoiceRow({ status: "200", sendType: "VM" }));

    const { output } = await executeWrite(
      tool,
      {
        id: 1001,
        ...message,
        cc: ["buchhaltung@example.com"],
        bcc: ["archiv@example.com"],
        sendCopyToMe: true,
        attachXml: true,
      },
      client,
    );

    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/Invoice/1001/sendViaEmail",
        tier: "external",
        body: {
          toEmail: "kunde@example.com",
          subject: "Ihre Rechnung",
          text: "Guten Tag,\nanbei Ihre Rechnung.",
          copy: true,
          ccEmail: "buchhaltung@example.com",
          bccEmail: "archiv@example.com",
          sendXml: true,
        },
      }),
    ]);
    expect(client.calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(output.data["invoice"]).toMatchObject({ status: { code: 200 }, sent: { via: "email" } });
    expect(output.data["email"]).toEqual({
      to: "kunde@example.com",
      cc: ["buchhaltung@example.com"],
      bcc: ["archiv@example.com"],
      sendCopyToMe: true,
      attachment: "xml",
    });
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1001" }]);
    expect(output.summary).toBe("Invoice 1001 emailed to 3 recipients: status Open / due (200).");
  });

  it("names every recipient, the subject and the full text in an irreversible preview", async () => {
    const client = staged(invoiceRow({ status: "100", invoiceNumber: null }));

    const plan = await prepareWrite(
      tool,
      { id: 1001, ...message, cc: ["a@example.com"], bcc: ["b@example.com"], sendCopyToMe: true },
      client,
    );

    expect(client.writes()).toEqual([]);
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.preview.action).toBe(
      "Email invoice 1001 (no number yet) through sevDesk to kunde@example.com and 2 more " +
        "recipients (cc/bcc).",
    );
    expect(plan.preview.facts.slice(-7)).toEqual([
      { label: "To", value: "kunde@example.com" },
      { label: "Cc", value: "a@example.com" },
      { label: "Bcc", value: "b@example.com" },
      { label: "Copy to you", value: "yes, to the sevDesk user's own address" },
      { label: "Attachment", value: "the invoice PDF" },
      { label: "Subject", value: "Ihre Rechnung" },
      { label: "Text", value: "Guten Tag,\nanbei Ihre Rechnung." },
    ]);
    expect(plan.preview.warnings).toEqual([
      "The email goes out from sevDesk immediately to every recipient listed and cannot be " +
        "recalled.",
      "The invoice is a draft: sending finalizes it (draft → open), sevDesk assigns its final " +
        "number and it becomes legally binding. If the account enshrines documents on " +
        "completion, it is also enshrined (festgeschrieben).",
    ]);
  });

  it("sends an open invoice again without a draft warning, and minimal fields only", async () => {
    const client = staged(invoiceRow());

    const { plan, output } = await executeWrite(tool, { id: 1001, ...message }, client);

    expect(plan.preview.action).toBe("Email invoice RE-1001 through sevDesk to kunde@example.com.");
    expect(plan.preview.warnings).toHaveLength(1);
    expect(client.writes()[0]?.body).toEqual({
      toEmail: "kunde@example.com",
      subject: "Ihre Rechnung",
      text: "Guten Tag,\nanbei Ihre Rechnung.",
    });
    expect(output.data["email"]).toEqual({
      to: "kunde@example.com",
      sendCopyToMe: false,
      attachment: "pdf",
    });
    expect(output.summary).toContain("emailed to 1 recipient:");
  });

  it("warns that XML is only attached to e-invoices when sevDesk does not say", async () => {
    const plan = await prepareWrite(
      tool,
      { id: 1001, ...message, attachXml: true },
      staged(invoiceRow()),
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Attachment",
      value: "the e-invoice XML instead of the PDF",
    });
    expect(plan.preview.warnings.at(-1)).toContain("sevDesk can only attach XML to e-invoices");
  });

  it("refuses an XML attachment for an invoice sevDesk marks as no e-invoice", async () => {
    const client = staged(invoiceRow({ propertyIsEInvoice: "0" }));
    const error = await prepareWrite(tool, { id: 1001, ...message, attachXml: true }, client).catch(
      (e: unknown) => e,
    );
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain("is not an e-invoice");
  });

  it("refuses a draft when only external (not commit) is enabled: sending would finalize it", async () => {
    const externalOnly = { allowedTiers: new Set<Tier>(["read", "external"]) };
    const client = staged(invoiceRow({ status: "100", invoiceNumber: null }));

    const error = await prepareWrite(tool, { id: 1001, ...message }, client, externalOnly).catch(
      (e: unknown) => e,
    );

    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(
      "Finalize it first with sevdesk_invoice_finalize (needs the commit tier)",
    );
    expect(client.writes()).toEqual([]);
  });

  it("still sends a finalized invoice when only external is enabled", async () => {
    const externalOnly = { allowedTiers: new Set<Tier>(["read", "external"]) };
    const client = staged(invoiceRow());

    await executeWrite(tool, { id: 1001, ...message }, client, externalOnly);

    expect(client.writes()).toEqual([
      expect.objectContaining({ path: "/Invoice/1001/sendViaEmail", tier: "external" }),
    ]);
  });

  it("refuses a line break in the subject (the write flow allows line feeds in arguments)", async () => {
    const client = staged(invoiceRow());
    const error = await prepareWrite(
      tool,
      { id: 1001, ...message, subject: "Ihre Rechnung\nBcc: x@example.com" },
      client,
    ).catch((e: unknown) => e);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(
      "(U+000A); the subject must be a single line",
    );
    expect(client.writes()).toEqual([]);
  });

  it("refuses a recurring invoice template and duplicate recipients before sending", async () => {
    await expect(
      prepareWrite(tool, { id: 1001, ...message }, staged(invoiceRow({ invoiceType: "WKR" }))),
    ).rejects.toMatchObject({ kind: "validation" });
    await expect(
      prepareWrite(tool, { id: 1001, ...message, cc: ["Kunde@Example.com"] }, staged(invoiceRow())),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("checks addresses, subject and text in the input schema", () => {
    const parse = (args: Record<string, unknown>) =>
      tool.input.safeParse({ id: 1001, ...message, ...args }).success;
    expect(parse({})).toBe(true);
    expect(parse({ to: "not-an-address" })).toBe(false);
    expect(parse({ to: "a@example.com, b@example.com" })).toBe(false);
    expect(parse({ cc: Array.from({ length: 11 }, (_, i) => `u${String(i)}@example.com`) })).toBe(
      false,
    );
    expect(parse({ subject: "" })).toBe(false);
    expect(parse({ subject: "x".repeat(201) })).toBe(false);
    expect(parse({ text: "   " })).toBe(false);
    expect(parse({ text: "x".repeat(10_001) })).toBe(false);
    expect(parse({ additionalAttachments: "1,2" })).toBe(false);
  });
});

describe("sevdesk_credit_note_send_email and sevdesk_order_send_email", () => {
  it("send a credit note without the XML option", async () => {
    const creditNoteTool = sendEmailTool("creditNote");
    expect(creditNoteTool.input.safeParse({ id: 2001, ...message, attachXml: true }).success).toBe(
      false,
    );
    const client = new StagedClient(
      [documentRoute("creditNote", creditNoteRow({ status: "100" }))],
      [
        writeRoute("POST", "/CreditNote/2001/sendViaEmail", "credit-note-send-via-email.json"),
        documentRoute("creditNote", creditNoteRow()),
      ],
    );

    const { plan, output } = await executeWrite(creditNoteTool, { id: 2001, ...message }, client);

    expect(client.writes()[0]).toMatchObject({
      path: "/CreditNote/2001/sendViaEmail",
      tier: "external",
    });
    expect(plan.preview.warnings[1]).toContain("The credit note is a draft: sending finalizes it");
    expect(output.data["creditNote"]).toMatchObject({ id: 2001, status: { code: 200 } });
    expect(output.affected).toEqual([{ objectName: "CreditNote", id: "2001" }]);
  });

  it("refuses to send (and so finalize) a credit note draft without a number", async () => {
    const client = new StagedClient(
      [documentRoute("creditNote", creditNoteRow({ status: "100", creditNoteNumber: null }))],
      [],
    );
    const error = await prepareWrite(sendEmailTool("creditNote"), { id: 2001, ...message }, client)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      kind: "validation",
      message: expect.stringMatching(
        /^Credit note 2001 is a draft without a number, and sending \(and so finalizing\) it could fail half-way/,
      ) as unknown,
    });
    expect(client.writes()).toEqual([]);
  });

  it("send an order and say a draft order is marked as sent", async () => {
    const orderTool = sendEmailTool("order");
    const client = new StagedClient(
      [documentRoute("order", orderRow({ status: "100", orderNumber: null }))],
      [
        writeRoute("POST", "/Order/3002/sendViaEmail", "order-send-via-email.json"),
        documentRoute("order", orderRow({ status: "200" })),
      ],
    );

    const { plan, output } = await executeWrite(orderTool, { id: 3002, ...message }, client);

    expect(plan.preview.warnings[1]).toBe(
      "The order is a draft: sending marks it as sent (status 200) and sevDesk assigns its " +
        "final number.",
    );
    expect(plan.preview.facts).toContainEqual({ label: "Attachment", value: "the order PDF" });
    expect(output.data["order"]).toMatchObject({ id: 3002, status: { code: 200 } });
  });

  it("do not write when the document does not exist", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Order/9", query: { embed: "contact" }, response: { body: { objects: [] } } },
    ]);
    await expect(
      prepareWrite(sendEmailTool("order"), { id: 9, ...message }, client),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(client.writes()).toEqual([]);
  });
});
