/**
 * The `costCentre` argument of the invoice, credit note and voucher draft tools (#87,
 * spec/deviations.md D-092): resolved by id, number or name against the account's cost centres
 * (`GET /CostCentre`, recorded list), refused before any write when unknown or ambiguous, sent as
 * `costCentre: {id, objectName: "CostCentre"}`, shown in the preview, and kept by an update that
 * leaves it out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { creditNoteUpdateDraftTool } from "../../../../src/tools/credit-notes/draft-update.js";
import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { voucherCreateDraftTool } from "../../../../src/tools/vouchers/draft-create.js";
import { voucherUpdateDraftTool } from "../../../../src/tools/vouchers/draft-update.js";
import {
  costCentreRow,
  costCentresRoute,
  costCentresRouteOf,
  RECORDED_CENTRES,
  storedCostCentre,
} from "../../../helpers/cost-centres.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsRoute,
  CREATE_READ_ROUTES,
  draftRow,
  guidanceRoute,
  positionRow,
  positionsRoute,
  readBackRoutes,
  regularRoute,
  saveRoute,
  version2Route,
  voucherRoute,
} from "../vouchers/routes.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  creditNoteUpdateRoutes,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const { first, third } = RECORDED_CENTRES;
const CENTRE_REF = { id: third.id, objectName: "CostCentre" };
const SHOWN = { label: "Cost centre (Kostenstelle)", value: "MCP1 Mustername 3 (id 344959)" };

async function refusal(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
): Promise<SevdeskError> {
  const client = new FakeSevdeskClient(routes);
  const error = await prepareWrite(tool, args, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

/** The stored draft at `path` (fixture `drafts/<fixture>`) with `fields` replaced. */
function storedDraft(path: string, fixture: string, fields: Record<string, unknown>): FakeRoute {
  const stored = loadFixture(`drafts/${fixture}`).body as {
    objects: Record<string, unknown>[];
  };
  return { path, response: { body: { objects: [{ ...stored.objects[0], ...fields }] } } };
}

/** The stored draft invoice 2102 with `fields` replaced. */
function storedInvoice(fields: Record<string, unknown>): FakeRoute {
  return storedDraft("/Invoice/2102", "invoice-2102-draft.json", fields);
}

/** The stored draft credit note 2202 with `fields` replaced. */
function storedCreditNote(fields: Record<string, unknown>): FakeRoute {
  return storedDraft("/CreditNote/2202", "credit-note-2202-draft.json", fields);
}

