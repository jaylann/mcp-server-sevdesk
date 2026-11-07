/**
 * Raw sevDesk rows for the report tests, built from the existing community fixtures (recorded key
 * sets and scalar types, fake values) with per-test overrides, plus a runner for tool handlers.
 */
import type { z } from "zod";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import type { ToolContext } from "../../../../src/tools/types.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";

type Raw = Record<string, unknown>;

function template(fixture: string, id: string): Raw {
  const body = loadFixture(fixture).body as { objects: Raw[] };
  const row = body.objects.find((object) => object["id"] === id);
  if (row === undefined) throw new Error(`fixture ${fixture} has no row ${id}`);
  return structuredClone(row);
}

const INVOICE = template("invoices/invoices-list.json", "1001");
const VOUCHER = template("vouchers/vouchers-list.json", "2001");
const TRANSACTION = template("banking/transactions-list.json", "5001");
const CONTACT = template("contacts/contacts-list.json", "1001");
const CREDIT_NOTE = template("credit-notes/credit-notes-list.json", "2001");
const ORDER = template("orders/orders-list.json", "3002");

/** A GET /Invoice row (embedded contact 1001) with overrides; ids and sums as strings. */
export function invoice(overrides: Raw): Raw {
  return { ...structuredClone(INVOICE), ...overrides };
}

/** A GET /Voucher row (expense, EUR, supplier 1003) with overrides. */
export function voucher(overrides: Raw): Raw {
  return { ...structuredClone(VOUCHER), ...overrides };
}

/** A GET /CheckAccountTransaction row (account 4002) with overrides. */
export function transaction(overrides: Raw): Raw {
  return { ...structuredClone(TRANSACTION), ...overrides };
}

export function contactRow(overrides: Raw): Raw {
  return { ...structuredClone(CONTACT), ...overrides };
}

export function creditNoteRow(overrides: Raw): Raw {
  return { ...structuredClone(CREDIT_NOTE), ...overrides };
}

export function orderRow(overrides: Raw): Raw {
  return { ...structuredClone(ORDER), ...overrides };
}

/** An embedded contact as `embed=contact` returns it (organisation name only). */
export function embeddedContact(id: string, name: string | null): Raw {
  return { id, objectName: "Contact", name, surename: null, familyname: null, name2: null };
}

/** A route answering `path` (and an optional query subset) with these rows as the collection. */
export function rows(
  path: string,
  objects: readonly Raw[],
  query?: Readonly<Record<string, string | number | boolean>>,
): FakeRoute {
  return { path, ...(query === undefined ? {} : { query }), response: { body: { objects } } };
}

/** A route that fails with a sevDesk error. */
export function failing(path: string, kind: SevdeskError["kind"]): FakeRoute {
  return { path, response: { error: new SevdeskError({ kind, message: "Simulated failure." }) } };
}

export const accountsRoute: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};

/** What `runTool` needs of a tool definition. */
interface RunnableTool {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly handler: (args: never, ctx: ToolContext) => Promise<{ data: unknown; summary: string }>;
}

/**
 * Runs a tool's handler on parsed arguments against a fake client. `data` is the result checked
 * against the tool's output schema (typed by the caller).
 */
export async function runTool(
  tool: RunnableTool,
  args: Record<string, unknown>,
  routes: readonly FakeRoute[],
  context?: (client: FakeSevdeskClient) => ToolContext,
) {
  const client = new FakeSevdeskClient(routes);
  const ctx = context === undefined ? testContext(client) : context(client);
  const parsed: unknown = tool.input.parse(args);
  const result = await tool.handler(parsed as never, ctx);
  const data: unknown = tool.output.parse(result.data);
  return { client, result, data };
}

/** A context whose progress callback records calls and can abort the call after `abortAfter`. */
export function progressContext(client: FakeSevdeskClient, abortAfter?: number) {
  const controller = new AbortController();
  const calls: [number, number | undefined, string | undefined][] = [];
  const ctx: ToolContext = {
    ...testContext(client),
    signal: controller.signal,
    progress: (done, total, message) => {
      calls.push([done, total, message]);
      if (abortAfter !== undefined && calls.length >= abortAfter) controller.abort();
      return Promise.resolve();
    },
  };
  return { ctx, calls };
}

/** `count` minimal rows built by `make(index)`. */
export function many(count: number, make: (index: number) => Raw): Raw[] {
  return Array.from({ length: count }, (_, index) => make(index));
}
