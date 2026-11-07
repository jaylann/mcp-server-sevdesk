import type { AnyToolDefinition } from "../types.js";
import { orderGetTool } from "./get.js";
import { ordersListTool } from "./list.js";

/** Tools of the `orders` toolset (Angebote, Auftragsbestätigungen, Lieferscheine). */
export const ORDER_TOOLS: readonly AnyToolDefinition[] = [ordersListTool, orderGetTool];
