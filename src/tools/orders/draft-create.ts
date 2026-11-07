import { z } from "zod";

import {
  executeOrderDraft,
  orderCreateInputShape,
  prepareOrderCreate,
} from "../../domain/drafts/order.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { orderDraftOutput, orderDraftToolOutput } from "./draft-output.js";

/** `sevdesk_order_create_draft`: a new draft offer, order confirmation or delivery note. */
export const orderCreateDraftTool = defineWriteTool({
  name: "sevdesk_order_create_draft",
  title: "Create a draft order",
  description:
    "Create a draft offer (Angebot, AN), order confirmation (Auftragsbestätigung, AB) or " +
    "delivery note (Lieferschein, LI) for a contact with its positions (Positionen; offers may " +
    "have optional positions). Tier write: it only creates a draft; nothing is sent to the " +
    "customer. No number is sent: sevDesk assigns it from its number range. Defaults: today's " +
    "date, net prices, tax rule 1 (Umsatzsteuerpflichtige Umsätze, rates 0/7/19 %), EUR, the " +
    "contact's invoice address, the account's only user as contact person (several users: pass " +
    "contactPersonId). Every tax rate is checked against the tax rule before anything is sent; " +
    "the preview warns about a possible duplicate. dryRun previews without saving. Before: " +
    "sevdesk_contacts_search. After: sevdesk_order_update_draft, sevdesk_order_pdf, " +
    "sevdesk_order_finalize, sevdesk_order_to_invoice.",
  toolset: "orders",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({ ...orderCreateInputShape, ...dryRunInputShape }),
  output: orderDraftOutput,
  prepare: (args, ctx) => prepareOrderCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) =>
    orderDraftToolOutput(await executeOrderDraft(ctx.client, plan.state, ctx.signal), "Created"),
});
