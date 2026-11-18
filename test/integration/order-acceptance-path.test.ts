/**
 * Issue #89's acceptance path through the server's own tools alone: offer → accepted → order
 * confirmation → (finalized) → delivery note → invoice. The account is scripted: a small
 * in-memory sevDesk that answers the requests the tools make the way the recordings of D-107 and
 * D-108 say (a confirmation is a draft AB whose origin is the offer and that accepts the offer; a
 * finalized confirmation reads back with status 500; a delivery note leaves its source alone).
 * Each step runs `prepare` with a read-only client and `execute` with the tool's tier, as after an
 * approval.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { isReadingPost } from "../../src/sevdesk/read-posts.js";
import type {
  CollectedList,
  ListAllOptions,
  ListOptions,
  Page,
  QueryValue,
  SevdeskClient,
  SevdeskRequest,
} from "../../src/sevdesk/types.js";
import { invoiceFromOrderTool } from "../../src/tools/invoices/from-order.js";
import { finalizeTool } from "../../src/tools/lifecycle/finalize.js";
import { orderCreateConfirmationTool } from "../../src/tools/orders/create-confirmation.js";
import { orderCreateDeliveryNoteTool } from "../../src/tools/orders/create-delivery-note.js";
import { orderSetOfferStatusTool } from "../../src/tools/orders/offer-status.js";
import { withCountryRoute } from "../helpers/country-route.js";
import { FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import { layoutObjects, type Row } from "../unit/tools/lifecycle/helpers.js";
import { derivedRow, sentOffer } from "../write-cases/orders.js";

const ORDER_PATH = /^\/Order\/(\d+)$/;
const RELATED_PATH = /^\/Order\/(\d+)\/getRelatedObjects$/;
const DISCOUNTS_PATH = /^\/(Order|Invoice)\/(\d+)\/getDiscounts$/;
const SEND_BY_PATH = /^\/Order\/(\d+)\/sendBy$/;
const INVOICE_PATH = /^\/Invoice\/(\d+)$/;

function firstRow(fixture: string): Row {
  const objects = (loadFixture(fixture).body as { objects: unknown }).objects;
  return structuredClone(Array.isArray(objects) ? (objects[0] as Row) : (objects as Row));
}

/** The recorded order positions, as positions of `orderId`. */
function orderPositions(orderId: string): Row[] {
  const body = loadFixture("orders/order-positions-3002.json").body as { objects: Row[] };
  return body.objects.map((row) => ({ ...row, order: { id: orderId, objectName: "Order" } }));
}

/** A scripted sevDesk account with orders and invoices (see the module comment). */
class ScriptedAccount implements SevdeskClient {
  readonly orders = new Map<string, Row>();
  readonly invoices = new Map<string, Row>();
  readonly writes: { method: string; path: string; body?: unknown }[] = [];
  private nextOrder = 3101;
  private nextNumber: Record<string, number> = { AB: 1003, LI: 1001 };
  /** Reference data and everything else that does not change. */
  private readonly fixed = new FakeSevdeskClient(
    withCountryRoute([
      { path: "/Unity", response: { fixture: "meta/units.json" } },
      { path: "/InvoicePos", response: { body: { objects: [] } } },
    ]),
  );

  constructor(offer: Row) {
    this.orders.set(String(offer["id"]), structuredClone(offer));
  }

  request(request: SevdeskRequest): Promise<unknown> {
    return Promise.resolve().then(() => this.answer(request));
  }

  private order(id: string): Row {
    const row = this.orders.get(id);
    if (row === undefined) throw new SevdeskError({ kind: "not_found", message: "no order" });
    return row;
  }

  private derive(sourceId: string, type: "AB" | "LI"): Row {
    const id = String(this.nextOrder++);
    const counter = this.nextNumber[type] ?? 1;
    // The factory does not move the counter (D-107); the tool reserves the number afterwards.
    const row = derivedRow(id, type, `${type}-${String(counter)}`, sourceId);
    this.orders.set(id, row);
    return row;
  }

  /** `getNextOrderNumber`: the counter's number; `useNextNumber=true` also advances it (D-066). */
  private nextOrderNumber(request: SevdeskRequest): string {
    const type = String(request.query?.["orderType"]);
    const counter = this.nextNumber[type] ?? 1;
    if (request.query?.["useNextNumber"] === "true") {
      this.writes.push({ method: request.method, path: `${request.path}?orderType=${type}` });
      this.nextNumber[type] = counter + 1;
    }
    return `${type}-${String(counter)}`;
  }

