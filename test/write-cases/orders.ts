import { orderCreateConfirmationTool } from "../../src/tools/orders/create-confirmation.js";
import { orderCreateDeliveryNoteTool } from "../../src/tools/orders/create-delivery-note.js";
import { orderSetOfferStatusTool } from "../../src/tools/orders/offer-status.js";
import { type FakeRoute, loadFixture } from "../helpers/fake-client.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  documentRoute,
  orderRow,
  positionRoutes,
  type Row,
} from "../unit/tools/lifecycle/helpers.js";

/** Offer 3001 (keys of the recorded order 3002): AN-1001, sent (200). */
export const sentOffer = orderRow({
  id: "3001",
  orderType: "AN",
  status: "200",
  orderNumber: "AN-1001",
  header: "Angebot AN-1001",
  origin: null,
});

/** A new order made from `source` by a factory: a draft of `type` with the next number. */
export function derivedRow(id: string, type: "AB" | "LI", number: string, source: string): Row {
  return orderRow({
    id,
    orderType: type,
    status: "100",
    orderNumber: number,
    header: `${type === "AB" ? "Auftragsbestätigung" : "Lieferschein"} ${number}`,
    origin: { id: source, objectName: "Order" },
    sendDate: null,
    sendType: null,
  });
}

/** What reading a new order back (`getOrder`) and the order scans need besides the record. */
export function derivedReadRoutes(row: Row): FakeRoute[] {
  return [
    documentRoute("order", row),
    {
      path: `/Order/${String(row["id"])}/getRelatedObjects`,
      response: { body: { objects: [] } },
    },
    { path: "/Unity", response: { fixture: "meta/units.json" } },
    // Orders made from the source and orders with the same number: none.
    { path: "/Order", response: { body: { objects: [] } } },
  ];
}

/**
 * `GET /Order/{orderId}/getDiscounts` answering `rows` with `total: null`, as recorded for an
 * order without discounts (D-116); none by default.
 */
export function discountsOf(orderId: string, rows: readonly Row[] = []): FakeRoute {
  return {
    path: `/Order/${orderId}/getDiscounts`,
    response: { body: { objects: rows, total: null } },
  };
}

/** A stored discount row of order `orderId` as D-116 recorded it (every scalar a string). */
export function discountRow(orderId: string, overrides: Row = {}): Row {
  return {
    id: "8001",
    objectName: "Discounts",
    object: { id: orderId, objectName: "Order" },
    discount: "1",
    text: "Treuerabatt",
    percentage: "1",
    value: "5",
    isNet: "1",
    ...overrides,
  };
}

/** The recorded positions of order 3002, as positions of `orderId`. */
export function positionsOf(orderId: string): FakeRoute {
  const body = loadFixture("orders/order-positions-3002.json").body as { objects: Row[] };
  return {
    path: "/OrderPos",
    query: { "order[id]": orderId },
    response: {
      body: {
        objects: body.objects.map((row) => ({
          ...row,
          order: { id: orderId, objectName: "Order" },
        })),
      },
    },
  };
}

const confirmation = derivedRow("3101", "AB", "AB-1003", "3001");
const deliveryNote = derivedRow("3201", "LI", "LI-1001", "3002");
/** Offer 3003, accepted (500), with a discount and a surcharge on the whole document. */
const discountedOffer = { ...sentOffer, id: "3003", status: "500", orderNumber: "AN-1003" };
const discountedConfirmation = derivedRow("3102", "AB", "AB-1004", "3003");

/** Write-tool cases of the order follow-ups (#89): offer status, confirmation, delivery note. */
export const ORDERS_CASES: readonly WriteToolCase[] = [
  {
    label: "accept a sent offer",
    tool: orderSetOfferStatusTool,
    args: { id: 3001, action: "accept" },
    routes: [
      documentRoute("order", sentOffer),
      {
        method: "PUT",
        path: "/Order/3001",
        response: { body: { objects: { ...sentOffer, status: "500" } } },
      },
      ...positionRoutes(),
    ],
    writes: [{ method: "PUT", path: "/Order/3001" }],
  },
  {
    label: "create an order confirmation from a sent offer",
    tool: orderCreateConfirmationTool,
    args: { orderId: 3001 },
    routes: [
      documentRoute("order", sentOffer),
      {
        method: "POST",
        path: "/Order/Factory/createContractNoteFromOrder",
        response: { body: { objects: confirmation } },
      },
      ...derivedReadRoutes(confirmation),
      positionsOf("3001"),
      discountsOf("3001"),
      ...positionRoutes(),
    ],
    writes: [{ method: "POST", path: "/Order/Factory/createContractNoteFromOrder" }],
  },
  {
    label: "create a delivery note from an order confirmation",
    tool: orderCreateDeliveryNoteTool,
    args: { orderId: 3002 },
    routes: [
      documentRoute("order", orderRow()),
      {
        method: "POST",
        path: "/Order/Factory/createPackingListFromOrder",
        response: { body: { objects: deliveryNote } },
      },
      ...derivedReadRoutes(deliveryNote),
      discountsOf("3002"),
      ...positionRoutes(),
    ],
    writes: [{ method: "POST", path: "/Order/Factory/createPackingListFromOrder" }],
  },
  {
    label: "create an order confirmation from an accepted offer with a document discount",
    tool: orderCreateConfirmationTool,
    args: { orderId: 3003 },
    routes: [
      documentRoute("order", discountedOffer),
      {
        method: "POST",
        path: "/Order/Factory/createContractNoteFromOrder",
        response: { body: { objects: discountedConfirmation } },
      },
      ...derivedReadRoutes(discountedConfirmation),
      positionsOf("3003"),
      discountsOf("3003", [
        discountRow("3003"),
        discountRow("3003", {
          id: "8002",
          discount: "0",
          text: "Expresszuschlag",
          percentage: "0",
          value: "12.5",
          isNet: "0",
        }),
      ]),
      ...positionRoutes(),
    ],
    writes: [{ method: "POST", path: "/Order/Factory/createContractNoteFromOrder" }],
  },
];
