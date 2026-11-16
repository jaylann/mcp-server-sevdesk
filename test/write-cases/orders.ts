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
      ...positionRoutes(),
    ],
    writes: [{ method: "POST", path: "/Order/Factory/createPackingListFromOrder" }],
  },
];
