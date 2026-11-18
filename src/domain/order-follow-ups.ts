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
 *   not move (D-027): two made in a row carry the same number.
 * - `createContractNoteFromOrder` sets the source offer to accepted (500), from sent, draft and
 *   rejected offers alike; `createPackingListFromOrder` leaves the source alone.
 *
 * So after the request the new order is read back and the counter of its range is moved past its
 * number (#134), the way `sevdesk_credit_note_create_from_invoice` moves the credit note counter:
 * when the peek (`useNextNumber=false`) still offers the new number, it is reserved once
 * (`useNextNumber=true`, a write-tier side-effect GET). The reservation advances the AB and LI
 * counters by one, as it does the AN and credit note counters (D-066, recorded for AB and LI on
 * 2026-11-18, probe `write-reserved-number-ab-li`). Every real create advances the counter, also
 * for a draft that is deleted later. Deleting the draft saved with the number reserved last gives
 * that number back (D-066); for a factory draft, numbered before its reservation, that is not
 * recorded, so deleting one may leave a gap in the range.
 * The tools hold the range's account-wide lock (`ACCOUNT_ORDER_NUMBERS`) from `prepare` to the
 * end, so two of this server's calls cannot take the same number between the request and the
 * reservation.
 * Other orders of the type with the same number are still looked up and named in a trusted note:
 * the counter can lag behind numbers in use (documents the factories made before #134 share their
 * numbers), and the web app or another client may move it at any time.
 *
 * Neither request is retried. Before writing, orders already made from the same source are
 * looked up (`GET /Order` by contact and type, `origin` checked on every row since sevDesk ignores
 * filters it does not know, D-035), so a repeated call does not create a second document.
 *
 * Once the request went through, the new order exists (and a confirmation's offer is accepted):
 * every later failure carries them as completed writes, so the error never reads as if nothing
 * happened. A counter step or number check that fails becomes a trusted note instead (only a
 * cancel or an unexpected error ends the call).
 */
import { z } from "zod";

import type { SevdeskObjectRef } from "../safety/write-types.js";
import { SevdeskError, withCompletedWrites } from "../sevdesk/errors.js";
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
import { type NumberRange, peekNextNumber, reserveNextNumber } from "./drafts/numbering.js";
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

/** Orders that match, and whether the scan stopped at its cap. */
interface OrderScan {
  readonly rows: readonly OrderScanRow[];
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
  const rows = list.items
    .map((raw) => parseUpstream(orderRowSchema, raw, "orders"))
    .filter(matches);
  return { rows, truncated: list.truncated };
}

/** Distinct ids, ascending. */
function idsOf(rows: readonly OrderScanRow[]): number[] {
  return [...new Set(rows.map((row) => row.id))].sort((a, b) => a - b);
}

function typeOf(row: OrderScanRow): string | undefined {
  return row.orderType?.trim().toUpperCase();
}

/** Orders of a factory's type made from one source, see {@link findOrdersFrom}. */
export interface OrdersFrom {
  /** Every such order, whatever its status. */
  readonly ids: readonly number[];
  /** Those of them that are drafts (100). */
  readonly drafts: readonly number[];
  /** Those of them that are not drafts (finalized, sent, …). */
  readonly others: readonly number[];
  /** The scan stopped at its cap: there may be more. */
  readonly truncated: boolean;
}

/**
 * Orders of the factory's type already made from `source` (their `origin` is the source), split
 * into drafts and the rest. Lists `GET /Order` by the source's contact (without a contact filter
 * when the source has none) and the type; reads only.
 */
export async function findOrdersFrom(
  client: SevdeskClient,
  source: LifecycleDocument<"order">,
  factory: OrderFactory,
  signal?: AbortSignal,
): Promise<OrdersFrom> {
  const { type } = ORDER_FACTORIES[factory];
  const contactId = source.contact?.id;
  const scan = await scanOrders(
    client,
    {
      ...(contactId === undefined
        ? {}
        : { "contact[id]": contactId, "contact[objectName]": "Contact" }),
      orderType: type,
    },
    (row) =>
      row.origin?.objectName === "Order" && row.origin.id === source.id && typeOf(row) === type,
    signal,
  );
  return {
    ids: idsOf(scan.rows),
    drafts: idsOf(scan.rows.filter((row) => row.status === STATUS.draft)),
    others: idsOf(scan.rows.filter((row) => row.status !== STATUS.draft)),
    truncated: scan.truncated,
  };
}

/** What {@link createOrderFromOrder} returns. */
export interface DerivedOrderResult {
  readonly details: OrderDetails;
  readonly affected: SevdeskObjectRef[];
  /** The source read again after the request; `undefined` when that read failed. */
  readonly source: LifecycleDocument<"order"> | undefined;
  /** Trusted notes: what happened to the number counter, other orders with the same number. */
  readonly notes: string[];
}

/**
 * Sends the factory request (never retried) with the source in the query and the body, reads the
 * new order back and checks that it is a draft of the expected type that points to the source,
 * then reads the source again: it is listed in `affected` when sevDesk changed it (a confirmation
 * accepts the offer) or when it could not be read. Last, the counter of the new order's range is
 * moved past its number ({@link advanceOrderCounter}) and other orders of the type with the same
 * number are looked up ({@link sameNumberNotes}), both for the notes. The caller holds the range's
 * lock (`ACCOUNT_ORDER_NUMBERS`).
 *
 * A failure after the request names what exists by then: the new order once its id is known, and
 * for a confirmation the offer, which sevDesk accepted in the same request.
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
  // What the request changed besides the new order: a confirmation accepts its offer (D-107).
  const sourceChanged = state.factory === "confirmation" ? [sourceRef] : [];
  let newId: number;
  try {
    newId = createdDocumentId(answer, "order", `the created ${info.noun}`);
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, sourceChanged);
    throw error;
  }
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
  const details = await readBack(
    () => getOrder(client, newId, { signal, cacheOwner }),
    [...created, ...sourceChanged],
  );
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
  const notes = await numberNotes(client, info, newId, order.number, affected, signal);
  return { details, affected, source: after, notes };
}

/**
 * Trusted notes about the new order's number (D-107, #134): what moving the counter did, then
 * other orders of the type that carry the same number. Neither step fails the call (the order
 * exists); only a cancel or an unexpected error ends it, with `affected` as completed writes.
 *
 * The notes point at the number (`order.number` of the output) instead of quoting it: the number
 * range's format is set in the web app, so the number is text this server did not write (#147).
 * The same goes for a number the counter hands out to a reservation.
 */
async function numberNotes(
  client: SevdeskClient,
  info: FactoryInfo,
  newId: number,
  number: string | undefined,
  affected: readonly SevdeskObjectRef[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (number === undefined) {
    return [
      `sevDesk gave the new ${info.noun} no number, so its ${info.type} number counter was not ` +
        "touched; set a number before sending it.",
    ];
  }
  const target = { info, number, affected, signal };
  return [
    ...(await advanceOrderCounter(client, target)),
    ...(await sameNumberNotes(client, target, newId)),
  ];
}

/** The new order's number and what a failure after the request has to name. */
interface NumberTarget {
  readonly info: FactoryInfo;
  /** The number sevDesk gave the new order, as read back; compared, never quoted in a note. */
  readonly number: string;
  readonly affected: readonly SevdeskObjectRef[];
  readonly signal: AbortSignal | undefined;
}

/** The output field the notes point at for the new order's number (#147). */
const NUMBER_FIELD = "order.number";

/** "the new order confirmation's number (order.number)": how a note names the new number. */
function newNumber(info: FactoryInfo): string {
  return `the new ${info.noun}'s number (${NUMBER_FIELD})`;
}

function sameNumber(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Moves the counter of the new order's range past its number (#134), like
 * `advanceCreditNoteCounter` in `derived-documents.ts`: when the counter still offers that number
 * (peek), it is reserved once (`useNextNumber=true`) so the next document of the range cannot get
 * it. A counter that offers another number was moved on by someone else (the web app or another
 * client: this server's calls on the range hold its lock) and is left alone. One trusted note
 * says what happened; a failure becomes a note too, except a cancel.
 */
async function advanceOrderCounter(client: SevdeskClient, target: NumberTarget): Promise<string[]> {
  const { info, number, affected, signal } = target;
  const range: NumberRange = { kind: "order", orderType: info.type };
  const counter = `sevDesk's ${info.type} number counter`;
  try {
    if (!sameNumber(await peekNextNumber(client, range, signal), number)) {
      return [
        `${counter} does not offer ${newNumber(info)} any more: someone moved it on after ` +
          "sevDesk handed out that number, so it was left as it is.",
      ];
    }
    const reserved = await reserveNextNumber(client, range, signal);
    if (!sameNumber(reserved, number)) {
      // The counter moved between the peek and the reservation (another client): the reserved
      // number is lost, and whoever moved it may carry the new order's number as well.
      return [
        `${counter} moved on while it was being moved past ${newNumber(info)}: the reservation ` +
          "took another number instead, which is now skipped (a gap in the number range, " +
          "Nummernkreis).",
      ];
    }
    // A reservation moves the AB and LI counters by one (D-066, recorded 2026-11-18).
    return [
      `The new ${info.noun}'s number (${NUMBER_FIELD}) was reserved on ${counter}, which moves ` +
        `the counter past it so that the next ${info.noun} does not get it again.`,
    ];
  } catch (error) {
    if (!(error instanceof SevdeskError)) {
      throw new SevdeskError({
        kind: "unexpected_response",
        message:
          `The ${info.noun} was created, but moving sevDesk's number counter past its number ` +
          "failed unexpectedly.",
        cause: error,
        completedWrites: affected,
      });
    }
    if (error.kind === "aborted") throw withCompletedWrites(error, affected);
    return [
      `${counter} could not be checked or moved past ${newNumber(info)}, so the next ` +
        `${info.noun} may get the same number; check the number before sending either.`,
    ];
  }
}

/**
 * Trusted notes about other orders of the type that carry the new order's number: the safety net
 * behind {@link advanceOrderCounter}, since the counter can lag behind numbers in use (the
 * factories made documents with shared numbers before #134) or be moved by someone else. Nothing
 * when none does; a note when the lookup failed or was cut, since the number then cannot be called
 * unique.
 */
async function sameNumberNotes(
  client: SevdeskClient,
  target: NumberTarget,
  newId: number,
): Promise<string[]> {
  const { info, number, affected, signal } = target;
  const label = `the same number (${NUMBER_FIELD})`;
  let others: OrderScan;
  try {
    others = await scanOrders(
      client,
      { orderNumber: number, orderType: info.type },
      (row) =>
        row.id !== newId &&
        typeOf(row) === info.type &&
        row.orderNumber !== undefined &&
        sameNumber(row.orderNumber, number),
      signal,
    );
  } catch (error) {
    if (!(error instanceof SevdeskError)) {
      throw new SevdeskError({
        kind: "unexpected_response",
        message:
          `The ${info.noun} was created, but checking its number against other orders failed ` +
          "unexpectedly.",
        cause: error,
        completedWrites: affected,
      });
    }
    if (error.kind === "aborted") throw withCompletedWrites(error, affected);
    return [
      `Whether another ${info.noun} carries ${label} already could not be checked; look it up ` +
        "with sevdesk_orders_list.",
    ];
  }
  const sameIds = idsOf(others.rows);
  if (sameIds.length > 0) {
    return [
      `The new ${info.noun} has ${label} as ${idList("order", sameIds)}: ` +
        `sevDesk handed out a number of its ${info.type} range that is in use already. Give one ` +
        "of them another number in the sevDesk web app before sending either.",
    ];
  }
  return others.truncated
    ? [
        `Not every ${info.noun} could be checked for the same number; look it up with ` +
          "sevdesk_orders_list.",
      ]
    : [];
}
