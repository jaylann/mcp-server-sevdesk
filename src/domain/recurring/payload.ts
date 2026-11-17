/**
 * The request that saves a new recurring invoice template: `POST /Invoice/Factory/saveInvoice`
 * with `invoiceType: "WKR"` (spec/deviations.md D-111), parsed with a strict schema right before
 * it is stored in the plan, as every draft body is (`../drafts/payloads.ts`, D-003).
 *
 * What the schema enforces on purpose:
 * - `invoiceType` is always `WKR`, and the status is {@link TEMPLATE_SAVE_STATUS};
 * - the schedule is `accountIntervall` (one of the fixed forms of `schedule.ts`) and
 *   `accountStartDate`, optionally `accountEndDate`, as Unix seconds of 00:00 Berlin time (the
 *   form of the recorded template left to run, D-111). Never `accountNextInvoice`, which sevDesk
 *   ignores when sent alone and sets from the start date itself, and never the `recurring…`
 *   fields of the voucher model, which it drops: the strict schema refuses both;
 * - automatic generation is `propertyAutoGenerateRecurringInvoice: true` or left out (D-132): true
 *   is recorded as stored "1" (on), and a template saved without it reads `null`, which is off.
 *   `false` in a creating save is not recorded, and the string "0" stores "0", whose meaning is
 *   not recorded either, so the schema refuses both;
 * - never `autoSendConfiguration`: this server does not switch on automatic sending by e-mail, and
 *   the strict schema refuses the key;
 * - no id and no number: a save without an id creates a new template, and templates carry none;
 * - every other field is an invoice's (`invoiceContentShape`), so a template carries what an
 *   invoice draft would, and positions go into `invoicePosSave` (D-004).
 */
import { z } from "zod";

import {
  invoiceContentShape,
  oneTaxSetting,
  positionSchema,
  TAX_MESSAGE,
} from "../drafts/payloads.js";
import { TEMPLATE_SAVE_STATUS } from "./run-date.js";
import { INTERVAL_WIRE_FORMS } from "./schedule.js";

const timestamp = z.number().int().nonnegative();

const templateDocumentSchema = z
  .strictObject({
    objectName: z.literal("Invoice"),
    mapAll: z.literal(true),
    invoiceType: z.literal("WKR"),
    status: z.literal(TEMPLATE_SAVE_STATUS),
    ...invoiceContentShape,
    accountIntervall: z.enum(INTERVAL_WIRE_FORMS),
    accountStartDate: timestamp,
    accountEndDate: timestamp.optional(),
    propertyAutoGenerateRecurringInvoice: z.literal(true).optional(),
  })
  .refine(oneTaxSetting, TAX_MESSAGE);

/** `POST /Invoice/Factory/saveInvoice` for a new recurring invoice template. */
export const saveTemplateBodySchema = z.strictObject({
  invoice: templateDocumentSchema,
  invoicePosSave: z.array(positionSchema("InvoicePos")).min(1),
  invoicePosDelete: z.null(),
});

export type SaveTemplateBody = z.output<typeof saveTemplateBodySchema>;
