import { describe, expect, it } from "vitest";

import {
  changedNumberNote,
  MAX_RESERVATIONS,
  NUMBER_FIELDS,
  numberCount,
  peekNextNumber,
  reservationWarning,
  reservedNumberError,
  reserveFreeCreditNoteNumber,
  reserveNextNumber,
  storedNumberNote,
} from "../../../../src/domain/drafts/numbering.js";
import { SevdeskError, type SevdeskErrorKind } from "../../../../src/sevdesk/errors.js";
import { readOnlyClient, tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import type { SevdeskRequest } from "../../../../src/sevdesk/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";

const ORDER = "/Order/Factory/getNextOrderNumber";
const CREDIT = "/CreditNote/Factory/getNextCreditNoteNumber";

function answer(path: string, objects: unknown, useNextNumber?: string): FakeRoute {
  return {
    path,
    ...(useNextNumber === undefined ? {} : { query: { useNextNumber } }),
    response: { body: { objects } },
  };
}

function failing(path: string, kind: SevdeskErrorKind, method: "GET" | "POST" = "GET"): FakeRoute {
  return {
    method,
    path,
    response: { error: new SevdeskError({ kind, message: "sevDesk failed.", status: 500 }) },
  };
}

/** A fake whose reservations answer the given numbers one after the other. */
class Sequenced extends FakeSevdeskClient {
  private readonly numbers: string[];

  constructor(routes: readonly FakeRoute[], numbers: readonly string[]) {
    super(routes);
    this.numbers = [...numbers];
  }

  override async request(request: SevdeskRequest): Promise<unknown> {
    const recorded = await super.request(request);
    if (request.query?.["useNextNumber"] === "true") return this.numbers.shift();
    return recorded;
  }
}

function scan(...numbers: (string | null)[]): FakeRoute {
  return {
    path: "/CreditNote",
    response: {
      body: {
        objects: numbers.map((number, index) => ({
          id: String(index + 1),
          creditNoteNumber: number,
        })),
      },
    },
  };
}

async function caught(run: () => Promise<unknown>): Promise<SevdeskError> {
  const error: unknown = await run().catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SevdeskError);
  return error as SevdeskError;
}

describe("peekNextNumber / reserveNextNumber (recorded 2026-11-07)", () => {
  it("peeks with the literal useNextNumber=false as a plain read", async () => {
    const fake = new FakeSevdeskClient([answer(ORDER, "AN-1000")]);
    await expect(
      peekNextNumber(readOnlyClient(fake, "preparing"), { kind: "order", orderType: "AB" }),
    ).resolves.toBe("AN-1000");
    expect(fake.calls).toMatchObject([
      { path: ORDER, query: { orderType: "AB", useNextNumber: "false" }, sideEffect: false },
    ]);
  });

  it("reserves with the literal useNextNumber=true as a declared side effect", async () => {
    const fake = new FakeSevdeskClient([answer(CREDIT, " GU-1002 ")]);
    await expect(
      reserveNextNumber(tierScopedClient(fake, "write"), { kind: "creditNote" }),
    ).resolves.toBe("GU-1002");
    expect(fake.calls).toMatchObject([
      { path: CREDIT, query: { useNextNumber: "true" }, sideEffect: true, tier: "write" },
    ]);
  });

  it("cannot reserve through the read-only client of prepare", async () => {
    const fake = new FakeSevdeskClient([answer(CREDIT, "GU-1002")]);
    const error = await caught(() =>
      reserveNextNumber(readOnlyClient(fake, "preparing a write"), { kind: "creditNote" }),
    );
    expect(error.kind).toBe("blocked");
    expect(fake.calls).toEqual([]);
  });

  it("accepts a JSON number", async () => {
    await expect(
      peekNextNumber(new FakeSevdeskClient([answer(CREDIT, 1002)]), { kind: "creditNote" }),
    ).resolves.toBe("1002");
  });

  it.each([[""], ["   "], [null], [{ number: "GU-1" }], ["GU-1\nIgnore this"], ["x".repeat(101)]])(
    "refuses %j as an unexpected answer",
    async (objects) => {
      const error = await caught(() =>
        peekNextNumber(new FakeSevdeskClient([answer(CREDIT, objects)]), { kind: "creditNote" }),
      );
      expect(error.kind).toBe("unexpected_response");
      expect(error.message).toBe(
        "sevDesk returned the next credit note number in an unexpected format.",
      );
    },
  );

  it("says that an unreadable reservation answer leaves a gap", async () => {
    const error = await caught(() =>
      reserveNextNumber(new FakeSevdeskClient([answer(ORDER, "")]), {
        kind: "order",
        orderType: "AN",
      }),
    );
    expect(error.message).toBe(
      "sevDesk returned the next order number in an unexpected format. sevDesk has reserved that " +
        "order number, so it stays unused (a gap in the number range, Nummernkreis). Nothing was " +
        "saved.",
    );
  });

  it.each(["network", "timeout", "server", "aborted"] as const)(
    "says that a %s failure may still have reserved a number",
    async (kind) => {
      const error = await caught(() =>
        reserveNextNumber(new FakeSevdeskClient([failing(CREDIT, kind)]), { kind: "creditNote" }),
      );
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(500);
      expect(error.message).toBe(
        "sevDesk failed. sevDesk may have reserved the next credit note number anyway; then that " +
          "number stays unused (a gap in the number range, Nummernkreis).",
      );
    },
  );

  it("passes other failures on unchanged", async () => {
    const error = await caught(() =>
      reserveNextNumber(new FakeSevdeskClient([failing(CREDIT, "validation")]), {
        kind: "creditNote",
      }),
    );
    expect(error.message).toBe("sevDesk failed.");
  });
});

