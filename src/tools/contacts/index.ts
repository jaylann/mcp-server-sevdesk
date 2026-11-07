import type { AnyToolDefinition } from "../types.js";
import { contactGetTool } from "./get.js";
import { nextCustomerNumberTool } from "./next-customer-number.js";
import { contactsSearchTool } from "./search.js";
import { CONTACT_WRITE_TOOLS } from "./write-tools.js";

/** Tools of the `contacts` toolset (Kontakte: customers, suppliers, partners). */
export const CONTACT_TOOLS: readonly AnyToolDefinition[] = [
  contactsSearchTool,
  contactGetTool,
  nextCustomerNumberTool,
  ...CONTACT_WRITE_TOOLS,
];
