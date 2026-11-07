/**
 * Order drafts (status 100): offers (Angebote, AN), order confirmations (Auftragsbestätigungen,
 * AB) and delivery notes (Lieferscheine, LI) through `POST /Order/Factory/saveOrder`.
 *
 * Create body: the shape of two working production bodies (codestra/sevdesk-mcp and a product
 * configurator, 2026-08), checked against `Model_Order`: `version: 0`, `addressCountry`, the
 * multi-line `address` (`takeDefaultAddress` leaves an order's recipient block empty, codestra),
 * `taxRate: 0`, `orderPosSave` with `objectName`, `mapAll` and `positionNumber`. Unlike those
 * bodies no `orderNumber` is sent (B4, lead decision): whether sevDesk then assigns one is
 * unrecorded (codestra reports a 400), which the recording session checks.
 *
 * Update: `saveOrder` with `order.id`, not `PUT /Order/{orderId}`. Evidence and trade-off:
 * `PUT /Order/{id}` (`Model_OrderUpdate`) changes the order's own fields only (codestra uses it
 * that way, live), and positions would then need `PUT`/`DELETE /OrderPos/{id}` plus an
 * undocumented `POST /OrderPos`: several requests that can fail half-way, and codestra reports
 * that `PUT /OrderPos` silently ignores a lone `price`. `saveOrder` takes `orderPosSave` and
 * `orderPosDelete`, which only make sense for an existing order, as the same factory family
 * documents for invoices ("this request can also be used to update", `saveInvoice`) and credit
 * notes (`saveCreditNote`). One request replaces everything atomically. If sevDesk saved a new
 * order instead (different id), the call fails with that order named, so nothing is hidden.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { statusDto } from "../common.js";
import {
  getOrder,
  ORDER_TYPE_FILTERS,
  type OrderDetails,
  type OrderTypeFilter,
} from "../orders.js";
import { documentTypeByCode } from "../reference-data.js";
import { berlinDay, loadCurrentOrder } from "./current.js";
import {
  assertChanges,
  ChangeLog,
  draftPreview,
  numberLabel,
  positionCount,
  ref,
  storedNumber,
  storedRef,
  storedTotalText,
  taxText,
} from "./document.js";
import { duplicateWarning, findDuplicates } from "./duplicates.js";
import {
  contactIdInput,
  contactPersonIdInput,
  currencyInput,
  documentDateInput,
  footTextInput,
  headerInput,
  headTextInput,
  priceModeInput,
  taxRuleInput,
  taxTextInput,
  todayInBerlin,
  wireDocumentDate,
} from "./fields.js";
import {
  savedDocumentId,
  type SaveOrderBody,
  saveOrderBodySchema,
  strictBody,
} from "./payloads.js";
import {
  type Amounts,
  expectedTotals,
  MAX_POSITIONS,
  orderPositionInput,
  type PositionInput,
  positionPayload,
} from "./positions.js";
import {
  addressText,
  customerText,
  type DraftPreview,
  fact,
  moneyText,
  positionFacts,
  type PreviewFact,
  totalsText,
} from "./preview.js";
import { readBack, readBackNotes } from "./read-back.js";
import { addressInputShape } from "./recipient.js";
import {
  addressBlock,
  type CreateArgs,
  resolveCreateBasics,
  resolveUpdateBasics,
  type UpdateArgs,
} from "./shared.js";
import { DEFAULT_TAX_RULE_ID, type RuleScope, SALES_TAX_RULE_IDS } from "./tax.js";

const ORDER_SCOPE: RuleScope = { allowedRuleIds: SALES_TAX_RULE_IDS, documents: "orders" };
const FINALIZE_TOOL = "sevdesk_order_finalize";
const ORDER_TYPE_NAMES = Object.keys(ORDER_TYPE_FILTERS) as [OrderTypeFilter, ...OrderTypeFilter[]];
type OrderTypeCode = (typeof ORDER_TYPE_FILTERS)[OrderTypeFilter];

const termsText = (what: string) =>
  z.string().max(5_000).optional().describe(`${what} as printed on the document.`);

const positionsInput = z
  .array(orderPositionInput)
  .min(1)
  .max(MAX_POSITIONS)
  .describe("Positionen in printed order; prices per priceMode.");

/** Input fields of `sevdesk_order_create_draft` (without `dryRun`). */
export const orderCreateInputShape = {
  contactId: contactIdInput,
  orderType: z
    .enum(ORDER_TYPE_NAMES)
    .describe(
      "offer (Angebot, AN), order_confirmation (Auftragsbestätigung, AB) or delivery_note " +
        "(Lieferschein, LI).",
    ),
  positions: positionsInput,
  date: documentDateInput.describe("Angebots-/Auftragsdatum, YYYY-MM-DD; default today (Berlin)."),
  priceMode: priceModeInput,
  taxRule: taxRuleInput,
  taxText: taxTextInput,
  currency: currencyInput,
  header: headerInput.describe(
    'Document title (Betreff); default "Angebot", "Auftragsbestätigung" or "Lieferschein".',
  ),
  headText: headTextInput,
  footText: footTextInput,
  paymentTerms: termsText("Zahlungsbedingungen"),
  deliveryTerms: termsText("Lieferbedingungen"),
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
};

