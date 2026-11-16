/**
 * `creditNotePosDelete` is a list of `{id, objectName}`, never the spec's single object.
 *
 * The spec declares `creditNotePosDelete` of `POST /CreditNote/Factory/saveCreditNote` as one
 * `{id, objectName}` object. sevDesk refuses that form with HTTP 400 "creditNotePosDelete expected
 * array with 'id' and 'objectName'. integer given", while a list of them deletes the stored
 * positions and saves the new ones in the same request (recorded 2026-11-16, probe
 * `write-credit-note-update-draft`; spec/deviations.md D-110, as `voucherPosDelete` in D-054).
 *
 * Guard: `sevdesk_credit_note_update_draft` sends every stored position in a list, also when
 * only one is replaced or removed, and the strict body schema refuses the single-object form, so
 * a builder bug fails before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCreditNoteBodySchema, strictBody } from "../../src/domain/drafts/payloads.js";
import { creditNoteUpdateDraftTool } from "../../src/tools/credit-notes/draft-update.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import { creditNoteUpdateRoutes } from "../unit/tools/drafts/routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("D-110: creditNotePosDelete goes out as a list", () => {
  it("sends the stored positions as a list of refs when one position is removed", async () => {
    const client = new FakeSevdeskClient(creditNoteUpdateRoutes);
    await executeWrite(
      creditNoteUpdateDraftTool,
      { id: 2202, positions: [{ name: "Preisnachlass Lieferung", quantity: 1, unitPrice: 30 }] },
      client,
    );
    const [save] = client.writes();
    expect(save?.path).toBe("/CreditNote/Factory/saveCreditNote");
    const body = save?.body as { creditNotePosDelete: unknown };
    expect(Array.isArray(body.creditNotePosDelete)).toBe(true);
    expect(body.creditNotePosDelete).toEqual([
      { id: 6301, objectName: "CreditNotePos" },
      { id: 6302, objectName: "CreditNotePos" },
    ]);
  });

  it("refuses the spec's single-object form before sending", () => {
    const body = {
      creditNote: {
        id: 2202,
        objectName: "CreditNote",
        mapAll: true,
        creditNoteType: "CN",
        status: 100,
        contact: { id: 1001, objectName: "Contact" },
        contactPerson: { id: 7001, objectName: "SevUser" },
        creditNoteDate: "02.11.2026",
        deliveryDate: 1793574000,
        discount: 0,
        currency: "EUR",
        showNet: true,
        taxRule: { id: 1, objectName: "TaxRule" },
        taxRate: 0,
        smallSettlement: false,
        bookingCategory: "UNDERACHIEVEMENT",
      },
      creditNotePosSave: [],
      creditNotePosDelete: [{ id: 6301, objectName: "CreditNotePos" }],
    };
    expect(() => strictBody(saveCreditNoteBodySchema, body, "credit note")).not.toThrow();
    expect(() =>
      strictBody(
        saveCreditNoteBodySchema,
        { ...body, creditNotePosDelete: { id: 6301, objectName: "CreditNotePos" } },
        "credit note",
      ),
    ).toThrow(/Internal error: the credit note payload does not match its schema/);
  });
});