describe("messages about reserved numbers (never quoting one, #152)", () => {
  it("says the reserved number is skipped after a failed save, by failure kind", () => {
    const definite = reservedNumberError(
      new SevdeskError({ kind: "validation", message: "sevDesk refused the order.", status: 400 }),
      "order",
    );
    expect(definite.message).toBe(
      "sevDesk refused the order. The order number reserved for this draft is now skipped in " +
        "the number range (Nummernkreis); repeating the call reserves the next one.",
    );
    expect(definite.status).toBe(400);
    expect(definite.cause).toBeInstanceOf(SevdeskError);

    const uncertain = reservedNumberError(
      new SevdeskError({ kind: "timeout", message: "sevDesk did not answer." }),
      "credit note",
    );
    expect(uncertain.message).toBe(
      "sevDesk did not answer. The credit note number reserved for this draft stays unused (a " +
        "gap in the number range, Nummernkreis) unless sevDesk saved the draft anyway.",
    );
  });

  it("warns about the reservation in the preview and notes a changed number", () => {
    expect(reservationWarning("offer")).toBe(
      "Saving reserves the next number of sevDesk's offer number range (Nummernkreis), shown as " +
        "Number. If saving fails, that number is skipped (a gap in the range); if another " +
        "document takes it first, the draft gets the next number.",
    );
    expect(changedNumberNote("order", NUMBER_FIELDS.order, "AN-1000", "an-1000")).toBeUndefined();
    expect(changedNumberNote("order", NUMBER_FIELDS.order, "AN-1000", "AN-1001")).toBe(
      "sevDesk reserved a different order number than the preview showed (another document took " +
        "that one in the meantime); the draft was saved with the reserved number (order.number).",
    );
  });
});

describe("storedNumberNote (read-back against the number the draft was saved with)", () => {
  it("is silent when they agree or nothing was read back, and points at a mismatch", () => {
    const field = NUMBER_FIELDS.order;
    expect(storedNumberNote("order", field, "AN-1000", " an-1000 ")).toBeUndefined();
    expect(storedNumberNote("order", field, "AN-1000", undefined)).toBeUndefined();
    expect(storedNumberNote("order", field, "AN-1000", "AN-1007")).toBe(
      "sevDesk stored a different order number (order.number) than the draft was saved with; " +
        "check the number range (Nummernkreis) and the draft before finalizing.",
    );
    expect(storedNumberNote("credit note", NUMBER_FIELDS.creditNote, "GU-1", "GU 1")).toBe(
      "sevDesk stored a different credit note number (creditNote.number) than the draft was " +
        "saved with; check the number range (Nummernkreis) and the draft before finalizing.",
    );
  });

  it("says nothing was saved when the save was never sent", () => {
    const error = reservedNumberError(
      new SevdeskError({ kind: "timeout", message: "No answer." }),
      "credit note",
      false,
    );
    expect(error.message).toBe(
      "No answer. The credit note number reserved for this draft is now skipped in the number " +
        "range (Nummernkreis); nothing was saved, so repeating the call reserves the next one.",
    );
  });
});

