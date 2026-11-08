/**
 * The wire side of voucher (Beleg) writes: the strict `saveVoucher` body, the receipt upload
 * (`uploadTempFile`) and the reading of both answers.
 *
 * `POST /Voucher/Factory/saveVoucher` (spec `voucherFactorySaveVoucher`, schema `saveVoucher`):
 * - keys in exactly this order: `voucher`, `voucherPosSave`, `voucherPosDelete`, `filename`. The
 *   spec: "the order of the last two attributes always needs to be kept"; `filename` belongs at
 *   the top level, next to `voucher`; inside `voucher` sevDesk drops it silently and the voucher
 *   has no document (B5, spec/deviations.md D-026, joosthel/sevdesk-mcp#2). zod builds the output
 *   in shape order and {@link strictBody} keeps it through the JSON round trip;
 * - positions go into `voucherPosSave` (`saveVoucher.required` names a non-existent `voucherPos`,
 *   D-004);
 * - Update 2.0 only: `voucher.taxRule` and `voucherPos.accountDatev`, never `taxType` /
 *   `accountingType` (voucher writes refuse 1.0 accounts);
 * - a position sends `net` and only the sum sevDesk reads with it (`sumNet` when `net` is true,
 *   `sumGross` otherwise; spec `Model_VoucherPos`: the other one is read-only), the same `net` on
 *   every position ("All positions must be either net or gross"), and no other derived value
 *   (`sumTax`, voucher sums);
 * - `status` 50 (draft) or 100 (open: the finalize); the HTTP client requires the commit tier for
 *   anything but 50 (`minimumWriteTier`);
 * - dates as `dd.mm.yyyy` (spec: "Needs to be provided as timestamp or dd.mm.yyyy"), references
 *   as `{id, objectName}`, `mapAll: true` on the voucher and every position.
 *
 * `POST /Voucher/Factory/uploadTempFile`: multipart with one part `file` (the spec's media type
 * `form-data` is not a real one, D-011). The answer's `filename` is a token such as
 * `f019bec36c65f5a0e7d2c63cc33f0681.pdf` that `saveVoucher` takes; the answer also carries a base64
 * preview (`content`, ~100 KB) that is dropped here and never reaches the model (B6).
 *
 * Measured by the M4 probes (2026-11-08): the array shape of `voucherPosDelete`
 * ({@link voucherPosDelete}), the keys of the upload answer ({@link uploadAnswerSchema}), the
 * top-level `filename` (inside `voucher` it is dropped).
 */
import { z } from "zod";

import type { LocalFileKind } from "../../safety/local-files.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { parseUpstream, zBool01, zNumberish, zText } from "../../sevdesk/schema.js";
import { compare } from "../money.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function ref<N extends string>(objectName: N) {
  return z.strictObject({ id, objectName: z.literal(objectName) });
}

const germanDate = z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/);

/** Voucher status a draft is saved with (spec: saveVoucher accepts 50 and 100). */
export const VOUCHER_DRAFT_STATUS = 50;
/** Voucher status after finalizing (open, booked). */
export const VOUCHER_OPEN_STATUS = 100;

/** sevDesk's temp-file token: letters, digits, dot, dash, underscore (hash plus extension). */
const FILENAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const voucherSchema = z.strictObject({
  id: id.optional(),
  objectName: z.literal("Voucher"),
  mapAll: z.literal(true),
  voucherDate: germanDate,
  supplier: ref("Contact").nullable(),
  supplierName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  paymentDeadline: germanDate.optional(),
  deliveryDate: germanDate,
  deliveryDateUntil: germanDate.optional(),
  status: z.union([z.literal(VOUCHER_DRAFT_STATUS), z.literal(VOUCHER_OPEN_STATUS)]),
  taxRule: ref("TaxRule"),
  creditDebit: z.enum(["C", "D"]),
  voucherType: z.literal("VOU"),
  currency: z.literal("EUR"),
  costCentre: ref("CostCentre").optional(),
});

const positionSchema = z
  .strictObject({
    objectName: z.literal("VoucherPos"),
    mapAll: z.literal(true),
    accountDatev: ref("AccountDatev"),
    taxRate: z.number().min(0).max(100),
    net: z.boolean(),
    sumNet: z.number().positive().optional(),
    sumGross: z.number().positive().optional(),
    comment: z.string().min(1).optional(),
    isAsset: z.boolean(),
  })
  .refine(
    (position) =>
      position.net
        ? position.sumNet !== undefined && position.sumGross === undefined
        : position.sumGross !== undefined && position.sumNet === undefined,
    "a voucher position sends sumNet when net is true and sumGross otherwise, never both",
  );

