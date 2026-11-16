import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { INVOICE_LIFECYCLE_TOOLS } from "../../src/tools/invoices/lifecycle-tools.js";
import { type AnyWriteToolDefinition, isWriteTool } from "../../src/tools/types.js";
import { voucherUpdateDraftTool } from "../../src/tools/vouchers/draft-update.js";
import { voucherFinalizeTool } from "../../src/tools/vouchers/finalize.js";
import { costCentresRoute, RECORDED_CENTRES, storedCostCentre } from "../helpers/cost-centres.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import { invoiceCreateArgs, invoiceCreateRoutes } from "../unit/tools/drafts/routes.js";
import {
  documentRoute,
  invoiceRow,
  positionRoutes,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";
import {
  CREATE_READ_ROUTES,
  draftRow,
  positionRow,
  positionsRoute,
  saveRoute,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

const finalizeInvoice = ((): AnyWriteToolDefinition => {
  const found = INVOICE_LIFECYCLE_TOOLS.find((tool) => tool.name === "sevdesk_invoice_finalize");
  if (found === undefined || !isWriteTool(found)) throw new Error("no sevdesk_invoice_finalize");
  return found;
})();

const centre = storedCostCentre(RECORDED_CENTRES.third.id);

/** A draft voucher 2101 on cost centre MCP1 and what an update or finalize reads besides it. */
const voucherOnCentre = [
  costCentresRoute,
  voucherRoute(draftRow({ costCentre: centre })),
  positionsRoute(2101, [positionRow()]),
  ...CREATE_READ_ROUTES,
  saveRoute(),
];

/**
 * Write-tool cases of the cost-centre work (#87, see test/helpers/write-cases.ts): drafts that
 * set one, and the finalize approvals that show a stored one (their German text is in the
 * `write-previews-de` snapshot).
 */
export const COST_CENTRES_CASES: readonly WriteToolCase[] = [
  {
    label: "create a draft invoice on a cost centre",
    tool: invoiceCreateDraftTool,
    args: { ...invoiceCreateArgs, date: "2026-11-07", costCentre: "MCP1" },
    routes: [costCentresRoute, ...invoiceCreateRoutes],
    writes: [{ method: "POST", path: "/Invoice/Factory/saveInvoice" }],
  },
  {
    label: "move a draft voucher to another cost centre",
    tool: voucherUpdateDraftTool,
    args: { id: 2101, costCentre: RECORDED_CENTRES.first.id },
    routes: voucherOnCentre,
    writes: [{ method: "POST", path: "/Voucher/Factory/saveVoucher" }],
  },
  {
    label: "finalize a draft invoice on a cost centre",
    tool: finalizeInvoice,
    args: { id: 1001 },
    routes: [
      costCentresRoute,
      documentRoute(
        "invoice",
        invoiceRow({
          status: "100",
          invoiceNumber: null,
          sendDate: null,
          sendType: null,
          costCentre: centre,
        }),
      ),
      writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ...positionRoutes(),
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/sendBy" }],
  },
  {
    label: "finalize a draft voucher on a cost centre",
    tool: voucherFinalizeTool,
    args: { id: 2101 },
    routes: voucherOnCentre,
    writes: [{ method: "POST", path: "/Voucher/Factory/saveVoucher" }],
  },
];
