/**
 * Document numbers of order and credit note drafts (recorded 2026-11-07, see
 * src/domain/drafts/numbering.ts): `prepare` peeks the next number for the preview, `execute`
 * reserves it with the write tier right before the save and saves with exactly that number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError, type SevdeskErrorKind } from "../../../../src/sevdesk/errors.js";
import type { SevdeskRequest } from "../../../../src/sevdesk/types.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { orderCreateDraftTool } from "../../../../src/tools/orders/draft-create.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  creditNoteNumbersRoute,
  nextCreditNoteNumberRoutes,
  nextOrderNumberRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const NEXT_ORDER = "/Order/Factory/getNextOrderNumber";
const NEXT_CREDIT = "/CreditNote/Factory/getNextCreditNoteNumber";

/**
 * The credit note routes with another number scan (the last route; prepending it would also
 * answer the duplicate check, which filters by contact).
 */
function withScan(...numbers: (string | null)[]): FakeRoute[] {
  return [...creditNoteCreateRoutes.slice(0, -1), creditNoteNumbersRoute(...numbers)];
}

/** The read-back of the new order 3101 with another stored number. */
function readBackOrder(orderNumber: string): FakeRoute {
  const stored = loadFixture("drafts/order-3101.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/Order/3101",
    query: { embed: "contact" },
    response: { body: { objects: [{ ...stored.objects[0], orderNumber }] } },
  };
}

/** The read-back of the new credit note 2201 with another stored number. */
function readBackCreditNote(creditNoteNumber: string | null): FakeRoute {
  const stored = loadFixture("drafts/credit-note-2201.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/CreditNote/2201",
    query: { embed: "contact" },
    response: { body: { objects: [{ ...stored.objects[0], creditNoteNumber }] } },
  };
}

/** A fake whose reservations (`useNextNumber=true`) answer `numbers` one after the other. */
class Reserving extends FakeSevdeskClient {
  private readonly numbers: string[];

  constructor(routes: readonly FakeRoute[], numbers: readonly string[]) {
    super(routes);
    this.numbers = [...numbers];
  }

  override async request(request: SevdeskRequest): Promise<unknown> {
    const answer = await super.request(request);
    return request.query?.["useNextNumber"] === "true" ? this.numbers.shift() : answer;
  }
}

function failingSave(path: string, kind: SevdeskErrorKind): FakeRoute {
  return {
    method: "POST",
    path,
    response: {
      error: new SevdeskError({ kind, message: "sevDesk refused the request.", status: 400 }),
    },
  };
}

async function executeError(run: () => Promise<unknown>): Promise<SevdeskError> {
  const error: unknown = await run().catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SevdeskError);
  return error as SevdeskError;
}

