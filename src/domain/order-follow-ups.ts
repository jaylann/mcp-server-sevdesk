/**
 * Orders made from other orders (spec/deviations.md D-107): an order confirmation
 * (Auftragsbestätigung, AB) from an offer with `POST /Order/Factory/createContractNoteFromOrder`,
 * and a delivery note (Lieferschein, LI) from an offer or confirmation with
 * `POST /Order/Factory/createPackingListFromOrder`. Behind `sevdesk_order_create_confirmation`
 * and `sevdesk_order_create_delivery_note`; which sources each allows is decided in
 * `lifecycle/transitions.ts` (`assertConfirmable`, `assertDeliveryNoteSource`).
 *
 * Recorded behaviour (2026-11-16, Update 2.0):
 * - Both take the source in the query (`order[id]`, `order[objectName]`) and in the body
 *   (`{id, objectName}`), and answer the new order itself under `objects`: a draft (100) with
 *   `origin` = the source, the source's contact, texts, all positions and the same `sumNet`.
 * - The new order gets the number `getNextOrderNumber` peeks for its type, and the counter does
 *   not move (D-027): two made in a row carry the same number. So the new order is read back, and
 *   other orders of its type with the same number are looked up and named in a trusted note.
 * - `createContractNoteFromOrder` sets the source offer to accepted (500), from sent, draft and
 *   rejected offers alike; `createPackingListFromOrder` leaves the source alone.
 *
 * Neither request is retried. Before writing, orders already made from the same source are
 * looked up (`GET /Order` by contact and type, `origin` checked on every row since sevDesk ignores
 * filters it does not know, D-035), so a repeated call does not create a second document.
 */
import { z } from "zod";

import type { SevdeskObjectRef } from "../safety/write-types.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId, zIntish, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import type { CountryReadOptions } from "./country-codes.js";
import {
  createdDocumentId,
  idList,
  readBack,
  readQuietly,
  typeProblem,
  verifyDraft,
} from "./derived-documents.js";
import { quotableNumber } from "./drafts/numbering.js";
import { type LifecycleDocument, readLifecycleDocument, STATUS } from "./lifecycle/documents.js";
import { getOrder, type OrderDetails } from "./orders.js";

/** The two order factories. */
export type OrderFactory = "confirmation" | "deliveryNote";

interface FactoryInfo {
  readonly endpoint: "createContractNoteFromOrder" | "createPackingListFromOrder";
  /** The `orderType` of the new order. */
  readonly type: "AB" | "LI";
  /** English noun: "order confirmation", "delivery note". */
  readonly noun: string;
}

const ORDER_FACTORIES: Readonly<Record<OrderFactory, FactoryInfo>> = {
  confirmation: {
    endpoint: "createContractNoteFromOrder",
    type: "AB",
    noun: "order confirmation",
  },
  deliveryNote: {
    endpoint: "createPackingListFromOrder",
    type: "LI",
    noun: "delivery note",
  },
};

/** Rows read when looking for orders made from the same source or with the same number. */
const SCAN_MAX = 5000;
const SCAN_PAGE_SIZE = 1000;

const sourceRefSchema = z.strictObject({
  id: z.number().int().positive(),
  objectName: z.literal("Order"),
});

/** What `execute` needs from `prepare`. */
export interface DerivedOrderState {
  readonly factory: OrderFactory;
  readonly sourceId: number;
  /** The source as `prepare` saw it, to tell whether sevDesk changed it. */
  readonly sourceFingerprint: string;
}

/** The state of a planned factory call on `source` (checked by the caller). */
export function derivedOrderState(
  factory: OrderFactory,
  source: LifecycleDocument<"order">,
): DerivedOrderState {
  return { factory, sourceId: source.id, sourceFingerprint: orderFingerprint(source) };
}

/** Status and exact last update of an order: what changes when sevDesk touches it. */
function orderFingerprint(doc: LifecycleDocument<"order">): string {
  const { update } = parseUpstream(
    z.object({ update: z.unknown().optional() }),
    doc.raw ?? {},
    "an order",
  );
  return JSON.stringify([doc.status, update ?? null]);
}

const orderRowSchema = z.object({
  id: zId,
  orderNumber: zText,
  orderType: zText,
  status: zIntish.optional(),
  origin: zOptionalRef,
});

type OrderScanRow = z.output<typeof orderRowSchema>;

/** Ids of orders that match, and whether the scan stopped at its cap. */
export interface OrderScan {
  readonly ids: readonly number[];
  readonly truncated: boolean;
}

