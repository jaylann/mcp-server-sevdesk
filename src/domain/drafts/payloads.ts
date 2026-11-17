/**
 * Strict schemas of the request bodies the draft tools send, and the reading of the save
 * responses. sevDesk ignores unknown request fields silently (spec/deviations.md D-003), so every
 * body is parsed with one of these strict schemas right before it is stored in the plan: a typo in
 * a field name fails the call instead of losing data. Key order follows the schema (zod builds the
 * output in shape order), so the body is deterministic.
 *
 * What the schemas enforce on purpose:
 * - positions go into `invoicePosSave` / `creditNotePosSave` / `orderPosSave` (the spec's
 *   `required` lists name `invoicePos` etc., which do not exist: D-004); stored positions to
 *   delete go into `*PosDelete` as a list of refs, never as the spec's single object (D-054,
 *   D-110);
 * - no derived totals (`sum*`, `priceNet`, `priceGross`, `priceTax`) anywhere (B8);
 * - document numbers only from sevDesk (B4): invoices none on create (`sendBy` assigns it);
 *   orders and credit notes the number reserved from the number range (`numbering.ts`); on
 *   update only the stored one, unchanged;
 * - drafts only (`status: 100`), references as `{id, objectName}`, `mapAll: true` on the document
 *   and every position (spec: "you always need to provide them");
 * - a document discount only in the recorded form (D-116): `discountSave` as a list of one
 *   deduction followed by `discountDelete`, both after the position keys, or neither key.
 *
 * Shapes follow sevdesk-rs's invoice and credit note requests (rebuilt from its source; the
 * responses, recorded on Update 2.0 on 2026-10-01, show them accepted) and, for orders, the
 * working bodies of codestra/sevdesk-mcp and a production
 * configurator (2026-08), checked against `Model_Invoice`, `Model_creditNote`, `Model_Order`.
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { zId } from "../../sevdesk/schema.js";
import { LEGACY_TAX_TYPES } from "./tax.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function ref<N extends string>(objectName: N) {
  return z.strictObject({ id, objectName: z.literal(objectName) });
}

const germanDate = z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/);
const timestamp = z.number().int().nonnegative();
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

function positionSchema<N extends "InvoicePos" | "CreditNotePos" | "OrderPos">(objectName: N) {
  return z.strictObject({
    objectName: z.literal(objectName),
    mapAll: z.literal(true),
    quantity: z.number().positive(),
    price: decimalString,
    name: z.string().min(1),
    unity: ref("Unity"),
    taxRate: z.number().min(0),
    positionNumber: z.number().int().min(0),
    text: z.string().optional(),
    part: ref("Part").optional(),
    discount: z.number().positive().max(100).optional(),
    ...(objectName === "OrderPos" ? { optional: z.literal(true).optional() } : {}),
  });
}

function deleteSchema<N extends string>(objectName: N) {
  return z.array(ref(objectName)).min(1).nullable();
}

/**
 * The document discount keys (D-116, `discount.ts`), sent after the position keys or not at all:
 * `discountSave` a list of exactly one deduction (or `null` when the update removes the stored
 * one), `discountDelete` the stored rows as a list of refs (or `null` when there are none).
 */
const discountShape = {
  discountSave: z
    .array(
      z.strictObject({
        objectName: z.literal("Discounts"),
        mapAll: z.literal(true),
        discount: z.literal(true),
        text: z.string().min(1),
        percentage: z.boolean(),
        value: z.number().positive(),
      }),
    )
    .length(1)
    .nullable()
    .optional(),
  discountDelete: deleteSchema("Discounts").optional(),
};

/**
 * Both discount keys or neither; a percentage of at most 100; a removal (`discountSave: null`)
 * deletes something; a new document deletes nothing.
 */
function discountKeysFit(body: {
  readonly discountSave?:
    readonly { readonly percentage: boolean; readonly value: number }[] | null | undefined;
  readonly discountDelete?: readonly unknown[] | null | undefined;
  readonly isNew: boolean;
}): boolean {
  const { discountSave: save, discountDelete: deleted } = body;
  if (save === undefined || deleted === undefined) return save === deleted;
  if (save === null) return deleted !== null && !body.isNew;
  if (body.isNew && deleted !== null) return false;
  return save.every((item) => !item.percentage || item.value <= 100);
}
const DISCOUNT_MESSAGE =
  "discountSave and discountDelete go together: one deduction (percent at most 100) or a " +
  "removal of stored rows, and a new document deletes nothing";

