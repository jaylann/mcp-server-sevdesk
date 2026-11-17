/**
 * Cost centres (Kostenstellen, spec/deviations.md D-091, D-092): the list read, the `costCentre`
 * argument (id, number or name; unknown and ambiguous ones refused), the list filter and the
 * approval facts.
 */
import { describe, expect, it } from "vitest";

import {
  chooseCostCentre,
  costCentreChange,
  costCentreFacts,
  costCentreFilterQuery,
  costCentreLabel,
  costCentreOf,
  costCentreUpdate,
  costCentreUpdatePayload,
  describeCostCentre,
  inCostCentre,
  listCostCentres,
  resolveCostCentre,
  showCostCentre,
  storedCostCentre,
} from "../../../src/domain/cost-centres.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  costCentreRow,
  costCentresRoute,
  costCentresRouteOf,
  RECORDED_CENTRES,
} from "../../helpers/cost-centres.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

const { first, second, third } = RECORDED_CENTRES;

function recorded(): FakeSevdeskClient {
  return new FakeSevdeskClient([costCentresRoute]);
}

describe("listCostCentres", () => {
  it("reads one page with an explicit limit and parses the recorded rows", async () => {
    const client = recorded();
    const list = await listCostCentres(client);
    expect(list.items).toEqual([first, second, third]);
    expect(list).toMatchObject({ total: 3, truncated: false });
    expect(client.callsTo("/CostCentre")).toHaveLength(1);
    expect(client.callsTo("/CostCentre")[0]?.query).toMatchObject({ limit: 1000 });
  });

  it("marks the default cost centre and leaves out blank numbers and names", async () => {
    const client = new FakeSevdeskClient([
      costCentresRouteOf([costCentreRow(1, "HQ", "Zentrale", true), costCentreRow(2, "", " ")]),
    ]);
    const list = await listCostCentres(client);
    expect(list.items).toEqual([
      { id: 1, number: "HQ", name: "Zentrale", isDefault: true },
      { id: 2 },
    ]);
  });

  it("reports a list longer than the page as cut", async () => {
    const client = new FakeSevdeskClient([costCentresRouteOf([costCentreRow(1, "A", "A")], 1001)]);
    expect(await listCostCentres(client)).toMatchObject({ total: 1001, truncated: true });
  });
});

describe("resolveCostCentre", () => {
  it("takes a number argument as the id", async () => {
    expect(await resolveCostCentre(recorded(), third.id)).toEqual(third);
  });

  it("finds a text by number or name, ignoring case and accents", async () => {
    expect(await resolveCostCentre(recorded(), "mcp1")).toEqual(third);
    expect(await resolveCostCentre(recorded(), " mustername 2 ")).toEqual(second);
    const client = new FakeSevdeskClient([costCentresRouteOf([costCentreRow(5, "K5", "Café")])]);
    expect(await resolveCostCentre(client, "CAFE")).toEqual({ id: 5, number: "K5", name: "Café" });
  });

  it("finds a text of digits by id too", async () => {
    expect(await resolveCostCentre(recorded(), "344962")).toEqual(second);
  });

  it("refuses an id, number or name no cost centre has", async () => {
    await expect(resolveCostCentre(recorded(), 7)).rejects.toMatchObject({
      kind: "validation",
      message:
        "No cost centre (Kostenstelle) has this id, number or name. " +
        "sevdesk_reference_lookup kind=cost_centres lists them.",
    });
    await expect(resolveCostCentre(recorded(), "Werkstatt")).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("says when an unknown one may be beyond the cut list", async () => {
    const client = new FakeSevdeskClient([costCentresRouteOf([costCentreRow(1, "A", "A")], 1500)]);
    await expect(resolveCostCentre(client, "B")).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringMatching(/^The account has more than 1,000 cost centres/) as unknown,
    });
  });

  it("refuses a text several cost centres match, unless one is spelled exactly so", async () => {
    const client = new FakeSevdeskClient([
      costCentresRouteOf([
        costCentreRow(1, "100", "Vertrieb"),
        costCentreRow(2, "200", "vertrieb"),
        costCentreRow(3, "300", "Lager"),
        costCentreRow(4, "400", "lager"),
        costCentreRow(100, "500", "Einkauf"),
      ]),
    ]);
    expect(await resolveCostCentre(client, "vertrieb")).toMatchObject({ id: 2 });
    await expect(resolveCostCentre(client, "LAGER")).rejects.toMatchObject({
      kind: "validation",
      message:
        "Several cost centres have this number or name (compared ignoring case and accents). " +
        "Pass the id instead; sevdesk_reference_lookup kind=cost_centres lists them.",
    });
    // "100" is the number of cost centre 1 and the id of cost centre 100.
    await expect(resolveCostCentre(client, "100")).rejects.toMatchObject({ kind: "validation" });
    expect(await resolveCostCentre(client, 100)).toMatchObject({ id: 100 });
  });

  it("never puts the argument or upstream text into the message", async () => {
    await expect(resolveCostCentre(recorded(), "<script>Werkstatt")).rejects.not.toMatchObject({
      message: expect.stringContaining("Werkstatt") as unknown,
    });
  });
});