/** Input fields of `sevdesk_order_update_draft` (without `dryRun`). */
export const orderUpdateInputShape = {
  id: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Id of the draft order (not its number), e.g. from sevdesk_orders_list."),
  positions: positionsInput
    .optional()
    .describe("When given, replaces ALL positions; leave out to keep them."),
  contactId: contactIdInput.optional(),
  date: documentDateInput.describe("Angebots-/Auftragsdatum, YYYY-MM-DD."),
  priceMode: priceModeInput.describe(
    "Net or gross unit prices (showNet). Changing it requires positions too.",
  ),
  taxRule: taxRuleInput.describe(
    "New tax rule (Steuerregel) id; see sevdesk_reference_lookup kind=tax_rules.",
  ),
  taxText: taxTextInput,
  currency: currencyInput,
  header: headerInput,
  headText: headTextInput,
  footText: footTextInput,
  paymentTerms: termsText("Zahlungsbedingungen"),
  deliveryTerms: termsText("Lieferbedingungen"),
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
};

export interface OrderCreateArgs extends CreateArgs {
  readonly orderType: OrderTypeFilter;
  readonly positions: readonly PositionInput[];
  readonly date?: string | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
  readonly paymentTerms?: string | undefined;
  readonly deliveryTerms?: string | undefined;
}

export interface OrderUpdateArgs extends UpdateArgs {
  readonly id: number;
  readonly date?: string | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
  readonly paymentTerms?: string | undefined;
  readonly deliveryTerms?: string | undefined;
}

export interface OrderDraftState {
  readonly body: SaveOrderBody;
  readonly orderId?: number | undefined;
  readonly expected?: Amounts | undefined;
}

export interface OrderDraftPlan {
  readonly preview: DraftPreview;
  readonly state: OrderDraftState;
}

/** Prepares a new draft order (offer, order confirmation or delivery note). */
export async function prepareOrderCreate(
  client: SevdeskClient,
  args: OrderCreateArgs,
  signal?: AbortSignal,
): Promise<OrderDraftPlan> {
  const code = ORDER_TYPE_FILTERS[args.orderType];
  const typeName = orderTypeLabel(code);
  const date = args.date ?? todayInBerlin();
  const basics = await resolveCreateBasics(
    client,
    args,
    { scope: ORDER_SCOPE, defaultRuleId: DEFAULT_TAX_RULE_ID },
    signal,
  );
  const { contact, contactPerson, address, currency, expected, mode } = basics;
  const duplicateQuery = { contactId: args.contactId, date, gross: expected.gross, currency };
  const duplicates = await findDuplicates(
    client,
    { kind: "order", orderType: args.orderType },
    duplicateQuery,
    signal,
  );

  const header = args.header ?? typeName;
  const body = strictBody(
    saveOrderBodySchema,
    {
      order: {
        objectName: "Order",
        mapAll: true,
        orderType: code,
        version: 0,
        status: 100,
        contact: ref(args.contactId, "Contact"),
        contactPerson: ref(contactPerson.id, "SevUser"),
        orderDate: wireDocumentDate(date),
        header,
        headText: args.headText,
        footText: args.footText,
        currency,
        showNet: mode === "net",
        ...basics.tax,
        address: addressBlock(address),
        addressCountry: ref(address.countryId, "StaticCountry"),
        deliveryTerms: args.deliveryTerms,
        paymentTerms: args.paymentTerms,
      },
      orderPosSave: basics.positions.map((position, index) =>
        positionPayload(position, index, "OrderPos"),
      ),
      orderPosDelete: null,
    },
    "order",
  );

  const facts: PreviewFact[] = [
    fact("Type", `${typeName} (${code})`),
    fact("Customer", customerText(contact.contact.displayName, args.contactId)),
    fact("Address", addressText(address)),
    fact("Date", date),
    fact("Contact person", `${contactPerson.name} (user ${contactPerson.id})`),
    fact("Title", header),
    ...(args.paymentTerms === undefined ? [] : [fact("Payment terms", args.paymentTerms)]),
    ...(args.deliveryTerms === undefined ? [] : [fact("Delivery terms", args.deliveryTerms)]),
    fact("Prices entered as", mode),
    fact("Tax", taxText(basics.rule, basics.tax)),
    fact("Tax text", basics.tax.taxText),
    ...positionFacts(basics.positions, mode, currency),
    fact("Total (expected)", totalsText(expected, currency)),
  ];
  const preview = draftPreview(
    `Create a draft ${typeName} (${code}) for ` +
      `${customerText(contact.contact.displayName, args.contactId)} with ` +
      `${positionCount(basics.positions.length)}, gross ${moneyText(expected.gross, currency)}.`,
    facts,
    [duplicateWarning("order", duplicates, duplicateQuery), ...basics.warnings],
  );
  return { preview, state: { body, expected } };
}

