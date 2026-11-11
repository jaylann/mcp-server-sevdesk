/**
 * Write tools that check something and then write must not interleave with another call on the
 * same thing: both calls read the state before either wrote, both pass, and the check is void
 * (review 2026-11, round 3). Three cases that happened:
 *
 * - Two `sevdesk_credit_note_create_from_invoice` calls, also for different invoices, got the
 *   same credit note number: `createFromInvoice` hands out the counter's current number without
 *   advancing it (see b4-numbering.test.ts), and each call moved the counter on only afterwards.
 * - Two `sevdesk_invoice_create_from_order` calls for one order both passed "no invoice draft
 *   from this order yet" and created two drafts.
 * - A price change and a tax change of one part each sent net, gross and rate computed from the
 *   part as read before the other; the later one put the other's old value back.
 *
 * Guard: the tools declare `locks` (the source record, the part, the account's number range), so
 * the write flow runs such calls of one account one after the other, from `prepare` to the end of
 * `execute` (as in concurrent-payments.test.ts). The fakes below keep state like sevDesk, and
 * every request takes a tick, so calls without the locks do interleave.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import type { SevdeskRequest } from "../../src/sevdesk/types.js";
import { contactCreateTool } from "../../src/tools/contacts/create.js";
import { contactUpdateTool } from "../../src/tools/contacts/update.js";
import { creditNoteCreateDraftTool } from "../../src/tools/credit-notes/draft-create.js";
import { creditNoteFromInvoiceTool } from "../../src/tools/credit-notes/from-invoice.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { invoiceFromOrderTool } from "../../src/tools/invoices/from-order.js";
import { invoiceReminderTool } from "../../src/tools/invoices/reminder.js";
import { orderUpdateDraftTool } from "../../src/tools/orders/draft-update.js";
import { partCreateTool } from "../../src/tools/parts/create.js";
import { partUpdateTool } from "../../src/tools/parts/update.js";
import {
  ACCOUNT_CONTACT_NUMBERS,
  ACCOUNT_CREDIT_NOTE_NUMBERS,
  ACCOUNT_PART_NUMBERS,
  ACCOUNT_VOUCHER_DRAFTS,
  type AnyWriteToolDefinition,
} from "../../src/tools/types.js";
import { type FakeRoute, type FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
} from "../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

type Row = Record<string, unknown>;

const EMPTY: FakeRoute["response"] = { body: { objects: [] } };
/** Returned by a handler for requests it leaves to the route table. */
const PASS = Symbol("pass");

/** Lets other pending calls run, as a real HTTP round trip would. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** The record of a GET-by-id fixture with fields replaced. */
function record(fixture: string, patch: Row = {}): Row {
  const body = loadFixture(fixture).body as { objects: Row[] };
  return { ...body.objects[0], ...patch };
}

/**
 * Answers the requests `handle` knows from state (anything but {@link PASS}) and the rest from
 * the fake's routes; every request first waits a tick.
 */
function stateful(fake: FakeSevdeskClient, handle: (request: SevdeskRequest) => unknown): void {
  const request = fake.request.bind(fake);
  vi.spyOn(fake, "request").mockImplementation(async (req: SevdeskRequest) => {
    await tick();
    const answer = handle(req);
    return answer === PASS ? request(req) : answer;
  });
}

/** The calls that went through and the ones that were refused. */
function results(all: readonly CallToolResult[]) {
  return {
    done: all.filter((result) => result.isError !== true),
    refused: all.filter((result) => result.isError === true),
  };
}

