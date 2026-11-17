import type { AnyToolDefinition } from "../types.js";
import { orderCreateConfirmationTool } from "./create-confirmation.js";
import { orderCreateDeliveryNoteTool } from "./create-delivery-note.js";
import { orderSetOfferStatusTool } from "./offer-status.js";

/**
 * The steps after an offer (#89): accept, reject or reopen it, an order confirmation from it, a
 * delivery note from it or its confirmation.
 */
export const ORDER_FOLLOW_UP_TOOLS: readonly AnyToolDefinition[] = [
  orderSetOfferStatusTool,
  orderCreateConfirmationTool,
  orderCreateDeliveryNoteTool,
];