describe("chooseCostCentre", () => {
  it("describes the stored cost centre from the same read", async () => {
    const client = recorded();
    expect(await chooseCostCentre(client, "MCP1", first.id)).toEqual({
      centre: third,
      stored: first,
    });
    expect(await chooseCostCentre(client, "MCP1", 99)).toEqual({
      centre: third,
      stored: { id: 99 },
    });
    expect(await chooseCostCentre(client, "MCP1", undefined)).toEqual({
      centre: third,
      stored: undefined,
    });
    expect(client.callsTo("/CostCentre")).toHaveLength(3);
  });
});

describe("costCentreUpdate (set, remove or keep)", () => {
  /** A call on a draft that stores `storedId`, giving `given` (as `assertChanges` returns). */
  function on(storedId: number | undefined, ...given: string[]) {
    return { storedId, given };
  }

  it("keeps the stored one without a request when nothing is asked", async () => {
    const client = recorded();
    expect(await costCentreUpdate(client, {}, on(first.id, "header"))).toBeUndefined();
    expect(
      await costCentreUpdate(client, { removeCostCentre: false }, on(first.id, "header")),
    ).toBeUndefined();
    expect(client.calls).toEqual([]);
    expect(costCentreUpdatePayload(undefined, first.id)).toEqual({
      id: first.id,
      objectName: "CostCentre",
    });
    expect(costCentreUpdatePayload(undefined, undefined)).toBeUndefined();
  });

  it("removes: the payload is null and the change names the removed one", async () => {
    const update = await costCentreUpdate(
      recorded(),
      { removeCostCentre: true },
      on(first.id, "removeCostCentre"),
    );
    expect(update).toEqual({ next: null, stored: first });
    if (update === undefined) throw new Error("expected an update");
    expect(costCentreUpdatePayload(update, first.id)).toBeNull();
    expect(costCentreChange(update)).toEqual(["M62573C Mustername 1 (id 344964)", "removed"]);
    expect(costCentreChange(update, "de")).toEqual([
      "M62573C Mustername 1 (ID 344964)",
      "entfernt",
    ]);
  });

  it("refuses removing alone from a document without one, and reads nothing", async () => {
    const client = recorded();
    await expect(
      costCentreUpdate(client, { removeCostCentre: true }, on(undefined, "removeCostCentre")),
    ).rejects.toMatchObject({ kind: "validation", message: "This draft has no cost centre." });
    expect(client.calls).toEqual([]);
  });

  it("leaves removing nothing out when the call changes other fields", async () => {
    const client = recorded();
    expect(
      await costCentreUpdate(
        client,
        { removeCostCentre: true },
        on(undefined, "header", "removeCostCentre"),
      ),
    ).toBeUndefined();
    expect(client.calls).toEqual([]);
  });

  it("sets a new one and refuses both arguments together", async () => {
    const update = await costCentreUpdate(
      recorded(),
      { costCentre: "MCP1" },
      on(undefined, "costCentre"),
    );
    expect(update).toEqual({ next: third, stored: undefined });
    if (update === undefined) throw new Error("expected an update");
    expect(costCentreUpdatePayload(update, undefined)).toEqual({
      id: third.id,
      objectName: "CostCentre",
    });
    expect(costCentreChange(update)).toEqual([undefined, "MCP1 Mustername 3 (id 344959)"]);
    await expect(
      costCentreUpdate(
        recorded(),
        { costCentre: 1, removeCostCentre: true },
        on(first.id, "costCentre", "removeCostCentre"),
      ),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("stored cost centres", () => {
  it("describes an id with number and name, or the id alone when it is not listed", async () => {
    expect(await describeCostCentre(recorded(), second.id)).toEqual(second);
    expect(await describeCostCentre(recorded(), 42)).toEqual({ id: 42 });
  });

  it("reads nothing for a document without one", async () => {
    const client = recorded();
    expect(await storedCostCentre(client, { id: "1", costCentre: null })).toBeUndefined();
    expect(await storedCostCentre(client, { id: "1" })).toBeUndefined();
    expect(await costCentreOf(client, undefined)).toEqual({});
    expect(client.calls).toEqual([]);
  });

  it("reads the stored reference of a raw record", async () => {
    const raw = { id: "1", costCentre: { id: String(third.id), objectName: "CostCentre" } };
    expect(await storedCostCentre(recorded(), raw)).toEqual({ centre: third, unread: false });
    expect(await costCentreOf(recorded(), third.id)).toEqual({ costCentre: third });
  });

  it("shows the id alone, flagged unread, when sevDesk refuses the list", async () => {
    for (const kind of ["auth", "server", "network", "timeout", "unexpected_response"] as const) {
      const client = new FakeSevdeskClient([
        { path: "/CostCentre", response: { error: new SevdeskError({ kind, message: "No." }) } },
      ]);
      expect(await showCostCentre(client, third.id), kind).toEqual({
        centre: { id: third.id },
        unread: true,
      });
      expect(await costCentreOf(client, third.id), kind).toEqual({
        costCentre: { id: third.id },
      });
    }
  });

  it("passes a cancelled call and the server's own guard on, and fails describeCostCentre", async () => {
    for (const kind of ["aborted", "blocked"] as const) {
      const client = new FakeSevdeskClient([
        { path: "/CostCentre", response: { error: new SevdeskError({ kind, message: "No." }) } },
      ]);
      await expect(showCostCentre(client, third.id)).rejects.toMatchObject({ kind });
    }
    const refused = new FakeSevdeskClient([
      {
        path: "/CostCentre",
        response: { error: new SevdeskError({ kind: "auth", message: "No." }) },
      },
    ]);
    // The update previews keep failing: they describe a cost centre the call changes.
    await expect(describeCostCentre(refused, third.id)).rejects.toMatchObject({ kind: "auth" });
  });

  it("labels and facts show number, name and id in both languages", () => {
    expect(costCentreLabel(third)).toBe("MCP1 Mustername 3 (id 344959)");
    expect(costCentreLabel({ id: 42 })).toBe("id 42");
    expect(costCentreLabel({ id: 42 }, "de")).toBe("ID 42");
    expect(costCentreFacts(third, "en")).toEqual([
      { label: "Cost centre (Kostenstelle)", value: "MCP1 Mustername 3 (id 344959)" },
    ]);
    expect(costCentreFacts(third, "de")).toEqual([
      { label: "Kostenstelle", value: "MCP1 Mustername 3 (ID 344959)" },
    ]);
    expect(costCentreFacts(undefined, "de")).toEqual([]);
  });
});

describe("the list filter", () => {
  it("sends both keys and keeps only rows on the cost centre", () => {
    expect(costCentreFilterQuery(third)).toEqual({
      "costCentre[id]": third.id,
      "costCentre[objectName]": "CostCentre",
    });
    expect(costCentreFilterQuery(undefined)).toEqual({});
    expect(inCostCentre(third, third.id)).toBe(true);
    expect(inCostCentre(third, first.id)).toBe(false);
    expect(inCostCentre(third, undefined)).toBe(false);
    expect(inCostCentre(undefined, undefined)).toBe(true);
  });
});
