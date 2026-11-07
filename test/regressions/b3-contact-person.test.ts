/**
 * B3: invoices, orders and credit notes need a contact person (`contactPerson`, a SevUser). Other
 * integrations forgot it or silently took the first user. The draft tools always send one: the
 * requested user (checked), the account's only user, or, with several users, an error that asks
 * which one (ids only; names are upstream text).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../src/tools/credit-notes/draft-create.js";
import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { prepareWrite } from "../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  twoUsersRoute,
  withRoutes,
} from "../unit/tools/drafts/routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const creates: readonly [
  string,
  AnyWriteToolDefinition,
  Record<string, unknown>,
  readonly FakeRoute[],
  string,
][] = [
  ["invoice", invoiceCreateDraftTool, invoiceCreateArgs, invoiceCreateRoutes, "invoice"],
  [
    "credit note",
    creditNoteCreateDraftTool,
    creditNoteCreateArgs,
    creditNoteCreateRoutes,
    "creditNote",
  ],
  ["order", orderCreateDraftTool, orderCreateArgs, orderCreateRoutes, "order"],
];

async function body(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
  key: string,
) {
  const plan = await prepareWrite(tool, args, new FakeSevdeskClient(routes));
  return (plan.state as { body: Record<string, Record<string, unknown>> }).body[key];
}

describe("B3: every draft carries a contact person", () => {
  it.each(creates)("%s: the account's only user", async (_label, tool, args, routes, key) => {
    expect((await body(tool, args, routes, key))?.["contactPerson"]).toEqual({
      id: 2001,
      objectName: "SevUser",
    });
  });

  it.each(creates)(
    "%s: the requested user among several",
    async (_label, tool, args, routes, key) => {
      const document = await body(
        tool,
        { ...args, contactPersonId: 2002 },
        withRoutes(routes, twoUsersRoute),
        key,
      );
      expect(document?.["contactPerson"]).toEqual({ id: 2002, objectName: "SevUser" });
    },
  );

  it.each(creates)(
    "%s: several users and none requested is an error with ids only",
    async (_label, tool, args, routes) => {
      const client = new FakeSevdeskClient(withRoutes(routes, twoUsersRoute));
      const error = await prepareWrite(tool, args, client).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).message).toContain("(ids 2001, 2002)");
      expect((error as SevdeskError).message).not.toContain("Erika");
      expect(client.writes()).toEqual([]);
    },
  );

  it("update: keeps the stored contact person without reading users", async () => {
    const client = new FakeSevdeskClient(invoiceUpdateRoutes);
    const plan = await prepareWrite(invoiceUpdateDraftTool, { id: 2102, header: "X" }, client);
    expect(plan.state.body.invoice.contactPerson).toEqual({ id: 7001, objectName: "SevUser" });
    expect(client.callsTo("/SevUser")).toEqual([]);
  });

  it("update: fills a missing contact person like a create", async () => {
    const stored = loadFixture("drafts/invoice-2102-draft.json").body as {
      objects: Record<string, unknown>[];
    };
    const withoutPerson: FakeRoute = {
      path: "/Invoice/2102",
      response: { body: { objects: [{ ...stored.objects[0], contactPerson: null }] } },
    };
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, withoutPerson));
    const plan = await prepareWrite(invoiceUpdateDraftTool, { id: 2102, header: "X" }, client);
    expect(plan.state.body.invoice.contactPerson).toEqual({ id: 2001, objectName: "SevUser" });
    expect(plan.preview.facts).toContainEqual({
      label: "Contact person",
      value: "(none) → Erika Musterfrau (user 2001)",
    });
  });

  it("update: switches to a requested user", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, twoUsersRoute));
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, contactPersonId: 2002 },
      client,
    );
    expect(plan.state.body.invoice.contactPerson).toEqual({ id: 2002, objectName: "SevUser" });
    expect(plan.preview.action).toMatch(/: change contact person\.$/);
  });
});