/** Document tax fields (exactly one of `taxRule` / `taxType` is checked by {@link oneTaxSetting}). */
const taxShape = {
  taxRule: ref("TaxRule").optional(),
  taxType: z.enum([...LEGACY_TAX_TYPES, "custom"]).optional(),
  taxSet: ref("TaxSet").optional(),
  taxRate: z.literal(0),
  taxText: z.string().min(1).optional(),
  smallSettlement: z.boolean(),
};

/** Structured recipient address (invoices, credit notes; sent by sevdesk-rs, echoed in responses). */
const structuredAddressShape = {
  address: z.string().optional(),
  addressName: z.string().optional(),
  addressStreet: z.string().nullable().optional(),
  addressZip: z.string().nullable().optional(),
  addressCity: z.string().nullable().optional(),
  addressCountry: ref("StaticCountry").optional(),
};

function oneTaxSetting(value: { taxRule?: unknown; taxType?: unknown }): boolean {
  return (value.taxRule === undefined) !== (value.taxType === undefined);
}
const TAX_MESSAGE = "a document carries either taxRule (Update 2.0) or taxType (Update 1.0)";

const invoiceDocumentSchema = z
  .strictObject({
    id: id.optional(),
    objectName: z.literal("Invoice"),
    mapAll: z.literal(true),
    invoiceNumber: z.string().min(1).optional(),
    invoiceType: z.literal("RE"),
    status: z.literal(100),
    contact: ref("Contact"),
    contactPerson: ref("SevUser"),
    invoiceDate: germanDate,
    deliveryDate: timestamp.optional(),
    deliveryDateUntil: timestamp.optional(),
    header: z.string().min(1).optional(),
    headText: z.string().optional(),
    footText: z.string().optional(),
    timeToPay: z.number().int().min(0).optional(),
    discount: z.number().min(0).max(100),
    discountTime: z.number().int().min(0).optional(),
    currency: z.string().length(3),
    showNet: z.boolean(),
    ...taxShape,
    ...structuredAddressShape,
    customerInternalNote: z.string().optional(),
    paymentMethod: ref("PaymentMethod").optional(),
    costCentre: ref("CostCentre").optional(),
    origin: z.strictObject({ id, objectName: z.string().min(1) }).optional(),
    propertyIsEInvoice: z.boolean().optional(),
  })
  .refine(oneTaxSetting, TAX_MESSAGE);

/** `POST /Invoice/Factory/saveInvoice` (create, or update with `invoice.id`). */
export const saveInvoiceBodySchema = z
  .strictObject({
    invoice: invoiceDocumentSchema,
    invoicePosSave: z.array(positionSchema("InvoicePos")).min(1).nullable(),
    invoicePosDelete: deleteSchema("InvoicePos"),
    ...discountShape,
  })
  .refine(
    (body) => discountKeysFit({ ...body, isNew: body.invoice.id === undefined }),
    DISCOUNT_MESSAGE,
  );
export type SaveInvoiceBody = z.output<typeof saveInvoiceBodySchema>;

/** Booking categories this server writes (ACCOUNTING_TYPE is not supported on Update 2.0). */
export const CREDIT_NOTE_BOOKING_CATEGORIES = [
  "UNDERACHIEVEMENT",
  "PROVISION",
  "ROYALTY_ASSIGNED",
  "ROYALTY_UNASSIGNED",
] as const;

const creditNoteDocumentSchema = z
  .strictObject({
    id: id.optional(),
    objectName: z.literal("CreditNote"),
    mapAll: z.literal(true),
    creditNoteNumber: z.string().min(1).optional(),
    creditNoteType: z.literal("CN"),
    status: z.literal(100),
    contact: ref("Contact"),
    contactPerson: ref("SevUser"),
    creditNoteDate: germanDate,
    deliveryDate: timestamp,
    deliveryDateUntil: timestamp.optional(),
    header: z.string().min(1).optional(),
    headText: z.string().optional(),
    footText: z.string().optional(),
    discount: z.number().min(0).max(100),
    discountTime: z.number().int().min(0).optional(),
    currency: z.string().length(3),
    showNet: z.boolean(),
    ...taxShape,
    bookingCategory: z.enum(CREDIT_NOTE_BOOKING_CATEGORIES),
    refSrcInvoice: ref("Invoice").optional(),
    ...structuredAddressShape,
    customerInternalNote: z.string().optional(),
    paymentMethod: ref("PaymentMethod").optional(),
    origin: z.strictObject({ id, objectName: z.string().min(1) }).optional(),
  })
  .refine(oneTaxSetting, TAX_MESSAGE)
  // A new credit note carries the number reserved for it (without one, `sendBy` fails: see
  // credit-note.ts); an update keeps whatever the draft has stored, also none.
  .refine(
    (doc) => doc.id !== undefined || doc.creditNoteNumber !== undefined,
    "a new credit note carries its reserved number",
  );

