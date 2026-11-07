/**
 * Live lifecycle scenario (`pnpm test:live` with SEVDESK_LIVE_LIFECYCLE=1 and
 * SEVDESK_LIVE_I_UNDERSTAND_WRITES=1): drives the write tools end to end against a TRIAL account.
 *
 * It writes real data, and finalized documents cannot be deleted. Safeguards: both flags are
 * required; a warning is printed; the run refuses accounts that already hold more invoices and
 * contacts than a fresh trial (SEVDESK_LIVE_MAX_EXISTING_RECORDS); only the write and commit
 * tiers are enabled; everything is named after the run tag; the cleanup list is printed at the
 * end, also after a failure. The external tier is enabled only when SEVDESK_LIVE_EMAIL_TO names
 * an address of the operator, and then one invoice is e-mailed to exactly that address (never to
 * a contact).
 *
 * Scenario: tagged contact → draft invoice → PDF preview, invoice still a draft (B1 against the
 * real API) → finalize → partial payment → rest of the payment → second invoice + reminder
 * (Mahnung) → third invoice + cancellation (Storno) → credit note from the paid invoice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  berlinToday,
  foreignRecordCounts,
  lifecycleEmail,
  lifecycleGate,
  maxExistingRecords,
  readOnlyEnv,
  runTag,
  trialCheck,
  WRITE_WARNING,
  writeEnv,
} from "../../scripts/lib/live-env.js";
import { format, subtract } from "../../src/domain/money.js";
import {
  callOk,
  connectLive,
  expectValidOutput,
  findId,
  itemsOf,
  type LiveStack,
  statusCode,
} from "./live-stack.js";

const gate = lifecycleGate(process.env);
/** Optional: the operator's own address; only then is one invoice e-mailed (external tier). */
const EMAIL_TO = gate.open ? lifecycleEmail(process.env) : undefined;
const TODAY = berlinToday();
const MONTH_AGO = berlinToday(new Date(Date.now() - 30 * 86_400_000));

const WRITE_TOOLS = [
  "sevdesk_contact_create",
  "sevdesk_invoice_create_draft",
  "sevdesk_invoice_finalize",
  "sevdesk_invoice_book_payment",
  "sevdesk_invoice_create_reminder",
  "sevdesk_invoice_cancel",
  "sevdesk_credit_note_create_from_invoice",
] as const;

/**
 * Arguments of the write tools, in one place. Aligned with the tool inputs of 2026-11-07
 * (m3-lifecycle notes and the shipped schemas); `findId` in live-stack.ts reads the outputs.
 */
const ARGS = {
  // The draft tools need a billing address on the contact.
  contact: (tag: string) => ({
    organisationName: tag,
    category: "customer",
    street: "Musterstraße 1",
    zip: "10115",
    city: "Berlin",
    country: "DE",
  }),
  draftInvoice: (contactId: number, tag: string, date: string, timeToPay = 14) => ({
    contactId,
    date,
    timeToPay,
    header: `${tag} Rechnung`,
    positions: [{ name: `${tag} Beratung`, quantity: 1, unitPrice: "100.00", taxRate: 19 }],
  }),
  finalize: (id: number) => ({ id, sentVia: "pdf_download" }),
  bookPayment: (id: number, amount: string, checkAccountId: number) => ({
    id,
    amount,
    date: TODAY,
    checkAccountId,
    paymentType: "payment",
  }),
  reminder: (invoiceId: number) => ({ invoiceId }),
  cancel: (id: number) => ({ id }),
  creditNoteFromInvoice: (invoiceId: number) => ({ invoiceId }),
  draftOffer: (contactId: number, tag: string) => ({
    contactId,
    orderType: "offer",
    header: `${tag} Angebot`,
    positions: [{ name: `${tag} Beratung`, quantity: 1, unitPrice: "100.00", taxRate: 19 }],
  }),
  draftProvisionCreditNote: (contactId: number, tag: string) => ({
    contactId,
    bookingCategory: "provision",
    header: `${tag} Gutschrift`,
    positions: [{ name: `${tag} Provision`, quantity: 1, unitPrice: "50.00", taxRate: 19 }],
  }),
  sendEmail: (id: number, to: string, tag: string) => ({
    id,
    to,
    subject: `${tag} Rechnung (Test)`,
    text: "Test e-mail of the sevDesk MCP live tests (trial account). Please ignore.",
  }),
};