describe("sevdesk_order_create_draft numbering", () => {
  const tool = orderCreateDraftTool;

  it("previews the peeked number and only peeks while preparing", async () => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    const plan = await prepareWrite(
      tool,
      { ...orderCreateArgs, type: "order_confirmation" },
      client,
    );
    expect(client.writes()).toEqual([]);
    expect(client.callsTo(NEXT_ORDER).map((call) => call.query)).toEqual([
      { orderType: "AB", useNextNumber: "false" },
    ]);
    expect(plan.preview.facts[1]).toEqual({
      label: "Number",
      value: "AN-1000 (reserved when the draft is saved)",
    });
    expect(plan.preview.warnings).toContain(
      "Saving reserves the number AN-1000 from sevDesk's order confirmation number range " +
        "(Nummernkreis). If saving fails, that number is skipped (a gap in the range); if " +
        "another document takes it first, the draft gets the next number.",
    );
  });

  it("reserves exactly once, after the last prepare read, right before the save, with the write tier", async () => {
    // What prepare alone reads (it runs first inside executeWrite, on the same fake).
    const prepareOnly = new FakeSevdeskClient(orderCreateRoutes);
    await prepareWrite(tool, orderCreateArgs, prepareOnly);
    const prepared = prepareOnly.calls.length;

    const client = new FakeSevdeskClient(orderCreateRoutes);
    await executeWrite(tool, orderCreateArgs, client);
    expect(client.calls.slice(0, prepared)).toEqual(prepareOnly.calls);
    expect(client.calls.filter((call) => call.query["useNextNumber"] === "true")).toHaveLength(1);
    expect(client.calls[prepared]).toMatchObject({
      method: "GET",
      path: NEXT_ORDER,
      query: { orderType: "AN", useNextNumber: "true" },
      sideEffect: true,
      tier: "write",
    });
    expect(client.calls[prepared + 1]).toMatchObject({
      method: "POST",
      path: "/Order/Factory/saveOrder",
      body: { order: { orderNumber: "AN-1000" } },
    });
  });

  it("uses a different reserved number without asking again, and says so", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        orderCreateRoutes,
        ...nextOrderNumberRoutes("AN-1000", "AN-1001"),
        readBackOrder("AN-1001"),
      ),
    );
    const { plan, output } = await executeWrite(tool, orderCreateArgs, client);
    expect(plan.state.body.order.orderNumber).toBe("AN-1000");
    expect(client.writes()[1]?.body).toMatchObject({ order: { orderNumber: "AN-1001" } });
    expect(output.data.notes).toEqual([
      "sevDesk reserved AN-1001 instead of the previewed AN-1000 (another document took AN-1000 " +
        "in the meantime); the draft was saved with AN-1001.",
    ]);
    expect(output.summary).toMatch(/See notes\.$/);
  });

  it("notes when the read-back shows another number than the draft was saved with", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderCreateRoutes, readBackOrder("AN-1007")));
    const { output } = await executeWrite(tool, orderCreateArgs, client);
    expect(output.data.notes).toEqual([
      "sevDesk stored the order number AN-1007 although the draft was saved with AN-1000; check " +
        "the number range (Nummernkreis) and the draft before finalizing.",
    ]);
  });

  it("names the reserved, now skipped number when the save fails", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(orderCreateRoutes, failingSave("/Order/Factory/saveOrder", "validation")),
    );
    const error = await executeError(() => executeWrite(tool, orderCreateArgs, client));
    expect(error.kind).toBe("validation");
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "sevDesk refused the request. The order number AN-1000 was reserved for this draft and is " +
        "now skipped in the number range (Nummernkreis); repeating the call reserves the next one.",
    );
    expect(error.completedWrites).toEqual([]);
    expect(client.writes().map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("says a timed-out save may have used the number", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(orderCreateRoutes, failingSave("/Order/Factory/saveOrder", "timeout")),
    );
    const error = await executeError(() => executeWrite(tool, orderCreateArgs, client));
    expect(error.message).toMatch(
      /The order number AN-1000 was reserved for this draft; unless sevDesk saved the draft anyway/,
    );
  });

  it("saves nothing when the reservation fails", async () => {
    const refused: FakeRoute = {
      path: NEXT_ORDER,
      query: { useNextNumber: "true" },
      response: { error: new SevdeskError({ kind: "validation", message: "No range." }) },
    };
    const client = new FakeSevdeskClient(withRoutes(orderCreateRoutes, refused));
    const error = await executeError(() => executeWrite(tool, orderCreateArgs, client));
    expect(error.message).toBe("No range.");
    expect(client.writes().map((call) => call.method)).toEqual(["GET"]);
  });

  it("rethrows a failure that is not a sevDesk error unchanged", async () => {
    const client = new FakeSevdeskClient(
      orderCreateRoutes.filter((route) => route.path !== "/Order/Factory/saveOrder"),
    );
    await expect(executeWrite(tool, orderCreateArgs, client)).rejects.toThrow(/no route/);
  });
});

