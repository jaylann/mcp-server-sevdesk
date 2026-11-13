import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import {
  documentListData,
  documentListSummary,
  localFilterOutputShape,
} from "../../domain/document-positions.js";
import {
  listDetailInputShape,
  orderSummary,
  orderSummarySchema,
} from "../../domain/list-summary.js";
import {
  listOrders,
  ORDER_STATUS_FILTERS,
  ORDER_TYPE_FILTERS,
  orderRowSchema,
  type OrderStatusFilter,
  type OrderTypeFilter,
} from "../../domain/orders.js";
import { pageOutputShape, pagingInputShape } from "../../domain/paging.js";
import { defineTool } from "../define-tool.js";

const STATUS_KEYS = Object.keys(ORDER_STATUS_FILTERS) as [
  OrderStatusFilter,
  ...OrderStatusFilter[],
];
const TYPE_KEYS = Object.keys(ORDER_TYPE_FILTERS) as [OrderTypeFilter, ...OrderTypeFilter[]];

const output = z.object({
  items: z.array(z.union([orderRowSchema, orderSummarySchema])),
  ...pageOutputShape,
  ...localFilterOutputShape,
});

/** `sevdesk_orders_list`: find offers, order confirmations and delivery notes. */
export const ordersListTool = defineTool({
  name: "sevdesk_orders_list",
  title: "List sevDesk orders",
  description:
    "List orders in sevDesk: offers (Angebote, AN), order confirmations " +
    "(Auftragsbestätigungen, AB) and delivery notes (Lieferscheine, LI), with compact rows: " +
    "number, type, status, contact, date, net/tax/gross. Filter by type, status (draft = " +
    "Entwurf, sent = versendet, rejected = abgelehnt, accepted = angenommen, " +
    "partially_invoiced, invoiced = berechnet), contactId, exact order number and date range. " +
    "Type and number are also checked here (up to 1,000 rows scanned per call; total left " +
    "out, filteredLocally set). Page with offset = nextOffset while hasMore. " +
    "Use detail=summary to browse/find; sevdesk_order_get or detail=full for details.",
  toolset: "orders",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...listDetailInputShape,
    type: z
      .enum(TYPE_KEYS)
      .optional()
      .describe("offer (AN), order_confirmation (AB) or delivery_note (LI)."),
    status: z
      .enum(STATUS_KEYS)
      .optional()
      .describe(
        "draft 100, sent 200, rejected 300, accepted 500, partially_invoiced 750, invoiced 1000.",
      ),
    contactId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Only orders of this contact."),
    number: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Exact order number, e.g. 'AN-1000'."),
    ...dateRangeInputShape,
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listOrders(ctx.client, args, ctx.signal);
    return {
      data: {
        ...documentListData(result, args),
        items: args.detail === "summary" ? result.items.map(orderSummary) : [...result.items],
      },
      summary: documentListSummary("Orders", "matching orders", result, args),
    };
  },
});
