import { z } from "zod";

import {
  executeOrderDraft,
  orderUpdateInputShape,
  prepareOrderUpdate,
} from "../../domain/drafts/order.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { orderDraftOutput, orderDraftToolOutput } from "./draft-output.js";

/** `sevdesk_order_update_draft`: change a draft order; given positions replace all. */
export const orderUpdateDraftTool = defineWriteTool({
  name: "sevdesk_order_update_draft",
  title: "Update a draft order",
  description:
    "Change a draft offer (Angebot), order confirmation (Auftragsbestätigung) or delivery note " +
    "(Lieferschein). Tier write. Only the fields you give change; everything else keeps its " +
    "stored value, the type stays. positions, when given, replace ALL stored positions in one " +
    "request (saveOrder with the order's id); leave them out to keep them. Changing priceMode " +
    "needs the positions too, and a new tax rule must allow every stored rate. A new contactId " +
    "also takes that contact's invoice address unless you give an address. Only drafts can be " +
    "changed; for a sent offer create a new draft. dryRun shows the changes without saving. " +
    "Before: sevdesk_order_get. After: sevdesk_order_pdf, sevdesk_order_finalize.",
  toolset: "orders",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ ...orderUpdateInputShape, ...dryRunInputShape }),
  output: orderDraftOutput,
  prepare: (args, ctx) => prepareOrderUpdate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) =>
    orderDraftToolOutput(await executeOrderDraft(ctx.client, plan.state, ctx.signal), "Updated"),
});
