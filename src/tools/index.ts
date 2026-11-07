import { BANKING_TOOLS } from "./banking/index.js";
import { CONTACT_TOOLS } from "./contacts/index.js";
import { CREDIT_NOTE_TOOLS } from "./credit-notes/index.js";
import { DOCUMENT_FILE_TOOLS } from "./documents/index.js";
import { INVOICE_TOOLS } from "./invoices/index.js";
import { META_TOOLS } from "./meta/index.js";
import { ORDER_TOOLS } from "./orders/index.js";
import { PART_TOOLS } from "./parts/index.js";
import { REPORT_TOOLS } from "./reports/index.js";
import type { AnyToolDefinition } from "./types.js";
import { VOUCHER_TOOLS } from "./vouchers/index.js";

/**
 * Every tool this server ships, across all toolsets and tiers. `selectTools` (registry.ts) picks
 * what a given configuration exposes. Add a toolset's list here when it lands.
 *
 * Invariant: tool names are unique (checked at module load).
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = assertUniqueNames([
  ...META_TOOLS,
  ...CONTACT_TOOLS,
  ...INVOICE_TOOLS,
  ...CREDIT_NOTE_TOOLS,
  ...ORDER_TOOLS,
  ...VOUCHER_TOOLS,
  ...BANKING_TOOLS,
  ...PART_TOOLS,
  ...DOCUMENT_FILE_TOOLS,
  ...REPORT_TOOLS,
]);

/** Throws when two tools share a name; returns the list unchanged otherwise. */
export function assertUniqueNames(
  tools: readonly AnyToolDefinition[],
): readonly AnyToolDefinition[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.add(tool.name);
    }
    seen.add(tool.name);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate tool names: ${[...duplicates].sort().join(", ")}`);
  }
  return tools;
}
