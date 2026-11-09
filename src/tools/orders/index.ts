import type { AnyToolDefinition } from "../types.js";
import { ORDER_DRAFT_TOOLS } from "./draft-tools.js";
import { orderGetTool } from "./get.js";
import { ORDER_LIFECYCLE_TOOLS } from "./lifecycle-tools.js";
import { ordersListTool } from "./list.js";

/** Tools of the `orders` toolset (Angebote, Auftragsbestätigungen, Lieferscheine). */
export const ORDER_TOOLS: readonly AnyToolDefinition[] = [
  ordersListTool,
  orderGetTool,
  ...ORDER_DRAFT_TOOLS,
  ...ORDER_LIFECYCLE_TOOLS,
];
