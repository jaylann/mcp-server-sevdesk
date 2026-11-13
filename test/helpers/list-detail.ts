/** Shared fixture scenarios for list-detail regressions and reproducible context measurements. */
import { z } from "zod";

import { transactionsListTool } from "../../src/tools/banking/transactions.js";
import { contactsSearchTool } from "../../src/tools/contacts/search.js";
import { creditNotesListTool } from "../../src/tools/credit-notes/list.js";
import { invoicesListTool } from "../../src/tools/invoices/list.js";
import { ordersListTool } from "../../src/tools/orders/list.js";
import { partsListTool } from "../../src/tools/parts/list.js";
import type { ReadToolDefinition } from "../../src/tools/types.js";
import { vouchersListTool } from "../../src/tools/vouchers/list.js";
import { type FakeRoute, loadFixture } from "./fake-client.js";

interface ListCase {
  readonly tool: ReadToolDefinition;
  readonly path: string;
  readonly fixture: string;
  readonly extraRoutes?: readonly FakeRoute[];
}

export const LIST_CASES: readonly ListCase[] = [
  { tool: invoicesListTool, path: "/Invoice", fixture: "invoices/invoices-list.json" },
  {
    tool: creditNotesListTool,
    path: "/CreditNote",
    fixture: "credit-notes/credit-notes-list.json",
  },
  { tool: ordersListTool, path: "/Order", fixture: "orders/orders-list.json" },
  { tool: vouchersListTool, path: "/Voucher", fixture: "vouchers/vouchers-list.json" },
  {
    tool: transactionsListTool,
    path: "/CheckAccountTransaction",
    fixture: "banking/transactions-list.json",
    extraRoutes: [{ path: "/CheckAccount", response: { fixture: "banking/check-accounts.json" } }],
  },
  { tool: contactsSearchTool, path: "/Contact", fixture: "contacts/contacts-list.json" },
  { tool: partsListTool, path: "/Part", fixture: "parts/parts-list.json" },
];

/** Cycle all scrubbed community rows (including sparse/foreign-currency rows) to a fixed size. */
export function listRoutes(testCase: ListCase, count?: number): FakeRoute[] {
  const { objects } = z
    .object({ objects: z.array(z.record(z.string(), z.unknown())) })
    .parse(loadFixture(testCase.fixture).body);
  const rows =
    count === undefined
      ? objects
      : Array.from({ length: count }, (_, index) => ({
          ...objects[index % objects.length],
          id: String(10_000 + index),
        }));
  return [
    { path: testCase.path, response: { body: { objects: rows } } },
    ...(testCase.extraRoutes ?? []),
  ];
}
