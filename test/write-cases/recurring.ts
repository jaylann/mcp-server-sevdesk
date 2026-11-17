import { todayInBerlin } from "../../src/domain/drafts/fields.js";
import { addMonths } from "../../src/domain/recurring/schedule.js";
import { invoiceCreateRecurringTool } from "../../src/tools/invoices/recurring-create.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  recurringCreateArgs,
  recurringCreateRoutes,
} from "../unit/tools/invoices/recurring-routes.js";

/** The 1st of the month after today (Berlin): always a start date the tool accepts. */
function firstOfNextMonth(): string {
  return `${addMonths(todayInBerlin(), 1).slice(0, 8)}01`;
}

/** Write-tool cases of recurring invoice templates (see test/helpers/write-cases.ts). */
export const RECURRING_CASES: readonly WriteToolCase[] = [
  {
    label: "create a recurring invoice template",
    tool: invoiceCreateRecurringTool,
    args: {
      ...recurringCreateArgs,
      // Read when a test parses the arguments, not when this module loads: the tool refuses a
      // start in the past, and the German preview test fixes the clock (2026-11-09 → 2026-12-01),
      // so its snapshot stays the same while the other tests run on the real date.
      get startDate(): string {
        return firstOfNextMonth();
      },
    },
    routes: recurringCreateRoutes,
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
];
