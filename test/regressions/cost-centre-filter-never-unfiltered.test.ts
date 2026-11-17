/**
 * Regression (spec/deviations.md D-092): `GET /Invoice` and `GET /Voucher` filter by cost centre
 * only with `costCentre[id]` + `costCentre[objectName]=CostCentre`; `costCentre=<id>` alone is
 * refused (422), and an unknown spelling would be ignored like the tag filter's (D-090, D-003),
 * answering the whole list as if it were the cost centre's documents. Each list tool must
 * (a) refuse a cost centre the account does not have instead of listing without a filter,
 * (b) send both measured keys, and (c) drop rows that carry another cost centre, or none, even
 * when sevDesk answers every row.
 */
import { describe, expect, it } from "vitest";

import { invoicesListTool } from "../../src/tools/invoices/list.js";
import type { ToolContext } from "../../src/tools/types.js";
import { vouchersListTool } from "../../src/tools/vouchers/list.js";
import { costCentresRoute, RECORDED_CENTRES, storedCostCentre } from "../helpers/cost-centres.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../helpers/fake-client.js";
import { invoiceRow, type Row } from "../unit/tools/lifecycle/helpers.js";

function voucherRow(overrides: Row): Row {
  const objects = (loadFixture("vouchers/voucher-2001.json").body as { objects: Row[] }).objects;
  return { ...structuredClone(objects[0]), ...overrides };
}

/** What a list call returned, reduced to what the test checks. */
interface Listed {
  readonly ids: number[];
  readonly costCentreFilter: unknown;
}

interface ListCase {
  readonly path: string;
  readonly row: (id: string, costCentre: unknown) => Row;
  readonly list: (ctx: ToolContext, costCentre: string | number) => Promise<Listed>;
}

function listed(data: { items: readonly { id: number }[]; costCentreFilter?: unknown }): Listed {
  return { ids: data.items.map((item) => item.id), costCentreFilter: data.costCentreFilter };
}

const CASES: readonly ListCase[] = [
  {
    path: "/Invoice",
    row: (id, costCentre) => invoiceRow({ id, costCentre }),
    list: async (ctx, costCentre) =>
      listed(
        (await invoicesListTool.handler(invoicesListTool.input.parse({ costCentre }), ctx)).data,
      ),
  },
  {
    path: "/Voucher",
    row: (id, costCentre) => voucherRow({ id, costCentre }),
    list: async (ctx, costCentre) =>
      listed(
        (await vouchersListTool.handler(vouchersListTool.input.parse({ costCentre }), ctx)).data,
      ),
  },
];

const { first, third } = RECORDED_CENTRES;

function call(testCase: ListCase, routes: readonly FakeRoute[], costCentre: string | number) {
  const client = new FakeSevdeskClient(routes);
  return { client, run: testCase.list(testContext(client), costCentre) };
}

describe.each(CASES)(
  "$path: the cost-centre filter never returns the unfiltered list",
  (testCase) => {
    const everyRow: FakeRoute = {
      path: testCase.path,
      response: {
        body: {
          objects: [
            testCase.row("501", storedCostCentre(third.id)),
            testCase.row("502", storedCostCentre(first.id)),
            testCase.row("503", null),
          ],
        },
      },
    };

    it("refuses a cost centre the account does not have, without listing a single document", async () => {
      for (const unknown of ["Werkstatt", 4711]) {
        const { client, run } = call(testCase, [costCentresRoute, everyRow], unknown);
        await expect(run).rejects.toMatchObject({
          kind: "validation",
          message:
            "No cost centre (Kostenstelle) has this id, number or name. " +
            "sevdesk_reference_lookup kind=cost_centres lists them.",
        });
        expect(client.callsTo(testCase.path)).toEqual([]);
      }
    });

    it("sends both keys and drops every row on another cost centre or none", async () => {
      // sevDesk ignoring the filter: all three rows come back, only 501 is on MCP1.
      const { client, run } = call(testCase, [costCentresRoute, everyRow], "mcp1");
      const result = await run;
      expect(result.ids).toEqual([501]);
      expect(result.costCentreFilter).toEqual(third);
      const [request] = client.callsTo(testCase.path);
      expect(request?.query).toMatchObject({
        "costCentre[id]": third.id,
        "costCentre[objectName]": "CostCentre",
      });
      expect(request?.query).not.toHaveProperty("costCentre");
    });
  },
);