describe("concurrent credit notes from invoices", () => {
  const NEXT = "/CreditNote/Factory/getNextCreditNoteNumber";

  async function harness() {
    // sevDesk's credit note counter and the credit notes created so far.
    const state = { counter: 1000, nextId: 2101, creditNotes: [] as Row[], posts: 0 };
    const invoiceRoute = (id: number): FakeRoute => ({
      path: `/Invoice/${String(id)}`,
      query: { embed: "contact" },
      response: {
        body: {
          objects: [
            record("masterdata/invoice-1004.json", {
              id: String(id),
              invoiceNumber: `RE-${String(id)}`,
            }),
          ],
        },
      },
    });
    const h = await writeHarness({
      tools: [creditNoteFromInvoiceTool],
      routes: [
        invoiceRoute(1004),
        invoiceRoute(1005),
        { path: "/Invoice", response: EMPTY },
        { path: "/CreditNotePos", response: EMPTY },
        { path: "/Unity", response: { fixture: "meta/units.json" } },
      ],
    });
    stateful(h.fake, (req) => {
      if (req.method === "POST" && req.path === "/CreditNote/Factory/createFromInvoice") {
        const invoice = (req.body as { invoice: { id: number } }).invoice;
        const id = String(state.nextId++);
        const origin = { id: String(invoice.id), objectName: "Invoice" };
        state.posts += 1;
        // As recorded: the draft gets the counter's current number; the counter stays.
        state.creditNotes.push(
          record("masterdata/credit-note-2101.json", {
            id,
            creditNoteNumber: `GU-${String(state.counter)}`,
            origin,
            refSrcInvoice: origin,
          }),
        );
        return { creditNote: { id } };
      }
      if (req.method === "GET" && req.path === NEXT) {
        const current = `GU-${String(state.counter)}`;
        if (req.query?.["useNextNumber"] === "true") state.counter += 1;
        return current;
      }
      const byId = /^\/CreditNote\/(\d+)$/.exec(req.path);
      if (req.method === "GET" && byId !== null) {
        return state.creditNotes.filter((row) => row["id"] === byId[1]);
      }
      return PASS;
    });
    vi.spyOn(h.fake, "list").mockImplementation(async (path, _query, options) => {
      await tick();
      const rows = path === "/CreditNote" ? state.creditNotes : [];
      const offset = options?.offset ?? 0;
      return {
        items: rows.slice(offset, offset + (options?.limit ?? 100)),
        total: rows.length,
      };
    });
    return { ...h, state };
  }

  const create = (invoiceId: number) => ({
    name: "sevdesk_credit_note_create_from_invoice",
    arguments: { invoiceId },
  });

  function numberOf(result: CallToolResult): unknown {
    const data = resultData(result) as { result?: { creditNote?: { number?: string } } };
    return data.result?.creditNote?.number;
  }

  it("gives two drafts for different invoices different numbers", async () => {
    const { client, state } = await harness();

    const all = await Promise.all([client.callTool(create(1004)), client.callTool(create(1005))]);

    expect(all.map((result) => result.isError === true)).toEqual([false, false]);
    expect(all.map(numberOf).sort()).toEqual(["GU-1000", "GU-1001"]);
    expect(state.posts).toBe(2);
    // Each call moved the counter past its own number before the next one created anything.
    expect(state.counter).toBe(1002);
  });

  it("refuses the second of two calls for the same invoice", async () => {
    const { client, state } = await harness();

    const all = await Promise.all([client.callTool(create(1004)), client.callTool(create(1004))]);

    const { done, refused } = results(all);
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(resultText(refused[0]!)).toContain(
      "A credit note for Invoice 1004 exists already: credit note 2101.",
    );
    expect(state.posts).toBe(1);
  });
});

describe("concurrent invoices from one order", () => {
  it("creates one draft and refuses the second call", async () => {
    const fixture = loadFixture("orders/order-related-3002.json").body as {
      objects: Record<string, Row>;
    };
    // What sevDesk lists as the order's related documents; the new invoice draft joins it.
    const related: Row[] = Object.values(fixture.objects);
    let posts = 0;
    const { client, fake } = await writeHarness({
      tools: [invoiceFromOrderTool],
      routes: [
        {
          path: "/Order/3002",
          query: { embed: "contact" },
          response: { fixture: "orders/order-3002.json" },
        },
        {
          path: "/OrderPos",
          query: { "order[id]": 3002, "order[objectName]": "Order" },
          response: { fixture: "orders/order-positions-3002.json" },
        },
        { path: "/Unity", response: { fixture: "meta/units.json" } },
        {
          path: "/Invoice/1101",
          query: { embed: "contact" },
          response: { fixture: "masterdata/invoice-1101.json" },
        },
        {
          path: "/InvoicePos",
          query: { "invoice[id]": 1101, "invoice[objectName]": "Invoice" },
          response: { fixture: "masterdata/invoice-positions-1101.json" },
        },
      ],
    });
    stateful(fake, (req) => {
      if (req.method === "GET" && req.path === "/Order/3002/getRelatedObjects") {
        return [...related];
      }
      if (req.method === "POST" && req.path === "/Invoice/Factory/createInvoiceFromOrder") {
        posts += 1;
        related.push({ id: "1101", objectName: "Invoice", invoiceType: "RE", status: "100" });
        // The client hands tools the envelope's `objects`.
        const answer = loadFixture("masterdata/invoice-from-order-1101.json").body;
        return (answer as { objects: unknown }).objects;
      }
      return PASS;
    });
    const call = {
      name: "sevdesk_invoice_create_from_order",
      arguments: { orderId: 3002 },
    };

    const all = await Promise.all([client.callTool(call), client.callTool(call)]);

    const { done, refused } = results(all);
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(resultText(refused[0]!)).toContain(
      "An invoice draft from Order 3002 exists already: invoice 1101.",
    );
    expect(posts).toBe(1);
  });
});