describe("the costCentre argument", () => {
  it("takes an id or a text, nothing empty, zero or negative", () => {
    const { input } = invoiceCreateDraftTool;
    expect(input.safeParse({ ...invoiceCreateArgs, costCentre: 344959 }).success).toBe(true);
    expect(input.safeParse({ ...invoiceCreateArgs, costCentre: "MCP1" }).success).toBe(true);
    for (const bad of [0, -1, 1.5, "", "   ", null, { id: 1 }]) {
      expect(
        input.safeParse({ ...invoiceCreateArgs, costCentre: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("sevdesk_invoice_create_draft with costCentre", () => {
  const tool = invoiceCreateDraftTool;
  const routes = withRoutes(invoiceCreateRoutes, costCentresRoute);

  it("sends the cost centre named by its number and shows it", async () => {
    const client = new FakeSevdeskClient(routes);
    const plan = await prepareWrite(tool, { ...invoiceCreateArgs, costCentre: "mcp1" }, client);
    expect(plan.state.body.invoice.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.facts).toContainEqual(SHOWN);
    expect(client.callsTo("/CostCentre")[0]?.query).toMatchObject({ limit: 1000 });
  });

  it("sends none and reads no cost centres without the argument", async () => {
    const client = new FakeSevdeskClient(routes);
    const plan = await prepareWrite(tool, invoiceCreateArgs, client);
    expect(plan.state.body.invoice).not.toHaveProperty("costCentre");
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("saves it in the one saveInvoice request", async () => {
    const client = new FakeSevdeskClient(routes);
    await executeWrite(tool, { ...invoiceCreateArgs, costCentre: third.id }, client);
    expect(client.writes()).toHaveLength(1);
    expect(client.writes()[0]?.body).toMatchObject({ invoice: { costCentre: CENTRE_REF } });
  });

  it("refuses an unknown or ambiguous cost centre before anything else", async () => {
    const unknown = await refusal(tool, { ...invoiceCreateArgs, costCentre: "Werkstatt" }, routes);
    expect(unknown.message).toMatch(/^No cost centre \(Kostenstelle\) has this id/);
    const twins = costCentresRouteOf([
      costCentreRow(1, "A", "Lager"),
      costCentreRow(2, "B", "lager"),
    ]);
    const client = new FakeSevdeskClient(withRoutes(invoiceCreateRoutes, twins));
    await expect(
      prepareWrite(tool, { ...invoiceCreateArgs, costCentre: "LAGER" }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /^Several cost centres/ });
    expect(client.calls.map((call) => call.path)).toEqual(["/CostCentre"]);
  });
});

describe("sevdesk_invoice_update_draft with costCentre", () => {
  const tool = invoiceUpdateDraftTool;

  it("sets a new cost centre and shows the change from the stored one", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        storedInvoice({ costCentre: storedCostCentre(first.id) }),
        costCentresRoute,
      ),
    );
    const plan = await prepareWrite(tool, { id: 2102, costCentre: "Mustername 3" }, client);
    expect(plan.state.body.invoice.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.action).toBe(
      "Update draft invoice 2102 for contact 1001: change cost centre.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → MCP1 Mustername 3 (id 344959)",
    });
  });

  it("sets one on a draft without any", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, costCentresRoute));
    const plan = await prepareWrite(tool, { id: 2102, costCentre: third.id }, client);
    expect(plan.state.body.invoice.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "(none) → MCP1 Mustername 3 (id 344959)",
    });
  });

  it("keeps the stored cost centre when the call leaves it out (D-052, D-054)", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(invoiceUpdateRoutes, storedInvoice({ costCentre: storedCostCentre(first.id) })),
    );
    const plan = await prepareWrite(tool, { id: 2102, header: "Rechnung Projekt X" }, client);
    expect(plan.state.body.invoice.costCentre).toEqual({ id: first.id, objectName: "CostCentre" });
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("sends no costCentre key when none is stored and none is asked for", async () => {
    const client = new FakeSevdeskClient(invoiceUpdateRoutes);
    const plan = await prepareWrite(tool, { id: 2102, header: "Rechnung Projekt X" }, client);
    expect(plan.state.body.invoice).not.toHaveProperty("costCentre");
  });

  it("removes the stored cost centre with removeCostCentre: costCentre null (D-092)", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        storedInvoice({ costCentre: storedCostCentre(first.id) }),
        costCentresRoute,
      ),
    );
    const { plan } = await executeWrite(tool, { id: 2102, removeCostCentre: true }, client);
    expect(plan.state.body.invoice.costCentre).toBeNull();
    expect(client.writes()[0]?.body).toMatchObject({ invoice: { id: 2102, costCentre: null } });
    expect(plan.preview.action).toBe(
      "Update draft invoice 2102 for contact 1001: change cost centre.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → removed",
    });
  });

  it("treats removeCostCentre: false like leaving it out", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(invoiceUpdateRoutes, storedInvoice({ costCentre: storedCostCentre(first.id) })),
    );
    const plan = await prepareWrite(
      tool,
      { id: 2102, header: "X", removeCostCentre: false },
      client,
    );
    expect(plan.state.body.invoice.costCentre).toEqual({ id: first.id, objectName: "CostCentre" });
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("refuses removeCostCentre: false alone as nothing to change, before any read", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(invoiceUpdateRoutes, storedInvoice({ costCentre: storedCostCentre(first.id) })),
    );
    await expect(
      prepareWrite(tool, { id: 2102, removeCostCentre: false }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: give at least one field of the invoice besides id.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses costCentre and removeCostCentre together, before any write", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, costCentresRoute));
    await expect(
      prepareWrite(tool, { id: 2102, costCentre: "MCP1", removeCostCentre: true }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Pass either costCentre (a new one) or removeCostCentre, not both.",
    });
    expect(client.callsTo("/CostCentre")).toEqual([]);
    expect(client.writes()).toEqual([]);
  });

  it("refuses removeCostCentre alone on a draft without a cost centre, without writing", async () => {
    const error = await refusal(
      tool,
      { id: 2102, removeCostCentre: true },
      withRoutes(invoiceUpdateRoutes, costCentresRoute),
    );
    expect(error).toMatchObject({ kind: "validation", message: "This draft has no cost centre." });
  });

  it("leaves a removal of nothing out when the call changes something else", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, costCentresRoute));
    const plan = await prepareWrite(
      tool,
      { id: 2102, header: "Rechnung Projekt X", removeCostCentre: true },
      client,
    );
    expect(plan.state.body.invoice).not.toHaveProperty("costCentre");
    expect(plan.preview.action).toBe("Update draft invoice 2102 for contact 1001: change title.");
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("names no change when the same cost centre is given again", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        storedInvoice({ costCentre: storedCostCentre(third.id) }),
        costCentresRoute,
      ),
    );
    const plan = await prepareWrite(tool, { id: 2102, costCentre: "MCP1" }, client);
    expect(plan.preview.action).toMatch(/change nothing visible\.$/);
    expect(plan.state.body.invoice.costCentre).toEqual(CENTRE_REF);
  });

  it("refuses an unknown cost centre without writing", async () => {
    const error = await refusal(
      tool,
      { id: 2102, costCentre: 4711 },
      withRoutes(invoiceUpdateRoutes, costCentresRoute),
    );
    expect(error.kind).toBe("validation");
  });
});

