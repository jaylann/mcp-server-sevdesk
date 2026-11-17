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
  })
  .refine(oneTaxSetting, TAX_MESSAGE);

/** `POST /Invoice/Factory/saveInvoice` for a new recurring invoice template. */
export const saveTemplateBodySchema = z.strictObject({
  invoice: templateDocumentSchema,
  invoicePosSave: z.array(positionSchema("InvoicePos")).min(1),
  invoicePosDelete: z.null(),
});

export type SaveTemplateBody = z.output<typeof saveTemplateBodySchema>;

// ---------------------------------------------------------------------------------------------
// Changing a stored template
// ---------------------------------------------------------------------------------------------

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The fields an update may change, each optional: the template's own content fields. */
const changeableShape = z
  .strictObject(invoiceContentShape)
  .pick({
    contact: true,
    contactPerson: true,
    header: true,
    headText: true,
    footText: true,
    timeToPay: true,
    showNet: true,
    taxRule: true,
    taxType: true,
    taxSet: true,
    taxRate: true,
    taxText: true,
    smallSettlement: true,
    address: true,
    addressName: true,
    addressStreet: true,
    addressZip: true,
    addressCity: true,
    addressCountry: true,
  })
  .partial().shape;

/** Tax fields go together: either none, or a full setting with exactly one rule or type. */
function wholeTaxSetting(value: {
  taxRate?: unknown;
  taxRule?: unknown;
  taxType?: unknown;
}): boolean {
  if (value.taxRate === undefined) {
    return value.taxRule === undefined && value.taxType === undefined;
  }
  return oneTaxSetting(value);
}

/**
 * `saveInvoice` with the id of a stored template and ONLY the fields that change. Recorded on
 * 2026-11-17 (spec/deviations.md D-111, D-112): such a minimal body keeps type, status, contact,
 * texts, schedule and positions as stored. So the body never carries `invoiceType` or `status`
 * (it cannot turn an invoice into a template or start or end one), and the strict schema refuses
 * both. Positions are replaced as a whole (every stored row in `invoicePosDelete`, the new ones in
 * `invoicePosSave`), never changed by id: a position sent by its id with only a new price was
 * left unchanged without an error (recorded 2026-11-17). `accountEndDate: null` removes the end
 * date (an empty string is refused with 500).
 */
const templateChangeSchema = z
  .strictObject({
    id,
    objectName: z.literal("Invoice"),
    mapAll: z.literal(true),
    ...changeableShape,
    accountIntervall: z.enum(INTERVAL_WIRE_FORMS).optional(),
    accountStartDate: timestamp.optional(),
    accountEndDate: timestamp.nullable().optional(),
  })
  .refine(wholeTaxSetting, TAX_MESSAGE);

/** `POST /Invoice/Factory/saveInvoice` changing a stored template. */
export const changeTemplateBodySchema = z.strictObject({
  invoice: templateChangeSchema,
  invoicePosSave: z.array(positionSchema("InvoicePos")).min(1).nullable(),
  invoicePosDelete: z
    .array(z.strictObject({ id, objectName: z.literal("InvoicePos") }))
    .min(1)
    .nullable(),
});

export type ChangeTemplateBody = z.output<typeof changeTemplateBodySchema>;

/**
 * The statuses the end and reactivate tools send, as strings: the form recorded for both
 * (`status: "50"` ends a template, `"100"` sets it back, D-112).
 */
const STATUS_WIRE = ["50", String(TEMPLATE_SAVE_STATUS)] as const;

/** `POST /Invoice/Factory/saveInvoice` that only sets a template's status (end or reactivate). */
export const templateStatusBodySchema = z.strictObject({
  invoice: z.strictObject({
    id,
    objectName: z.literal("Invoice"),
    mapAll: z.literal(true),
    status: z.enum(STATUS_WIRE),
  }),
  invoicePosSave: z.null(),
  invoicePosDelete: z.null(),
});

export type TemplateStatusBody = z.output<typeof templateStatusBodySchema>;