describe("concurrent price and tax edits of one part", () => {
  it("keeps both changes", async () => {
    // Part 6001: net 42.01 / gross 49.99 at 19 %. A PUT changes what the next read returns.
    const part = record("parts/part-6001.json");
    const puts: unknown[] = [];
    const { client, fake } = await writeHarness({ tools: [partUpdateTool], routes: [] });
    stateful(fake, (req) => {
      if (req.path !== "/Part/6001") return PASS;
      if (req.method === "PUT") {
        puts.push(req.body);
        for (const [key, value] of Object.entries(req.body as Row)) part[key] = String(value);
        return { id: "6001", objectName: "Part" };
      }
      return [{ ...part }];
    });
    const update = (change: Row) => ({
      name: "sevdesk_part_update",
      arguments: { id: 6001, ...change },
    });

    const all = await Promise.all([
      client.callTool(update({ price: "50" })),
      client.callTool(update({ taxRate: "7" })),
    ]);

    expect(all.map((result) => resultData(result)["status"])).toEqual(["done", "done"]);
    expect(puts).toHaveLength(2);
    // The new net price and the new rate both hold; the gross price follows from the two.
    expect({
      priceNet: Number(part["priceNet"]),
      taxRate: Number(part["taxRate"]),
      priceGross: Number(part["priceGross"]),
    }).toEqual({ priceNet: 50, taxRate: 7, priceGross: 53.5 });
  });
});

describe("check-then-write tools declare the records they check", () => {
  const cases: readonly [AnyWriteToolDefinition, Row, readonly unknown[]][] = [
    [
      creditNoteFromInvoiceTool,
      { invoiceId: 1004 },
      [ACCOUNT_CREDIT_NOTE_NUMBERS, { objectName: "Invoice", id: "1004" }],
    ],
    [
      creditNoteCreateDraftTool,
      { bookingCategory: "underachievement", sourceInvoiceId: 1004 },
      [ACCOUNT_CREDIT_NOTE_NUMBERS, { objectName: "Invoice", id: "1004" }],
    ],
    [creditNoteCreateDraftTool, { bookingCategory: "provision" }, [ACCOUNT_CREDIT_NOTE_NUMBERS]],
    [invoiceFromOrderTool, { orderId: 3002 }, [{ objectName: "Order", id: "3002" }]],
    [invoiceReminderTool, { invoiceId: 1001 }, [{ objectName: "Invoice", id: "1001" }]],
    [contactCreateTool, { organisationName: "Muster GmbH" }, [ACCOUNT_CONTACT_NUMBERS]],
    [
      contactUpdateTool,
      { id: 1101, email: "a@example.com" },
      [{ objectName: "Contact", id: "1101" }],
    ],
    [
      contactUpdateTool,
      { id: 1101, customerNumber: "K-7" },
      [{ objectName: "Contact", id: "1101" }, ACCOUNT_CONTACT_NUMBERS],
    ],
    [partCreateTool, { name: "Testartikel", partNumber: "ART-9" }, [ACCOUNT_PART_NUMBERS]],
    [partUpdateTool, { id: 6001, price: "50" }, [{ objectName: "Part", id: "6001" }]],
    [
      partUpdateTool,
      { id: 6001, partNumber: "ART-9" },
      [{ objectName: "Part", id: "6001" }, ACCOUNT_PART_NUMBERS],
    ],
  ];

  it.each(cases)("%#", (tool, args, expected) => {
    expect(tool.locks?.(args as never), tool.name).toEqual(expected);
  });

  it("runs the two tools that create voucher drafts one at a time per account", () => {
    // Both refuse a voucher that exists already (same supplier, number, date, gross) and then
    // create the draft; two identical calls at once both passed that refusal.
    for (const name of ["sevdesk_voucher_create_draft", "sevdesk_voucher_import_einvoice"]) {
      const tool = ALL_TOOLS.find((candidate) => candidate.name === name) as
        AnyWriteToolDefinition | undefined;
      expect(tool?.locks?.({}), name).toEqual([ACCOUNT_VOUCHER_DRAFTS]);
    }
  });

  it("uses the key of the draft-update tools for a source document", () => {
    // The same spelling as the tools that change that record, or the calls would not wait for
    // each other.
    expect(invoiceFromOrderTool.locks?.({ orderId: 7 } as never)).toEqual(
      orderUpdateDraftTool.locks?.({ id: 7 }),
    );
    expect(invoiceReminderTool.locks?.({ invoiceId: 7 } as never)).toEqual(
      invoiceUpdateDraftTool.locks?.({ id: 7 }),
    );
    expect(creditNoteFromInvoiceTool.locks?.({ invoiceId: 7 } as never)).toContainEqual(
      invoiceUpdateDraftTool.locks?.({ id: 7 })[0],
    );
  });
});