describe("sevdesk_credit_note_create_draft numbering", () => {
  const tool = creditNoteCreateDraftTool;

  it("skips reserved numbers that existing credit notes carry and reports them", async () => {
    const client = new Reserving(withScan("GU-1001", "GU-1002"), ["GU-1002", "GU-1003"]);
    const { output } = await executeWrite(tool, creditNoteCreateArgs, client);
    expect(client.writes().map((call) => call.path)).toEqual([
      NEXT_CREDIT,
      NEXT_CREDIT,
      "/CreditNote/Factory/saveCreditNote",
    ]);
    expect(client.writes()[2]?.body).toMatchObject({ creditNote: { creditNoteNumber: "GU-1003" } });
    expect(output.data.notes?.[0]).toBe(
      "Skipped credit note number GU-1002: existing credit notes carry it already (sevDesk's " +
        "counter lagged behind, e.g. after sevdesk_credit_note_create_from_invoice). The draft " +
        "was saved with GU-1003.",
    );
    // The read-back fixture still shows GU-1002, which the next note points out.
    expect(output.data.notes?.[1]).toBe(
      "sevDesk stored the credit note number GU-1002 although the draft was saved with GU-1003; " +
        "check the number range (Nummernkreis) and the draft before finalizing.",
    );
  });

  it("names several skipped numbers", async () => {
    const client = new Reserving(withScan("GU-1002", "GU-1003"), ["GU-1002", "GU-1003", "GU-1004"]);
    const { output } = await executeWrite(tool, creditNoteCreateArgs, client);
    expect(output.data.notes?.[0]).toMatch(
      /^Skipped credit note numbers GU-1002, GU-1003: existing credit notes carry them already/,
    );
  });

  it("notes a number that differs from the preview", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(creditNoteCreateRoutes, ...nextCreditNoteNumberRoutes("GU-1002", "GU-1005")),
    );
    const { output } = await executeWrite(tool, creditNoteCreateArgs, client);
    expect(output.data.notes?.[0]).toBe(
      "sevDesk reserved GU-1005 instead of the previewed GU-1002 (another document took GU-1002 " +
        "in the meantime); the draft was saved with GU-1005.",
    );
  });

  it("warns instead of failing when not every credit note could be checked", async () => {
    const page: FakeRoute = {
      path: "/CreditNote",
      response: { body: { objects: [{ id: "1", creditNoteNumber: "GU-1" }], total: "99999" } },
    };
    // Replaces the scan route (the last one), so the duplicate check keeps its own route.
    const client = new FakeSevdeskClient([...creditNoteCreateRoutes.slice(0, -1), page]);
    const { output } = await executeWrite(tool, creditNoteCreateArgs, client);
    expect(output.data.notes).toContain(
      "Only the first 5000 credit notes were checked for GU-1002; make sure in sevDesk that no " +
        "other credit note carries it before finalizing.",
    );
  });

  it("names the reserved, now skipped number when the save fails", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        creditNoteCreateRoutes,
        failingSave("/CreditNote/Factory/saveCreditNote", "validation"),
      ),
    );
    const error = await executeError(() => executeWrite(tool, creditNoteCreateArgs, client));
    expect(error.message).toBe(
      "sevDesk refused the request. The credit note number GU-1002 was reserved for this draft " +
        "and is now skipped in the number range (Nummernkreis); repeating the call reserves the " +
        "next one.",
    );
  });

  it("points a credit note read back without a number to recreating it, not to finalize", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(creditNoteCreateRoutes, readBackCreditNote(null)),
    );
    const { output } = await executeWrite(tool, creditNoteCreateArgs, client);
    expect(output.data.notes).toEqual([
      "The credit note has no number, and sevdesk_credit_note_finalize refuses credit notes " +
        "without one (sevDesk can fail half-way on them). Create it again with " +
        "sevdesk_credit_note_create_draft, which reserves a number, or set a number in the " +
        "sevDesk web app.",
    ]);
  });

  it("rethrows a save failure that is not a sevDesk error unchanged", async () => {
    const client = new FakeSevdeskClient(
      creditNoteCreateRoutes.filter((route) => route.path !== "/CreditNote/Factory/saveCreditNote"),
    );
    await expect(executeWrite(tool, creditNoteCreateArgs, client)).rejects.toThrow(/no route/);
  });
});