describe("sevdesk_credit_note_create_draft with costCentre", () => {
  const tool = creditNoteCreateDraftTool;
  const routes = withRoutes(creditNoteCreateRoutes, costCentresRoute);

  it("sends and shows the cost centre", async () => {
    const client = new FakeSevdeskClient(routes);
    const plan = await prepareWrite(tool, { ...creditNoteCreateArgs, costCentre: "MCP1" }, client);
    expect(plan.state.body.creditNote.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.facts).toContainEqual(SHOWN);
  });

  it("keeps it in the saved body with the reserved number", async () => {
    const client = new FakeSevdeskClient(routes);
    await executeWrite(tool, { ...creditNoteCreateArgs, costCentre: third.id }, client);
    const save = client.writes().find((call) => call.path === "/CreditNote/Factory/saveCreditNote");
    expect(save?.body).toMatchObject({ creditNote: { costCentre: CENTRE_REF } });
  });

  it("refuses an unknown cost centre without writing", async () => {
    await refusal(tool, { ...creditNoteCreateArgs, costCentre: "Werkstatt" }, routes);
  });
});

describe("sevdesk_credit_note_update_draft with costCentre", () => {
  const tool = creditNoteUpdateDraftTool;
  const onFirst = storedCreditNote({ costCentre: storedCostCentre(first.id) });

  it("sets a new cost centre and shows the change from the stored one", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(creditNoteUpdateRoutes, onFirst, costCentresRoute),
    );
    const { plan } = await executeWrite(tool, { id: 2202, costCentre: "Mustername 3" }, client);
    expect(plan.state.body.creditNote.costCentre).toEqual(CENTRE_REF);
    expect(client.writes()[0]?.body).toMatchObject({
      creditNote: { id: 2202, costCentre: CENTRE_REF },
    });
    expect(plan.preview.action).toBe(
      "Update draft credit note 2202 for contact 1001: change cost centre.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → MCP1 Mustername 3 (id 344959)",
    });
  });

  it("sets one on a draft without any", async () => {
    const client = new FakeSevdeskClient(withRoutes(creditNoteUpdateRoutes, costCentresRoute));
    const plan = await prepareWrite(tool, { id: 2202, costCentre: third.id }, client);
    expect(plan.state.body.creditNote.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "(none) → MCP1 Mustername 3 (id 344959)",
    });
  });

  it("leaves the key out when the call does not name one: sevDesk keeps it (D-092)", async () => {
    const client = new FakeSevdeskClient(withRoutes(creditNoteUpdateRoutes, onFirst));
    const { plan } = await executeWrite(tool, { id: 2202, header: "Gutschrift X" }, client);
    expect(plan.state.body.creditNote).not.toHaveProperty("costCentre");
    const body = client.writes()[0]?.body as { creditNote: Record<string, unknown> };
    expect(body.creditNote).not.toHaveProperty("costCentre");
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("removes the stored cost centre with removeCostCentre: costCentre null (D-092)", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(creditNoteUpdateRoutes, onFirst, costCentresRoute),
    );
    const { plan } = await executeWrite(tool, { id: 2202, removeCostCentre: true }, client);
    expect(plan.state.body.creditNote.costCentre).toBeNull();
    expect(client.writes()[0]?.body).toMatchObject({
      creditNote: { id: 2202, costCentre: null },
    });
    expect(plan.preview.action).toBe(
      "Update draft credit note 2202 for contact 1001: change cost centre.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → removed",
    });
  });

  it("refuses removeCostCentre alone on a draft without a cost centre, without writing", async () => {
    const error = await refusal(
      tool,
      { id: 2202, removeCostCentre: true },
      withRoutes(creditNoteUpdateRoutes, costCentresRoute),
    );
    expect(error).toMatchObject({ kind: "validation", message: "This draft has no cost centre." });
  });

  it("refuses removeCostCentre: false alone as nothing to change, before any read", async () => {
    const client = new FakeSevdeskClient(withRoutes(creditNoteUpdateRoutes, onFirst));
    await expect(
      prepareWrite(tool, { id: 2202, removeCostCentre: false }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: give at least one field of the credit note besides id.",
    });
    expect(client.calls).toEqual([]);
  });

  it("refuses costCentre and removeCostCentre together, before any write", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(creditNoteUpdateRoutes, onFirst, costCentresRoute),
    );
    await expect(
      prepareWrite(tool, { id: 2202, costCentre: "MCP1", removeCostCentre: true }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Pass either costCentre (a new one) or removeCostCentre, not both.",
    });
    expect(client.callsTo("/CostCentre")).toEqual([]);
    expect(client.writes()).toEqual([]);
  });

  it("refuses an unknown cost centre without writing", async () => {
    const error = await refusal(
      tool,
      { id: 2202, costCentre: "Werkstatt" },
      withRoutes(creditNoteUpdateRoutes, costCentresRoute),
    );
    expect(error.kind).toBe("validation");
  });
});