/**
 * `voucherPosDelete` is an array of `{id, objectName: "VoucherPos"}` (M4 probe, 2026-11-08: one
 * object is refused with 400 "voucherPosDelete expected array with 'id' and 'objectName'"; the
 * array deletes the stored positions and sevDesk recomputes the sums), like `invoicePosDelete`
 * (D-054), although the spec declares one object (D-004). `null` deletes nothing.
 */
const voucherPosDeleteSchema = z.array(ref("VoucherPos")).min(1).nullable();

/** `POST /Voucher/Factory/saveVoucher` (create, update with `voucher.id`, finalize). */
export const saveVoucherBodySchema = z
  .strictObject({
    voucher: voucherSchema,
    voucherPosSave: z.array(positionSchema).min(1).nullable(),
    voucherPosDelete: voucherPosDeleteSchema,
    filename: z.string().regex(FILENAME_TOKEN).optional(),
  })
  .refine(
    (body) => new Set((body.voucherPosSave ?? []).map((position) => position.net)).size <= 1,
    "all voucher positions are net or all are gross",
  );

export type SaveVoucherBody = z.output<typeof saveVoucherBodySchema>;
export type VoucherPositionPayload = z.output<typeof positionSchema>;

/** The `voucherPosDelete` value that deletes the stored positions `ids` (see the schema). */
export function voucherPosDelete(
  ids: readonly number[],
): { id: number; objectName: "VoucherPos" }[] | null {
  return ids.length === 0
    ? null
    : ids.map((positionId) => ({ id: positionId, objectName: "VoucherPos" }));
}

/** `{id, objectName}` for a payload. */
export function voucherRef<N extends string>(
  refId: number,
  objectName: N,
): { id: number; objectName: N } {
  return { id: refId, objectName };
}

/**
 * `value` (an exact decimal string) as a JSON number. An amount with more digits than a JSON
 * number holds exactly (e.g. "12345678901234567.89") is refused as a trusted `validation` error
 * before anything is sent, like `exactNumber` of the payments.
 */
export function exactJsonNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || compare(String(number), value) !== 0) {
    throw new SevdeskError({
      kind: "validation",
      message:
        "An amount has too many digits to be sent to sevDesk exactly; use a smaller amount " +
        "with at most 2 decimals.",
    });
  }
  return number;
}

// ---------------------------------------------------------------------------------------------
// Receipt upload
// ---------------------------------------------------------------------------------------------

/** MIME type sent for each accepted file kind (recognized by content, `readConfinedFile`). */
const MIME_TYPES: Readonly<Record<LocalFileKind, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  xml: "application/xml",
};

/** A local receipt file to upload (read in `prepare` by `readConfinedFile`). */
export interface ReceiptFile {
  /** Base name, e.g. `Rechnung-4711.pdf`; local text, sanitized before it is shown. */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly bytes: Uint8Array;
}

/** The multipart body of `uploadTempFile`: one part `file` with the sniffed MIME type. */
export function uploadForm(file: ReceiptFile): FormData {
  const form = new FormData();
  const blob = new Blob([file.bytes.slice()], { type: MIME_TYPES[file.kind] });
  form.append("file", blob, file.name);
  return form;
}

/**
 * The keys of the upload answer read here (spec, confirmed by the M4 probe: `pages`, `mimeType`,
 * `originMimeType`, `filename`, `contentHash`, `content`, plus an undeclared `isEInvoice`, true for
 * a Factur-X PDF). The preview in `content` is never parsed or kept (B6).
 */
const uploadAnswerSchema = z.object({
  filename: z.string().regex(FILENAME_TOKEN),
  pages: zNumberish.optional(),
  mimeType: zText,
  contentHash: zText,
  isEInvoice: zBool01.optional(),
});

/** What the upload answered, without the preview. */
export interface UploadedReceipt {
  /** sevDesk's temp-file token for `saveVoucher.filename`. */
  readonly filename: string;
  readonly pages?: number | undefined;
  /** sevDesk recognized an e-invoice (e.g. a Factur-X PDF); nothing of its XML is used. */
  readonly isEInvoice?: boolean | undefined;
}

/**
 * Reads the upload answer (unwrapped `objects`). An answer without a usable `filename` is an
 * `unexpected_response` error; the uploaded temp file is not a record, so nothing was created.
 */
export function readUploadAnswer(payload: unknown): UploadedReceipt {
  const answer = parseUpstream(
    uploadAnswerSchema,
    expectSingle(payload, "uploaded file"),
    "the receipt upload answer",
  );
  return {
    filename: answer.filename,
    ...(answer.pages === undefined ? {} : { pages: answer.pages }),
    ...(answer.isEInvoice === true ? { isEInvoice: true } : {}),
  };
}