  private answer(request: SevdeskRequest): unknown {
    const { method, path } = request;
    // The layout read of a draft's finalize approval (render without reload, D-113) is no write.
    if (isReadingPost(request)) return layoutObjects({}, "order");
    if (method !== "GET") this.writes.push({ method, path, body: request.body });
    if (method === "GET" && path === "/Order/Factory/getNextOrderNumber") {
      return this.nextOrderNumber(request);
    }
    if (method === "GET") {
      const order = ORDER_PATH.exec(path)?.[1];
      if (order !== undefined) return [this.order(order)];
      if (RELATED_PATH.test(path)) return [];
      const invoice = INVOICE_PATH.exec(path)?.[1];
      if (invoice !== undefined) return [this.invoices.get(invoice)];
      return this.fixed.request(request);
    }
    const put = ORDER_PATH.exec(path)?.[1];
    if (method === "PUT" && put !== undefined) {
      const { status } = request.body as { status: number };
      const row = { ...this.order(put), status: String(status) };
      this.orders.set(put, row);
      return row;
    }
    const sent = SEND_BY_PATH.exec(path)?.[1];
    if (method === "PUT" && sent !== undefined) {
      const row = this.order(sent);
      // A confirmation marked as sent reads back with status 500 (D-107).
      const status = row["orderType"] === "AB" ? "500" : "200";
      this.orders.set(sent, { ...row, status });
      return this.orders.get(sent);
    }
    if (method === "POST" && path === "/Order/Factory/createContractNoteFromOrder") {
      const source = String(request.query?.["order[id]"]);
      // The offer becomes accepted (D-107).
      this.orders.set(source, { ...this.order(source), status: "500" });
      return this.derive(source, "AB");
    }
    if (method === "POST" && path === "/Order/Factory/createPackingListFromOrder") {
      return this.derive(String(request.query?.["order[id]"]), "LI");
    }
    if (method === "POST" && path === "/Invoice/Factory/createInvoiceFromOrder") {
      const { order } = request.body as { order: { id: number } };
      const invoice: Row = {
        ...firstRow("masterdata/invoice-1101.json"),
        origin: { id: String(order.id), objectName: "Order" },
      };
      this.invoices.set(String(invoice["id"]), invoice);
      return invoice;
    }
    throw new Error(`ScriptedAccount: no answer for ${method} ${path}`);
  }

  list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options: ListOptions = {},
  ): Promise<Page> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const items = this.rows(path, query ?? {});
    if (items === undefined) return this.fixed.list(path, query, options);
    return Promise.resolve({
      items: items.slice(offset, offset + limit),
      total: items.length,
    });
  }

  listAll(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: ListAllOptions,
  ): Promise<CollectedList> {
    const items = this.rows(path, query ?? {});
    if (items === undefined) return this.fixed.listAll(path, query, options);
    return Promise.resolve({ items, total: items.length, truncated: false, paged: false });
  }

  download(): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    return Promise.reject(new Error("no downloads"));
  }

  /** The rows of a list this account answers itself, or `undefined` for the fixed ones. */
  private rows(path: string, query: Readonly<Record<string, QueryValue>>): unknown[] | undefined {
    if (path === "/OrderPos") return orderPositions(String(query["order[id]"]));
    // No discounts on the whole document (D-116).
    if (DISCOUNTS_PATH.test(path)) return [];
    if (path !== "/Order") return undefined;
    // Filters sevDesk applies; the tools check every row themselves anyway.
    return [...this.orders.values()].filter(
      (row) =>
        (query["orderType"] === undefined || row["orderType"] === query["orderType"]) &&
        (query["orderNumber"] === undefined || row["orderNumber"] === query["orderNumber"]),
    );
  }
}

describe("issue #89: offer → accepted → confirmation → delivery note → invoice", () => {
  it("runs through the server's tools alone", async () => {
    const account = new ScriptedAccount(sentOffer);

    // 1. The customer accepted the sent offer.
    const accepted = await executeWrite(
      orderSetOfferStatusTool,
      { id: 3001, action: "accept" },
      account,
    );
    expect(accepted.output.data).toMatchObject({ order: { id: 3001, status: { code: 500 } } });

    // 2. An order confirmation from the accepted offer; the offer stays accepted.
    const confirmed = await executeWrite(orderCreateConfirmationTool, { orderId: 3001 }, account);
    expect(confirmed.plan.preview.warnings[0]).toBe(
      "The offer is accepted already (status 500) and stays so.",
    );
    const confirmation = confirmed.output.data.order;
    expect(confirmation).toMatchObject({
      type: { code: "AB" },
      status: { code: 100 },
      origin: { objectName: "Order", id: 3001 },
    });
    expect(confirmed.output.data.positions).toHaveLength(2);
    expect(confirmed.output.data.sourceOrderStatus).toMatchObject({ code: 500 });

    // 3. The confirmation is finalized (sent); sevDesk shows it as 500.
    const finalized = await executeWrite(finalizeTool("order"), { id: confirmation.id }, account);
    expect(finalized.output.data).toMatchObject({ order: { status: { code: 500 } } });

    // 4. A delivery note from the confirmation, which stays as it is.
    const delivered = await executeWrite(
      orderCreateDeliveryNoteTool,
      { orderId: confirmation.id },
      account,
    );
    expect(delivered.output.data.order).toMatchObject({
      type: { code: "LI" },
      status: { code: 100 },
      origin: { id: confirmation.id },
    });
    expect(delivered.output.affected).toEqual([
      { objectName: "Order", id: String(delivered.output.data.order.id) },
    ]);

    // 5. The invoice from the confirmation.
    const invoiced = await executeWrite(
      invoiceFromOrderTool,
      { orderId: confirmation.id },
      account,
    );
    expect(invoiced.output.data.invoice).toMatchObject({
      status: { code: 100 },
      origin: { objectName: "Order", id: confirmation.id },
    });

    expect(account.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /Order/3001",
      "POST /Order/Factory/createContractNoteFromOrder",
      // Each factory's counter is moved past the new number once (#134).
      "GET /Order/Factory/getNextOrderNumber?orderType=AB",
      `PUT /Order/${String(confirmation.id)}/sendBy`,
      "POST /Order/Factory/createPackingListFromOrder",
      "GET /Order/Factory/getNextOrderNumber?orderType=LI",
      "POST /Invoice/Factory/createInvoiceFromOrder",
    ]);
    expect(confirmation.number).toBe("AB-1003");
    expect(delivered.output.data.order.number).toBe("LI-1001");
    expect(account.writes[0]?.body).toEqual({ status: 500 });
    expect(account.orders.get("3001")?.["status"]).toBe("500");
  });
});