describe("sevdesk_voucher_create_draft with costCentre", () => {
  const tool = voucherCreateDraftTool;
  const args = {
    supplierId: 1001,
    number: "ER-2026-0815",
    date: "2026-11-02",
    positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
  };
  const routes = [costCentresRoute, ...CREATE_READ_ROUTES, saveRoute(), ...readBackRoutes()];

  it("sends the cost centre and shows it in both languages", async () => {
    const client = new FakeSevdeskClient(routes);
    const plan = await prepareWrite(tool, { ...args, costCentre: "Mustername 3" }, client);
    expect(plan.state.body.voucher.costCentre).toEqual(CENTRE_REF);
    expect(plan.preview.facts).toContainEqual(SHOWN);
    expect(plan.previewDe?.facts).toContainEqual({
      label: "Kostenstelle",
      value: "MCP1 Mustername 3 (ID 344959)",
    });
  });

  it("sends none without the argument", async () => {
    const client = new FakeSevdeskClient(routes);
    const plan = await prepareWrite(tool, args, client);
    expect(plan.state.body.voucher).not.toHaveProperty("costCentre");
    expect(client.callsTo("/CostCentre")).toEqual([]);
  });

  it("refuses an unknown cost centre without writing", async () => {
    await refusal(tool, { ...args, costCentre: 1 }, routes);
  });
});

