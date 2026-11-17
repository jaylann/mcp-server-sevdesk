/**
 * `sevdesk_order_create_delivery_note`: a delivery note (Lieferschein, LI) draft from an offer or
 * order confirmation with `POST /Order/Factory/createPackingListFromOrder` (spec/deviations.md
 * D-107). Write tier: sevDesk leaves the source as it is and the draft can be deleted again;
 * which sources are allowed is `assertDeliveryNoteSource`. Shaped like
 * `sevdesk_invoice_create_from_order`.
 */
import { z } from "zod";

import { idList } from "../../domain/derived-documents.js";
import { documentRef, readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import { documentTitle } from "../../domain/lifecycle/preview.js";
import { assertDeliveryNoteSource, refuse } from "../../domain/lifecycle/transitions.js";
import {
  createOrderFromOrder,
  derivedOrderState,
  findOrdersFrom,
} from "../../domain/order-follow-ups.js";
import { defineWriteTool } from "../define-tool.js";
import { documentContent, documentObject } from "../lifecycle/shared.js";
import { dryRunInputShape } from "../write-input.js";
import {
  allowDuplicateInput,
  derivedOrderData,
  derivedOrderOutput,
  sourceOrderInput,
} from "./follow-up-output.js";

export const orderCreateDeliveryNoteTool = defineWriteTool({
  name: "sevdesk_order_create_delivery_note",
  title: "Create a delivery note from a sevDesk order",
  description:
    "Create a delivery note (Lieferschein, LI) draft from an order confirmation " +
    "(Auftragsbestätigung, AB: draft, sent or accepted) or an offer (Angebot, AN: sent or " +
    "accepted) with its contact, texts and positions. sevDesk leaves the source unchanged. Not " +
    "from offer drafts (send them first), rejected offers or delivery notes. Refuses when a " +
    "delivery note draft from the order exists (allowDuplicate overrides, e.g. a second partial " +
    "delivery); finalized ones from the order are named in the preview. Tier write. sevDesk " +
    "gives it the next LI number without moving its counter; the result names other delivery " +
    "notes with the same number. Then check it with sevdesk_order_get and finalize it with " +
    "sevdesk_order_finalize.",
  toolset: "orders",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    orderId: sourceOrderInput("The offer's or order confirmation's order"),
    allowDuplicate: allowDuplicateInput("a delivery note draft"),
    ...dryRunInputShape,
  }),
  output: derivedOrderOutput,
  // The source: its status and the "no delivery note draft from it yet" check are read, then
  // the delivery note is created. The key is the one the order's other tools take.
  locks: (args) => [documentObject("order", args.orderId)],
  prepare: async (args, ctx) => {
    const doc = await readLifecycleDocument(ctx.client, "order", args.orderId, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    assertDeliveryNoteSource(doc);
    const existing = await findOrdersFrom(ctx.client, doc, "deliveryNote", ctx.signal);
    if (existing.drafts.length > 0 && !args.allowDuplicate) {
      refuse(
        `A delivery note draft from ${documentRef(doc)} exists already: ` +
          `${idList("order", existing.drafts)}. Finish or delete that draft (sevdesk_order_get), ` +
          "or call again with allowDuplicate: true to create another one.",
      );
    }
    // The content lists the order's discounts on the whole document (D-116).
    const content = await documentContent(ctx, doc);
    const warnings = [
      "The delivery note is created as a draft (Entwurf) with the order's contact, texts and " +
        "positions as listed here; sevDesk leaves the order itself unchanged. Check it with " +
        "sevdesk_order_get and finalize it with sevdesk_order_finalize.",
      "sevDesk gives the delivery note the next number of the LI range without moving its " +
        "counter, so another delivery note may carry the same number; the result names any it " +
        "finds.",
    ];
    if (content.discountCount > 0) {
      // Only createInvoiceFromOrder was recorded with a discount (it copies it, D-116).
      warnings.push(
        "The order carries discounts or surcharges on the whole document (listed above). " +
          "Whether sevDesk takes them over to the delivery note has not been checked; check the " +
          "new draft with sevdesk_order_get before finalizing it.",
      );
    }
    if (existing.drafts.length > 0) {
      warnings.push(
        `Creating another one (allowDuplicate): ${idList("delivery note draft", existing.drafts)} ` +
          "from this order exists already.",
      );
    }
    if (existing.others.length > 0) {
      // Not refused: a second delivery note can be a partial delivery. Named so a repeated
      // request does not go unnoticed.
      warnings.push(
        "Created from this order already and no longer a draft: " +
          `${idList("delivery note", existing.others)}. Create another one only for a further ` +
          "(partial) delivery.",
      );
    }
    if (existing.truncated) {
      warnings.push("Not every order could be checked for an earlier delivery note.");
    }
    warnings.push(content.notShown.en, ...content.notes.map((note) => note.en));
    return {
      preview: {
        action:
          `Create a delivery note (Lieferschein, LI) draft from ${documentTitle(doc)}` +
          `${doc.typeLabel === undefined ? "" : ` (${doc.typeLabel})`}.`,
        facts: [
          ...content.identity("en"),
          { label: "Creates", value: "delivery note (Lieferschein, LI) as a draft" },
          ...content.printed("en"),
        ],
        warnings,
        irreversible: false,
      },
      state: derivedOrderState("deliveryNote", doc),
    };
  },
  execute: async (_args, plan, ctx) => {
    const result = await createOrderFromOrder(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    return {
      data: derivedOrderData(result, plan.state.sourceId),
      summary:
        `Created delivery note draft ${String(result.details.order.id)} from order ` +
        `${String(plan.state.sourceId)}; finalize it with sevdesk_order_finalize.`,
      affected: result.affected,
    };
  },
});