async function scanOrders(
  client: SevdeskClient,
  query: Readonly<Record<string, QueryValue>>,
  matches: (row: OrderScanRow) => boolean,
  signal: AbortSignal | undefined,
): Promise<OrderScan> {
  const list = await client.listAll("/Order", query, {
    max: SCAN_MAX,
    pageSize: SCAN_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const ids = list.items
    .map((raw) => parseUpstream(orderRowSchema, raw, "orders"))
    .filter(matches)
    .map((row) => row.id);
  return { ids: [...new Set(ids)].sort((a, b) => a - b), truncated: list.truncated };
}

function typeOf(row: OrderScanRow): string | undefined {
  return row.orderType?.trim().toUpperCase();
}

/**
 * Orders of the factory's type already made from `source` (their `origin` is the source), drafts
 * only with `draftsOnly`. Lists `GET /Order` by the source's contact and the type; reads only.
 */
export function findOrdersFrom(
  client: SevdeskClient,
  source: LifecycleDocument<"order">,
  factory: OrderFactory,
  draftsOnly: boolean,
  signal?: AbortSignal,
): Promise<OrderScan> {
  const { type } = ORDER_FACTORIES[factory];
  const contactId = source.contact?.id;
  return scanOrders(
    client,
    {
      ...(contactId === undefined
        ? {}
        : { "contact[id]": contactId, "contact[objectName]": "Contact" }),
      orderType: type,
    },
    (row) =>
      row.origin?.objectName === "Order" &&
      row.origin.id === source.id &&
      typeOf(row) === type &&
      (!draftsOnly || row.status === STATUS.draft),
    signal,
  );
}

/** What {@link createOrderFromOrder} returns. */
export interface DerivedOrderResult {
  readonly details: OrderDetails;
  readonly affected: SevdeskObjectRef[];
  /** The source read again after the request; `undefined` when that read failed. */
  readonly source: LifecycleDocument<"order"> | undefined;
  /** Trusted notes, e.g. about other orders with the same number. */
  readonly notes: string[];
}

/**
 * Sends the factory request (never retried) with the source in the query and the body, reads the
 * new order back and checks that it is a draft of the expected type that points to the source,
 * then reads the source again: it is listed in `affected` when sevDesk changed it (a confirmation
 * accepts the offer) or when it could not be read. Last, other orders of the new type with the
 * same number are looked up for the notes.
 */
export async function createOrderFromOrder(
  client: SevdeskClient,
  state: DerivedOrderState,
  options: CountryReadOptions,
): Promise<DerivedOrderResult> {
  const { signal, cacheOwner } = options;
  const info = ORDER_FACTORIES[state.factory];
  const sourceId = toSevdeskId(state.sourceId);
  const source = sourceRefSchema.parse({ id: sourceId, objectName: "Order" });
  const answer = await client.request({
    method: "POST",
    path: `/Order/Factory/${info.endpoint}`,
    query: { "order[id]": sourceId, "order[objectName]": "Order" },
    body: source,
    ...(signal === undefined ? {} : { signal }),
  });
  const sourceRef: SevdeskObjectRef = { objectName: "Order", id: String(sourceId) };
  const newId = createdDocumentId(answer, "order", `the created ${info.noun}`);
  if (newId === sourceId) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted the request, but its answer named order ${String(sourceId)} itself ` +
        `instead of a new ${info.noun}. Do not repeat the call: look for the new ${info.noun} ` +
        "with sevdesk_orders_list and check the order with sevdesk_order_get.",
      completedWrites: [sourceRef],
    });
  }
  const created: SevdeskObjectRef[] = [{ objectName: "Order", id: String(newId) }];
  const details = await readBack(() => getOrder(client, newId, { signal, cacheOwner }), created);
  const after = await readQuietly(() =>
    readLifecycleDocument(client, "order", sourceId, { signal, cacheOwner }),
  );
  const affected = [
    ...created,
    ...(after === undefined || orderFingerprint(after) !== state.sourceFingerprint
      ? [sourceRef]
      : []),
  ];
  const { order } = details;
  verifyDraft(
    { what: info.noun, id: newId, tool: "sevdesk_order_get" },
    order.status.code,
    [
      ...typeProblem(order.type.code, [info.type]),
      ...(order.origin?.objectName === "Order" && order.origin.id === sourceId
        ? []
        : ["it does not point to the order it was created from"]),
    ],
    affected,
  );
  const notes = await sameNumberNotes(client, info, newId, order.number, signal);
  return { details, affected, source: after, notes };
}

/**
 * Trusted notes about the new order's number (D-107): sevDesk handed it out without moving the
 * counter, so other orders of the type may carry it already, and the next one may get it again.
 * A failed or cut lookup becomes a note too; it never fails the call (the order exists).
 */
async function sameNumberNotes(
  client: SevdeskClient,
  info: FactoryInfo,
  newId: number,
  number: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (number === undefined) {
    return [`sevDesk gave the new ${info.noun} no number; set one before sending it.`];
  }
  const label = quotableNumber(number) ?? "the new number";
  const counter =
    `sevDesk does not move its ${info.type} number counter for this request, so the next ` +
    `${info.noun} may get ${label} again; check the number before sending either.`;
  const same = (value: string | undefined): boolean =>
    value?.trim().toLowerCase() === number.trim().toLowerCase();
  let others: OrderScan;
  try {
    others = await scanOrders(
      client,
      { orderNumber: number, orderType: info.type },
      (row) => row.id !== newId && typeOf(row) === info.type && same(row.orderNumber),
      signal,
    );
  } catch (error) {
    if (!(error instanceof SevdeskError) || error.kind === "aborted") throw error;
    return [
      counter,
      `Whether another ${info.noun} carries ${label} already could not be checked; look it up ` +
        "with sevdesk_orders_list.",
    ];
  }
  if (others.ids.length > 0) {
    return [
      `The new ${info.noun} has the same number (${label}) as ${idList("order", others.ids)}: ` +
        "sevDesk hands out the next number of the range without moving its counter. Give one of " +
        "them another number in the sevDesk web app before sending it.",
      counter,
    ];
  }
  return others.truncated
    ? [
        counter,
        `Not every ${info.noun} could be checked for the same number; look it up with ` +
          "sevdesk_orders_list.",
      ]
    : [counter];
}