describe("sevdesk_voucher_update_draft with costCentre", () => {
  const tool = voucherUpdateDraftTool;

  function client(row = draftRow(), extra: readonly FakeRoute[] = []): FakeSevdeskClient {
    return new FakeSevdeskClient([
      ...extra,
      voucherRoute(row),
      positionsRoute(2101, [positionRow()]),
      version2Route,
      regularRoute,
      guidanceRoute,
      accountsRoute,
      saveRoute(),
    ]);
  }

  it("sets a new cost centre and shows the change in both languages", async () => {
    const fake = client(draftRow({ costCentre: storedCostCentre(first.id) }), [costCentresRoute]);
    const { plan } = await executeWrite(tool, { id: 2101, costCentre: "mcp1" }, fake);
    expect(fake.writes()[0]?.body).toMatchObject({ voucher: { costCentre: CENTRE_REF } });
    expect(plan.preview.action).toBe("Update draft voucher 2101: change cost centre.");
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → MCP1 Mustername 3 (id 344959)",
    });
    expect(plan.previewDe?.action).toBe("Belegentwurf 2101 aktualisieren: Kostenstelle.");
    expect(plan.previewDe?.facts).toContainEqual({
      label: "Kostenstelle",
      value: "M62573C Mustername 1 (ID 344964) → MCP1 Mustername 3 (ID 344959)",
    });
  });

  it("keeps the stored cost centre when the call leaves it out", async () => {
    const fake = client(draftRow({ costCentre: storedCostCentre(first.id) }));
    await executeWrite(tool, { id: 2101, number: "ER-2026-0816" }, fake);
    expect(fake.writes()[0]?.body).toMatchObject({
      voucher: { costCentre: { id: first.id, objectName: "CostCentre" } },
    });
    expect(fake.callsTo("/CostCentre")).toEqual([]);
  });

  it("sends no costCentre key when none is stored and none is asked for", async () => {
    const fake = client();
    await executeWrite(tool, { id: 2101, number: "ER-2026-0816" }, fake);
    const body = fake.writes()[0]?.body as { voucher: Record<string, unknown> };
    expect(body.voucher).not.toHaveProperty("costCentre");
  });

  it("removes the stored cost centre and shows which one, in both languages", async () => {
    const fake = client(draftRow({ costCentre: storedCostCentre(first.id) }), [costCentresRoute]);
    const { plan } = await executeWrite(tool, { id: 2101, removeCostCentre: true }, fake);
    expect(fake.writes()[0]?.body).toMatchObject({ voucher: { id: 2101, costCentre: null } });
    expect(plan.preview.facts).toContainEqual({
      label: "Cost centre (Kostenstelle)",
      value: "M62573C Mustername 1 (id 344964) → removed",
    });
    expect(plan.previewDe?.facts).toContainEqual({
      label: "Kostenstelle",
      value: "M62573C Mustername 1 (ID 344964) → entfernt",
    });
  });

  it("refuses removeCostCentre alone on a draft without a cost centre, without writing", async () => {
    const error = await refusal(tool, { id: 2101, removeCostCentre: true }, [
      costCentresRoute,
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
    ]);
    expect(error).toMatchObject({ kind: "validation", message: "This draft has no cost centre." });
  });

  it("refuses removeCostCentre: false alone as nothing to change", async () => {
    const fake = client(draftRow({ costCentre: storedCostCentre(first.id) }), [costCentresRoute]);
    await expect(
      prepareWrite(tool, { id: 2101, removeCostCentre: false }, fake),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: give at least one field of the voucher besides id.",
    });
    expect(fake.calls).toEqual([]);
  });

  it("leaves a removal of nothing out when the call changes something else", async () => {
    const fake = client(draftRow(), [costCentresRoute]);
    const { plan } = await executeWrite(
      tool,
      { id: 2101, number: "ER-2026-0816", removeCostCentre: true },
      fake,
    );
    const body = fake.writes()[0]?.body as { voucher: Record<string, unknown> };
    expect(body.voucher).not.toHaveProperty("costCentre");
    expect(plan.preview.action).toBe("Update draft voucher 2101: change Belegnummer.");
    expect(fake.callsTo("/CostCentre")).toEqual([]);
  });

  it("refuses costCentre and removeCostCentre together", async () => {
    const message = (
      await refusal(tool, { id: 2101, costCentre: 1, removeCostCentre: true }, [
        costCentresRoute,
        voucherRoute(draftRow()),
        positionsRoute(2101, [positionRow()]),
      ])
    ).message;
    expect(message).toBe("Pass either costCentre (a new one) or removeCostCentre, not both.");
  });

  it("refuses an unknown cost centre without writing", async () => {
    await refusal(tool, { id: 2101, costCentre: "Werkstatt" }, [
      costCentresRoute,
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
    ]);
  });
});