/** Prepares an update of a draft order. */
export async function prepareOrderUpdate(
  client: SevdeskClient,
  args: OrderUpdateArgs,
  signal?: AbortSignal,
): Promise<OrderDraftPlan> {
  assertChanges(args, "order");
  const current = await loadCurrentOrder(client, args.id, signal);
  const doc = current.document;
  const code = checkUpdatable(doc);
  const basics = await resolveUpdateBasics(
    client,
    doc,
    {
      base:
        doc.address === undefined
          ? { kind: "none" }
          : { kind: "text", countryId: doc.addressCountry?.id },
      lines: [doc.address],
      countryId: doc.addressCountry?.id,
    },
    current.positions,
    args,
    { scope: ORDER_SCOPE },
    signal,
  );
  const storedDate = berlinDay(doc.orderDate);
  const date = args.date ?? storedDate ?? todayInBerlin();
  const expected =
    basics.positions === undefined ? undefined : expectedTotals(basics.positions, basics.mode);
  const header = args.header ?? doc.header ?? orderTypeLabel(code);

  const body = strictBody(
    saveOrderBodySchema,
    {
      order: {
        id: doc.id,
        objectName: "Order",
        mapAll: true,
        orderNumber: storedNumber(doc.orderNumber),
        orderType: code,
        version: doc.version ?? 0,
        status: 100,
        contact: ref(basics.contact.contact.id, "Contact"),
        contactPerson: ref(basics.contactPerson.id, "SevUser"),
        orderDate: wireDocumentDate(date),
        header,
        headText: args.headText ?? doc.headText,
        footText: args.footText ?? doc.footText,
        currency: basics.currency,
        showNet: basics.mode === "net",
        ...basics.tax,
        ...(basics.address === undefined
          ? { address: doc.address, addressCountry: storedRef(doc.addressCountry, "StaticCountry") }
          : {
              address: addressBlock(basics.address),
              addressCountry: ref(basics.address.countryId, "StaticCountry"),
            }),
        deliveryTerms: args.deliveryTerms ?? doc.deliveryTerms,
        paymentTerms: args.paymentTerms ?? doc.paymentTerms,
        customerInternalNote: doc.customerInternalNote,
        origin:
          doc.origin === undefined
            ? undefined
            : { id: doc.origin.id, objectName: doc.origin.objectName },
      },
      orderPosSave:
        basics.positions === undefined
          ? null
          : basics.positions.map((position, index) => positionPayload(position, index, "OrderPos")),
      orderPosDelete:
        basics.positions === undefined || current.positions.length === 0
          ? null
          : current.positions.map((row) => ref(row.id, "OrderPos")),
    },
    "order",
  );

  const log = new ChangeLog();
  if (basics.contactChanged) {
    log.value(
      "contact",
      "Customer",
      `contact ${doc.contact?.id ?? "none"}`,
      `contact ${basics.contact.contact.id}`,
    );
  }
  if (basics.address !== undefined) {
    log.value("address", "Address", basics.addressBefore, addressText(basics.address));
  }
  log.value("date", "Date", storedDate, date);
  if (basics.contactPersonChanged) {
    log.value(
      "contact person",
      "Contact person",
      doc.contactPerson === undefined ? undefined : `user ${doc.contactPerson.id}`,
      `${basics.contactPerson.name ?? "user"} (user ${basics.contactPerson.id})`,
    );
  }
  if (args.header !== undefined) log.value("title", "Title", doc.header, args.header);
  if (args.headText !== undefined) log.note("intro text", "Intro text", "replaced");
  if (args.footText !== undefined) log.note("closing text", "Closing text", "replaced");
  if (args.paymentTerms !== undefined)
    log.value("payment terms", "Payment terms", doc.paymentTerms, args.paymentTerms);
  if (args.deliveryTerms !== undefined)
    log.value("delivery terms", "Delivery terms", doc.deliveryTerms, args.deliveryTerms);
  if (basics.modeChanged) {
    log.value(
      "price mode",
      "Prices entered as",
      basics.mode === "net" ? "gross" : "net",
      basics.mode,
    );
  }
  if (basics.taxChanged)
    log.note(
      "tax",
      "Tax",
      `${taxText(basics.rule, basics.tax)}; text: ${basics.tax.taxText ?? "(none)"}`,
    );
  if (basics.currencyChanged) log.value("currency", "Currency", doc.currency, basics.currency);
  if (basics.positions !== undefined) {
    log.note(
      "positions",
      "Positions",
      `replace ${positionCount(current.positions.length)} with ${positionCount(basics.positions.length)}`,
    );
  }

  const typeName = orderTypeLabel(code);
  const customer = customerText(basics.contact.contact.displayName, basics.contact.contact.id);
  const facts: PreviewFact[] = [
    fact("Order", `${doc.id} (${typeName}, ${numberLabel(doc.orderNumber)}, draft)`),
    fact("Customer", customer),
    ...log.facts,
    ...(basics.positions === undefined
      ? []
      : positionFacts(basics.positions, basics.mode, basics.currency)),
    expected === undefined
      ? fact("Total (unchanged)", storedTotalText(doc))
      : fact("Total (expected)", totalsText(expected, basics.currency)),
  ];
  const preview = draftPreview(
    `Update draft ${typeName} ${doc.id} for ${customer}: change ${log.changed.join(", ") || "nothing visible"}.`,
    facts,
    basics.warnings,
  );
  return { preview, state: { body, orderId: doc.id, expected } };
}

