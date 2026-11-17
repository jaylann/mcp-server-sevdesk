/**
 * Routes and rows for cost centres (Kostenstellen): the recorded `GET /CostCentre` list
 * (`test/fixtures/recorded/2026-11-16/cost-centres/cost-centres-list.json`, spec/deviations.md
 * D-091) and rows with its keys for other lists.
 *
 * The recorded list has three cost centres: 344964 "M62573C" (Mustername 1), 344962 "M62573A"
 * (Mustername 2) and 344959 "MCP1" (Mustername 3), none of them the default.
 */
import type { FakeRoute } from "./fake-client.js";

type Row = Record<string, unknown>;

/** The recorded cost centre list, relative to `test/fixtures/`. */
const COST_CENTRES_FIXTURE = "recorded/2026-11-16/cost-centres/cost-centres-list.json";

/** The recorded cost centres, by id. */
export const RECORDED_CENTRES = {
  first: { id: 344964, number: "M62573C", name: "Mustername 1" },
  second: { id: 344962, number: "M62573A", name: "Mustername 2" },
  third: { id: 344959, number: "MCP1", name: "Mustername 3" },
} as const;

/** `GET /CostCentre` answering the recorded list. */
export const costCentresRoute: FakeRoute = {
  path: "/CostCentre",
  response: { fixture: COST_CENTRES_FIXTURE },
};

/** A `GET /CostCentre` row with the recorded keys. */
export function costCentreRow(id: number, number: string, name: string, isDefault = false): Row {
  return {
    id: String(id),
    objectName: "CostCentre",
    additionalInformation: null,
    create: "2026-11-16T21:56:49+01:00",
    update: "2026-11-16T21:56:49+01:00",
    sevClient: { id: "9001", objectName: "SevClient" },
    number,
    name,
    color: null,
    postingAccount: null,
    defaultCentre: isDefault ? "1" : "0",
  };
}

/** `GET /CostCentre` answering `rows` as one recorded page (with `total`). */
export function costCentresRouteOf(rows: readonly Row[], total = rows.length): FakeRoute {
  return { path: "/CostCentre", response: { body: { total, objects: rows } } };
}

/** The `costCentre` reference a document stores. */
export function storedCostCentre(id: number): { id: string; objectName: "CostCentre" } {
  return { id: String(id), objectName: "CostCentre" };
}