interface Created {
  readonly objectName: string;
  readonly id: number;
  state: string;
}

describe.skipIf(!gate.open)("live: lifecycle on a TRIAL account (writes!)", () => {
  const tag = runTag();
  const created: Created[] = [];
  const state: {
    contact?: number;
    invoiceA?: number;
    invoiceB?: number;
    invoiceC?: number;
    checkAccount?: number;
  } = {};
  let stack: LiveStack;

  function need(key: keyof typeof state): number {
    const value = state[key];
    if (value === undefined) throw new Error(`An earlier step did not produce ${key}.`);
    return value;
  }

  function remember(objectName: string, id: number | undefined, what: string): number {
    expect(id, `no ${objectName} id in the tool output`).toBeTypeOf("number");
    created.push({ objectName, id: id ?? 0, state: what });
    return id ?? 0;
  }

  function mark(id: number, what: string): void {
    const record = created.find((item) => item.id === id);
    if (record !== undefined) record.state = what;
  }

  /** Calls a write tool; it must have run (`status: "done"`, no approval, no dry run). */
  async function write(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const data = (await callOk(stack.mcp, name, args)) as { status?: unknown; result?: unknown };
    expect(data.status, `${name} did not run`).toBe("done");
    expectValidOutput(name, data.result);
    return data.result;
  }

  /** sevDesk's next document number, peeked without reserving it (`useNextNumber=false`). */
  async function peekNumber(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<string> {
    const value = await stack.sevdesk.request({
      method: "GET",
      path,
      query: { ...query, useNextNumber: "false" },
    });
    expect(value, `${path} did not answer a number`).toBeTypeOf("string");
    return value as string;
  }

  async function invoice(id: number): Promise<Record<string, unknown>> {
    const data = (await callOk(stack.mcp, "sevdesk_invoice_get", { id })) as {
      invoice: Record<string, unknown>;
    };
    return data.invoice;
  }

  async function draftAndFinalize(date: string, timeToPay?: number): Promise<number> {
    const draft = await write(
      "sevdesk_invoice_create_draft",
      ARGS.draftInvoice(need("contact"), tag, date, timeToPay),
    );
    const id = remember("Invoice", findId(draft, "Invoice", ["invoice"]), "draft");
    await write("sevdesk_invoice_finalize", ARGS.finalize(id));
    mark(id, "finalized (cannot be deleted)");
    return id;
  }

  beforeAll(async () => {
    console.warn(`\n${WRITE_WARNING}\nRun tag: ${tag}\n`);
    const reader = await connectLive(readOnlyEnv(process.env));
    try {
      const refusal = trialCheck(
        await foreignRecordCounts(reader.sevdesk),
        maxExistingRecords(process.env),
      );
      if (refusal !== undefined) throw new Error(refusal);
    } finally {
      await reader.close();
    }
    stack = await connectLive(writeEnv(process.env, { external: EMAIL_TO !== undefined }));
    expect(stack.config.allowedTiers.has("external")).toBe(EMAIL_TO !== undefined);
  }, 120_000);

  afterAll(async () => {
    const lines = created.map(
      (item) => `  ${item.objectName.padEnd(11)} ${String(item.id).padEnd(10)} ${item.state}`,
    );
    console.warn(
      `\nCleanup list for ${tag} (finalized documents cannot be deleted; drafts and contacts can, ` +
        `in the web app; cancelling the trial removes everything):\n${lines.join("\n") || "  nothing was created"}\n`,
    );
    await stack.close();
  });

  it("offers every write tool the scenario needs", async () => {
    const listed = new Set((await stack.mcp.listTools()).tools.map((tool) => tool.name));
    const needed =
      EMAIL_TO === undefined ? WRITE_TOOLS : [...WRITE_TOOLS, "sevdesk_invoice_send_email"];
    expect(needed.filter((name) => !listed.has(name))).toEqual([]);
  });

  it("creates a tagged contact", async () => {
    const data = await write("sevdesk_contact_create", ARGS.contact(tag));
    state.contact = remember("Contact", findId(data, "Contact", ["contact"]), "active (deletable)");
  });

  it("creates a draft invoice", async () => {
    const data = await write(
      "sevdesk_invoice_create_draft",
      ARGS.draftInvoice(need("contact"), tag, TODAY),
    );
    state.invoiceA = remember("Invoice", findId(data, "Invoice", ["invoice"]), "draft (deletable)");
    expect(statusCode(await invoice(state.invoiceA))).toBe(100);
  });

  it("renders the PDF preview and the invoice stays a draft (B1 against the real API)", async () => {
    const id = need("invoiceA");
    await callOk(stack.mcp, "sevdesk_invoice_pdf", { id });
    const after = await invoice(id);
    expect(statusCode(after)).toBe(100);
    expect(after["sent"]).toBeUndefined();
  });

  it("finalizes the invoice and sevDesk assigns its number", async () => {
    const id = need("invoiceA");
    await write("sevdesk_invoice_finalize", ARGS.finalize(id));
    mark(id, "finalized (cannot be deleted)");
    const after = await invoice(id);
    expect(statusCode(after)).toBe(200);
    expect(after["number"]).toMatch(/^[^%]+$/);
  });

  it("books a partial payment, then the rest", async () => {
    const id = need("invoiceA");
    // A cash register or clearing account: online accounts need a bank transaction to link.
    const accounts = itemsOf(await callOk(stack.mcp, "sevdesk_bank_accounts_list", {}));
    const account = accounts.find(
      (item) => item["type"] === "cash" || item["type"] === "clearing",
    )?.["id"];
    expect(
      account,
      "no cash register (Kasse) or clearing account: create one in the web app",
    ).toBeTypeOf("number");
    state.checkAccount = account as number;

    await write(
      "sevdesk_invoice_book_payment",
      ARGS.bookPayment(id, "50.00", need("checkAccount")),
    );
    const partial = await invoice(id);
    expect(statusCode(partial)).toBe(750);

    const gross =
      (partial["totals"] as { gross?: { amount: string } } | undefined)?.gross?.amount ?? "0";
    const rest = format(subtract(gross, "50.00"), 2);
    await write("sevdesk_invoice_book_payment", ARGS.bookPayment(id, rest, need("checkAccount")));
    expect(statusCode(await invoice(id))).toBe(1000);
    mark(id, "finalized and paid (cannot be deleted)");
  });

  it("creates a reminder (Mahnung) for an overdue second invoice", async () => {
    state.invoiceB = await draftAndFinalize(MONTH_AGO, 7);
    const data = await write("sevdesk_invoice_create_reminder", ARGS.reminder(state.invoiceB));
    const reminder = remember(
      "Invoice",
      findId(data, "Invoice", ["reminder"]),
      "reminder (MA) draft",
    );
    const row = await invoice(reminder);
    expect((row["type"] as { code?: string } | undefined)?.code).toBe("MA");
  });

  it("cancels a third invoice (Storno); the original keeps status 1000 (D-037)", async () => {
    state.invoiceC = await draftAndFinalize(TODAY);
    const data = await write("sevdesk_invoice_cancel", ARGS.cancel(state.invoiceC));
    mark(state.invoiceC, "cancelled (cannot be deleted)");
    const cancellation = findId(data, "Invoice", ["cancellationInvoiceId", "cancellationInvoice"]);
    remember("Invoice", cancellation, "cancellation invoice SR (cannot be deleted)");
    expect(statusCode(await invoice(state.invoiceC))).toBe(1000);
    const sr = await invoice(cancellation ?? 0);
    expect((sr["type"] as { code?: string } | undefined)?.code).toBe("SR");
    expect(sr["cancelsInvoiceId"]).toBe(state.invoiceC);
  });

  it("creates a credit note (Gutschrift) from the paid invoice", async () => {
    const data = await write(
      "sevdesk_credit_note_create_from_invoice",
      ARGS.creditNoteFromInvoice(need("invoiceA")),
    );
    const id = remember(
      "CreditNote",
      findId(data, "CreditNote", ["creditNote"]),
      "draft (deletable)",
    );
    const note = (await callOk(stack.mcp, "sevdesk_credit_note_get", { id })) as {
      creditNote: Record<string, unknown>;
    };
    expect(statusCode(note.creditNote)).toBeTypeOf("number");
    // createFromInvoice takes the counter's current number without advancing it (recorded
    // 2026-11-07); the tool moves the counter past it, so the next credit note cannot reuse it.
    const next = await peekNumber("/CreditNote/Factory/getNextCreditNoteNumber", {});
    expect(next, "the credit-note counter still offers the new note's number").not.toBe(
      note.creditNote["number"],
    );
  });

  it("creates an offer (Angebot) with a reserved number; the counter advances exactly once", async () => {
    const before = await peekNumber("/Order/Factory/getNextOrderNumber", { orderType: "AN" });
    const data = await write("sevdesk_order_create_draft", ARGS.draftOffer(need("contact"), tag));
    const id = remember("Order", findId(data, "Order", ["order"]), "draft (deletable)");
    const order = (await callOk(stack.mcp, "sevdesk_order_get", { id })) as {
      order: Record<string, unknown>;
    };
    expect(order.order["number"], "the offer carries the reserved number").toBe(before);
    const after = await peekNumber("/Order/Factory/getNextOrderNumber", { orderType: "AN" });
    expect(after, "the order counter did not advance").not.toBe(before);

    await write("sevdesk_order_finalize", ARGS.finalize(id));
    mark(id, "finalized (cannot be deleted)");
    const again = await peekNumber("/Order/Factory/getNextOrderNumber", { orderType: "AN" });
    expect(again, "finalizing must not move the counter again").toBe(after);
  });

  it("turns the finalized offer into an advance invoice (30 %), then the final invoice", async () => {
    const offer = created.find((item) => item.objectName === "Order")?.id;
    expect(offer, "the offer step did not run").toBeTypeOf("number");

    // Order matters: a full invoice marks the order fully invoiced (status 1000), after which the
    // tool refuses further invoices from it (verified live on 2026-11-08).
    for (const args of [
      { orderId: offer, mode: "advance", amount: 30, amountType: "percentage" },
      { orderId: offer, mode: "full", allowDuplicate: true },
    ]) {
      const data = await write("sevdesk_order_to_invoice", args);
      const id = remember("Invoice", findId(data, "Invoice", ["invoice"]), "draft (deletable)");
      const draft = await invoice(id);
      expect(statusCode(draft), `${args.mode}: not a draft`).toBe(100);
    }
  });

  it("creates a provision credit note with a reserved number and finalizes it", async () => {
    const data = await write(
      "sevdesk_credit_note_create_draft",
      ARGS.draftProvisionCreditNote(need("contact"), tag),
    );
    const id = remember(
      "CreditNote",
      findId(data, "CreditNote", ["creditNote"]),
      "draft (deletable)",
    );
    const draft = (await callOk(stack.mcp, "sevdesk_credit_note_get", { id })) as {
      creditNote: Record<string, unknown>;
    };
    expect(draft.creditNote["number"], "the draft carries a reserved number").toBeTruthy();

    await write("sevdesk_credit_note_finalize", ARGS.finalize(id));
    mark(id, "finalized (cannot be deleted)");
    const final = (await callOk(stack.mcp, "sevdesk_credit_note_get", { id })) as {
      creditNote: Record<string, unknown>;
    };
    expect(statusCode(final.creditNote)).toBe(200);
    expect(final.creditNote["number"]).toBe(draft.creditNote["number"]);
  });

  it.runIf(EMAIL_TO !== undefined)(
    "e-mails the paid invoice to SEVDESK_LIVE_EMAIL_TO only (the operator's own address)",
    async () => {
      const id = need("invoiceA");
      await write("sevdesk_invoice_send_email", ARGS.sendEmail(id, EMAIL_TO ?? "", tag));
      mark(id, "finalized, paid, e-mailed to SEVDESK_LIVE_EMAIL_TO (cannot be deleted)");
    },
  );
});

if (!gate.open) {
  it.skip(`live lifecycle skipped: ${gate.reason}`, () => undefined);
}