export interface OrderDraftResult {
  readonly id: number;
  readonly details: OrderDetails;
  readonly notes: readonly string[];
}

/** Sends the prepared body (one request, never retried) and reads the order back. */
export async function executeOrderDraft(
  client: SevdeskClient,
  state: OrderDraftState,
  signal?: AbortSignal,
): Promise<OrderDraftResult> {
  const response = await client.request({
    method: "POST",
    path: "/Order/Factory/saveOrder",
    body: state.body,
    ...(signal === undefined ? {} : { signal }),
  });
  const id = savedDocumentId(response, "order", "order");
  const saved = { objectName: "Order", id: String(id) };
  if (state.orderId !== undefined && id !== state.orderId) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk saved order ${id} instead of updating order ${state.orderId}. Check both ` +
        "drafts in sevDesk and delete the extra one there before repeating the call.",
      completedWrites: [saved],
    });
  }
  const details = await readBack(saved, () => getOrder(client, id, signal));
  const notes = readBackNotes(
    {
      number: details.order.number,
      gross: details.order.totals.gross?.amount,
      currency: details.order.currency,
      positionsComplete: details.positionsComplete,
    },
    { noun: "order", finalizeTool: FINALIZE_TOOL, expected: state.expected },
  );
  return { id, details, notes };
}

/** German name of an order type, e.g. "Angebot". */
function orderTypeLabel(code: OrderTypeCode): string {
  return documentTypeByCode("order", code)?.labelDe ?? code;
}

/** Only draft orders of a known type can be updated; returns the type code. */
function checkUpdatable(doc: {
  readonly id: number;
  readonly status: number;
  readonly orderType?: string | undefined;
}): OrderTypeCode {
  if (doc.status !== 100) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Order ${doc.id} is not a draft (status: ${statusDto("order", doc.status).label}); only ` +
        "drafts can be changed. Create a new draft (sevdesk_order_create_draft) instead.",
    });
  }
  const code = Object.values(ORDER_TYPE_FILTERS).find(
    (value) => value === doc.orderType?.trim().toUpperCase(),
  );
  if (code === undefined) {
    throw new SevdeskError({
      kind: "validation",
      message: `Order ${doc.id} has an order type this tool does not know; edit it in sevDesk.`,
    });
  }
  return code;
}
