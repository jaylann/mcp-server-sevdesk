/**
 * Regression (spec/deviations.md D-090): the document lists filter by tag only with
 * `tags[0][id]` + `tags[0][objectName]=Tag`. `tag[id]` and `tag` are ignored without an error, so
 * a wrong spelling, or a filter left out for an unknown name, would answer the whole list as if it
 * were the tagged documents. Each list tool must (a) refuse a name no tag has instead of listing
 * without a filter, (b) send the measured spelling, and (c) drop rows the tag's relations do not
 * name even when sevDesk answers every row.
 */
import { describe, expect, it } from "vitest";

import { creditNotesListTool } from "../../src/tools/credit-notes/list.js";
import { invoicesListTool } from "../../src/tools/invoices/list.js";
import { ordersListTool } from "../../src/tools/orders/list.js";
import type { ToolContext } from "../../src/tools/types.js";
import { vouchersListTool } from "../../src/tools/vouchers/list.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../helpers/fake-client.js";
import {
  relationRow,
  tagRow,
  tagsRoute,
  tagUsesRoute,
} from "../unit/tools/documents/tag-support.js";
import { creditNoteRow, invoiceRow, orderRow, type Row } from "../unit/tools/lifecycle/helpers.js";

function voucherRow(overrides: Row): Row {
  const objects = (loadFixture("vouchers/voucher-2001.json").body as { objects: Row[] }).objects;
  return { ...structuredClone(objects[0]), ...overrides };
}

/** What a list call returned, reduced to what the test checks. */
interface Listed {
  readonly ids: number[];
  readonly tagFilter: unknown;
}

interface ListCase {
  readonly path: string;
  readonly objectName: string;
  readonly row: (id: string) => Row;
  readonly list: (ctx: ToolContext, tag: string) => Promise<Listed>;
}

function listed(data: { items: readonly { id: number }[]; tagFilter?: unknown }): Listed {
  return { ids: data.items.map((item) => item.id), tagFilter: data.tagFilter };
}

const CASES: readonly ListCase[] = [
  {
    path: "/Invoice",
    objectName: "Invoice",
    row: (id) => invoiceRow({ id }),
    list: async (ctx, tag) =>
      listed((await invoicesListTool.handler(invoicesListTool.input.parse({ tag }), ctx)).data),
  },
  {
    path: "/CreditNote",
    objectName: "CreditNote",
    row: (id) => creditNoteRow({ id }),
    list: async (ctx, tag) =>
      listed(
        (await creditNotesListTool.handler(creditNotesListTool.input.parse({ tag }), ctx)).data,
      ),
  },
  {
    path: "/Order",
    objectName: "Order",
    row: (id) => orderRow({ id }),
    list: async (ctx, tag) =>
      listed((await ordersListTool.handler(ordersListTool.input.parse({ tag }), ctx)).data),
  },
  {
    path: "/Voucher",
    objectName: "Voucher",
    row: (id) => voucherRow({ id }),
    list: async (ctx, tag) =>
      listed((await vouchersListTool.handler(vouchersListTool.input.parse({ tag }), ctx)).data),
  },
];

const TAGS = tagsRoute([tagRow(7001, "Projekt Y"), tagRow(7002, "Filiale München")]);

function call(testCase: ListCase, routes: readonly FakeRoute[], tag: string) {
  const client = new FakeSevdeskClient(routes);
  return { client, run: testCase.list(testContext(client), tag) };
}

describe.each(CASES)("$path: the tag filter never returns the unfiltered list", (testCase) => {
  it("refuses a name no tag has, without listing a single document", async () => {
    const list: FakeRoute = {
      path: testCase.path,
      response: { body: { objects: [testCase.row("501"), testCase.row("502")] } },
    };
    const { client, run } = call(testCase, [TAGS, list], "Projekt Z");
    await expect(run).rejects.toMatchObject({
      kind: "validation",
      message:
        "No tag has this name (compared ignoring case, accents and ß/ss), so no document " +
        "carries it. sevdesk_tags_list lists the tags.",
    });
    expect(client.callsTo(testCase.path)).toEqual([]);
  });

  it("sends tags[0][id] and drops every row the tag's relations do not name", async () => {
    // sevDesk ignoring the filter: both rows come back, only 501 carries the tag.
    const list: FakeRoute = {
      path: testCase.path,
      response: { body: { objects: [testCase.row("501"), testCase.row("502")] } },
    };
    const uses = tagUsesRoute(7001, [
      relationRow(8101, 7001, testCase.objectName, 501),
      // Another kind with the same id must not let 502 through.
      relationRow(8102, 7001, testCase.objectName === "Order" ? "Invoice" : "Order", 502),
    ]);
    const { client, run } = call(testCase, [TAGS, uses, list], "projekt y");
    const result = await run;
    expect(result.ids).toEqual([501]);
    expect(result.tagFilter).toEqual({ tagId: 7001, rowsChecked: true });
    const [request] = client.callsTo(testCase.path);
    expect(request?.query).toMatchObject({ "tags[0][id]": 7001, "tags[0][objectName]": "Tag" });
    expect(request?.query).not.toHaveProperty("tag[id]");
    expect(request?.query).not.toHaveProperty("tag");
  });
});