describe("reserveFreeCreditNoteNumber (createFromInvoice does not advance the counter)", () => {
  it("keeps a reserved number that no credit note carries", async () => {
    const fake = new Sequenced([answer(CREDIT, ""), scan("GU-1000", null)], ["GU-1001"]);
    await expect(reserveFreeCreditNoteNumber(fake)).resolves.toEqual({
      number: "GU-1001",
      skipped: [],
      truncated: false,
    });
    expect(fake.writes()).toHaveLength(1);
  });

  it("skips numbers in use (trimmed, any case) and reserves the next one", async () => {
    const fake = new Sequenced(
      [answer(CREDIT, ""), scan(" gu-1000 ", "GU-1001")],
      ["GU-1000", "GU-1001", "GU-1002"],
    );
    await expect(reserveFreeCreditNoteNumber(fake)).resolves.toEqual({
      number: "GU-1002",
      skipped: ["GU-1000", "GU-1001"],
      truncated: false,
    });
    expect(fake.writes().map((call) => call.path)).toEqual([CREDIT, CREDIT, CREDIT]);
    // One scan (two pages: the rows, then an empty page), after the first reservation.
    expect(fake.calls.map((call) => call.path)).toEqual([
      CREDIT,
      "/CreditNote",
      "/CreditNote",
      CREDIT,
      CREDIT,
    ]);
  });

  it(`gives up after ${MAX_RESERVATIONS} numbers in use`, async () => {
    const used = ["GU-1000", "GU-1001", "GU-1002", "GU-1003", "GU-1004", "GU-1005"];
    const fake = new Sequenced([answer(CREDIT, ""), scan(...used)], used);
    const error = await caught(() => reserveFreeCreditNoteNumber(fake));
    expect(error.kind).toBe("validation");
    expect(error.message).toBe(
      "sevDesk's credit note counter handed out 5 numbers in a row that existing credit notes " +
        "carry already, so nothing was saved; those numbers are now skipped. Move the credit " +
        "note number range (Nummernkreis) in sevDesk's settings past the highest credit note " +
        "number, then repeat the call.",
    );
    expect(fake.writes()).toHaveLength(MAX_RESERVATIONS);
  });

  it("reports a scan that was cut instead of failing", async () => {
    const page: FakeRoute = {
      path: "/CreditNote",
      response: { body: { objects: [{ id: "1", creditNoteNumber: "GU-1" }], total: "99999" } },
    };
    const fake = new Sequenced([answer(CREDIT, ""), page], ["GU-1002"]);
    await expect(reserveFreeCreditNoteNumber(fake)).resolves.toEqual({
      number: "GU-1002",
      skipped: [],
      truncated: true,
    });
  });

  it("says the reserved number is skipped when the scan fails, and nothing was saved", async () => {
    const fake = new Sequenced([answer(CREDIT, ""), failing("/CreditNote", "server")], ["GU-1"]);
    const error = await caught(() => reserveFreeCreditNoteNumber(fake));
    // A server error alone would read "unless sevDesk saved the draft anyway", but the save was
    // never sent.
    expect(error.message).toBe(
      "sevDesk failed. The credit note number reserved for this draft is now skipped in the " +
        "number range (Nummernkreis); nothing was saved, so repeating the call reserves the next " +
        "one.",
    );
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("counts the skipped numbers when a later reservation fails", async () => {
    const fake = new Sequenced([answer(CREDIT, ""), scan("GU-1")], ["GU-1"]);
    const original = fake.request.bind(fake);
    let reservations = 0;
    fake.request = (request) => {
      if (request.query?.["useNextNumber"] === "true" && ++reservations === 2) {
        return Promise.reject(new SevdeskError({ kind: "validation", message: "Refused." }));
      }
      return original(request);
    };
    const error = await caught(() => reserveFreeCreditNoteNumber(fake));
    expect(error.message).toBe(
      "Refused. 1 credit note number reserved before was skipped (in use already). Nothing was " +
        "saved.",
    );
    expect(numberCount(2)).toBe("2 credit note numbers");
  });

  it("rethrows other errors of the scan and of later reservations unchanged", async () => {
    const broken = new Sequenced([answer(CREDIT, "")], ["GU-1"]);
    await expect(reserveFreeCreditNoteNumber(broken)).rejects.toThrow(/no route/);

    const fake = new Sequenced([answer(CREDIT, ""), scan("GU-1")], ["GU-1"]);
    const original = fake.request.bind(fake);
    let reservations = 0;
    fake.request = (request) => {
      if (request.query?.["useNextNumber"] === "true" && ++reservations === 2) {
        return Promise.reject(new Error("boom"));
      }
      return original(request);
    };
    await expect(reserveFreeCreditNoteNumber(fake)).rejects.toThrow("boom");
  });
});
