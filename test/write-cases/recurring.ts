import { invoiceCreateRecurringTool } from "../../src/tools/invoices/recurring-create.js";
import {
  invoiceEndRecurringTool,
  invoiceReactivateRecurringTool,
} from "../../src/tools/invoices/recurring-status.js";
import { invoiceUpdateRecurringTool } from "../../src/tools/invoices/recurring-update.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  endedTemplateRoutes,
  firstOfNextMonth,
  templateChangeRoutes,
} from "../unit/tools/invoices/recurring-manage-routes.js";
import {
  recurringCreateArgs,
  recurringCreateRoutes,
} from "../unit/tools/invoices/recurring-routes.js";

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
  {
    label: "change a recurring invoice template",
    tool: invoiceUpdateRecurringTool,
    args: {
      id: 2301,
      interval: "quarterly",
      footText: "Zahlbar ohne Abzug.",
      positions: [{ name: "Wartung", quantity: 1, unitPrice: "80.00", taxRate: 19 }],
    },
    routes: templateChangeRoutes(),
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "end a recurring invoice template",
    tool: invoiceEndRecurringTool,
    args: { id: 2301 },
    routes: templateChangeRoutes(),
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "reactivate a recurring invoice template",
    tool: invoiceReactivateRecurringTool,
    args: { id: 2301 },
    // Its next run is the 1st of next month whenever the routes are read (see the helper).
    routes: endedTemplateRoutes(),
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
];