/**
 * `POST /CreditNote/Factory/saveCreditNote` (create, or update with `creditNote.id`; recorded
 * 2026-11-16, spec/deviations.md D-110). `creditNotePosDelete` is a list of refs or `null`: the
 * spec's single `{id, objectName}` object is refused with HTTP 400. An update that keeps the
 * positions sends `creditNotePosSave: []` with `creditNotePosDelete: null`, the recorded shape.
 */
export const saveCreditNoteBodySchema = z
  .strictObject({
    creditNote: creditNoteDocumentSchema,
    creditNotePosSave: z.array(positionSchema("CreditNotePos")),
    creditNotePosDelete: deleteSchema("CreditNotePos"),
    ...discountShape,
  })
  .refine(
    (body) =>
      body.creditNote.id !== undefined ||
      (body.creditNotePosSave.length > 0 && body.creditNotePosDelete === null),
    "a new credit note has positions and nothing to delete",
  )
  .refine(
    (body) => discountKeysFit({ ...body, isNew: body.creditNote.id === undefined }),
    DISCOUNT_MESSAGE,
  );
export type SaveCreditNoteBody = z.output<typeof saveCreditNoteBodySchema>;

const orderDocumentSchema = z
  .strictObject({
    id: id.optional(),
    objectName: z.literal("Order"),
    mapAll: z.literal(true),
    orderNumber: z.string().min(1).optional(),
    orderType: z.enum(["AN", "AB", "LI"]),
    version: z.number().int().min(0),
    status: z.literal(100),
    contact: ref("Contact"),
    contactPerson: ref("SevUser"),
    orderDate: germanDate,
    header: z.string().min(1),
    headText: z.string().optional(),
    footText: z.string().optional(),
    currency: z.string().length(3),
    showNet: z.boolean(),
    ...taxShape,
    address: z.string().min(1).optional(),
    addressCountry: ref("StaticCountry").optional(),
    deliveryTerms: z.string().optional(),
    paymentTerms: z.string().optional(),
    customerInternalNote: z.string().optional(),
    origin: z.strictObject({ id, objectName: z.string().min(1) }).optional(),
  })
  .refine(oneTaxSetting, TAX_MESSAGE);

/** `POST /Order/Factory/saveOrder` (create, or update with `order.id`). */
export const saveOrderBodySchema = z
  .strictObject({
    order: orderDocumentSchema,
    orderPosSave: z.array(positionSchema("OrderPos")).min(1).nullable(),
    orderPosDelete: deleteSchema("OrderPos"),
    ...discountShape,
  })
  .refine(
    (body) => discountKeysFit({ ...body, isNew: body.order.id === undefined }),
    DISCOUNT_MESSAGE,
  );
export type SaveOrderBody = z.output<typeof saveOrderBodySchema>;

/**
 * Parses a body with its strict schema and returns it exactly as it goes on the wire (a JSON
 * round trip drops members that are `undefined`), so the plan holds the very JSON that is sent.
 * A failure is a bug in this server (the builders produce these bodies), so it is an internal
 * error, never sent.
 */
export function strictBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Internal error: the ${what} payload does not match its schema: ${result.error.message}`,
    );
  }
  return JSON.parse(JSON.stringify(result.data)) as z.output<S>;
}

/**
 * The id of the document a save returned (`{invoice: {...}, invoicePos: [...]}`, recorded; the
 * envelope is unwrapped by the client). sevDesk already saved the document when this runs, so a
 * missing id is an `unexpected_response` error that says so.
 */
export function savedDocumentId(
  payload: unknown,
  key: "invoice" | "creditNote" | "order" | "voucher",
  noun: string,
): number {
  const schema = z.object({ [key]: z.object({ id: zId }) });
  const parsed = schema.safeParse(expectSingle(payload, `saved ${noun}`));
  const record = parsed.success ? (parsed.data[key] as { id: number } | undefined) : undefined;
  if (record === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk accepted the ${noun} but its answer did not contain the ${noun}'s id, so it ` +
        `could not be read back. Look for the new draft in sevDesk before repeating the call.`,
    });
  }
  return record.id;
}
