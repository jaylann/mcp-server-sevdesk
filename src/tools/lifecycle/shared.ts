/**
 * What the lifecycle tool factories share: per-kind names and output schemas, the id argument,
 * the annotations of commit and external actions, and the read-back after a write.
 */
import { z } from "zod";

import { creditNoteDetailSchema } from "../../domain/credit-notes.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import {
  type DetailByKind,
  KINDS,
  type LifecycleDocument,
  type LifecycleKind,
  readLifecycleDocument,
} from "../../domain/lifecycle/documents.js";
import { orderDetailSchema } from "../../domain/orders.js";
import { listChildRows } from "../../domain/paging.js";
import { voucherDetailDtoSchema } from "../../domain/vouchers.js";
import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import type { ToolsetName } from "../toolsets.js";
import type { SevdeskObjectRef, ToolAnnotationSet, ToolContext } from "../types.js";

/** Tool-layer names of a document kind. */
export interface KindToolInfo {
  readonly toolset: ToolsetName;
  /**
   * Key of the document in the tool output, as in the get tools: `invoice`, `creditNote`, `order`,
   * `voucher`.
   */
  readonly outputKey: "invoice" | "creditNote" | "order" | "voucher";
  readonly detailSchema: z.ZodObject;
  /** The list tool to find ids with. */
  readonly listTool: string;
  /** Title noun: "invoice", "credit note", "order", "voucher". */
  readonly title: string;
  /** What the id is not, for the id argument: "invoice number", …, "Belegnummer". */
  readonly numberName: string;
}

export const KIND_TOOLS: Readonly<Record<LifecycleKind, KindToolInfo>> = {
  invoice: {
    toolset: "invoices",
    outputKey: "invoice",
    detailSchema: invoiceDetailSchema,
    listTool: "sevdesk_invoices_list",
    title: "invoice",
    numberName: "invoice number",
  },
  creditNote: {
    toolset: "credit-notes",
    outputKey: "creditNote",
    detailSchema: creditNoteDetailSchema,
    listTool: "sevdesk_credit_notes_list",
    title: "credit note",
    numberName: "credit note number",
  },
  order: {
    toolset: "orders",
    outputKey: "order",
    detailSchema: orderDetailSchema,
    listTool: "sevdesk_orders_list",
    title: "order",
    numberName: "order number",
  },
  voucher: {
    toolset: "vouchers",
    outputKey: "voucher",
    detailSchema: voucherDetailDtoSchema,
    listTool: "sevdesk_vouchers_list",
    title: "voucher",
    numberName: "Belegnummer",
  },
};

/**
 * Commit actions (finalize, book, cancel, enshrine, reset): they change bookkeeping state that
 * only a further action reverts (or nothing, for enshrine), so destructive and never idempotent.
 */
export const COMMIT_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Emails to third parties. */
export const EXTERNAL_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** The document id argument (not its number). */
export function idInput(kind: LifecycleKind) {
  const info = KIND_TOOLS[kind];
  return z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe(
      `${capitalize(info.title)} id (not the ${info.numberName}), e.g. from ${info.listTool}.`,
    );
}

/** `{ objectName, id }` of a document, for `affected` and completed-write lists. */
export function documentObject(kind: LifecycleKind, id: number): SevdeskObjectRef {
  return { objectName: KINDS[kind].objectName, id: String(id) };
}

/** Where the positions of each kind live and how they point back to their document. */
const POSITIONS: Readonly<
  Record<LifecycleKind, { readonly path: string; readonly parentKey: string }>
> = {
  invoice: { path: "/InvoicePos", parentKey: "invoice" },
  creditNote: { path: "/CreditNotePos", parentKey: "creditNote" },
  order: { path: "/OrderPos", parentKey: "order" },
  voucher: { path: "/VoucherPos", parentKey: "voucher" },
};

/** The parent id a raw position row names (`<parentKey>.id`), as a string. */
function parentIdOf(row: unknown, parentKey: string): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const parent = (row as Record<string, unknown>)[parentKey];
  if (typeof parent !== "object" || parent === null) return undefined;
  const id = (parent as Record<string, unknown>)["id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * The approval binding of a lifecycle action (see `WritePlan.binding`): a SHA-256 of the record
 * as sevDesk sent it (full texts, exact `update` time) and of all its positions as stored. The
 * preview shows only identifying facts and totals; this covers the rest, so a document edited
 * after the human was asked (new bank details in the foot text, a changed position text with the
 * same total) is asked about again instead of finalized, sent or enshrined. The first version
 * hashed the display DTO, which cuts long texts and keeps only the date of `update`, and read no
 * positions (security review 2026-11, wave 2). One more read per confirmed call.
 */
export async function documentBinding(ctx: ToolContext, doc: LifecycleDocument): Promise<string> {
  if (doc.raw === undefined) {
    throw new Error("documentBinding needs a document from readLifecycleDocument.");
  }
  const { path, parentKey } = POSITIONS[doc.kind];
  const id = String(doc.id);
  // The rows as sevDesk sent them (full texts), checked against their parent like every
  // position read; `complete` is hashed too, so a list cut at the cap is not mistaken for a
  // complete one.
  const positions = await listChildRows(
    ctx.client,
    path,
    { [`${parentKey}[id]`]: id, [`${parentKey}[objectName]`]: KINDS[doc.kind].objectName },
    { parse: (row) => row, belongs: (row) => parentIdOf(row, parentKey) === id },
    ctx.signal,
  );
  return sha256Hex(canonicalJson({ kind: doc.kind, record: doc.raw, positions }));
}

/**
 * Reads the document again after a write (one GET, no positions) and returns its detail DTO. The
 * write already happened, so a failure here is rethrown with `completed` attached: the user is
 * told what changed and not to repeat the call.
 */
export async function readBack<K extends LifecycleKind>(
  ctx: ToolContext,
  kind: K,
  id: number,
  completed: readonly SevdeskObjectRef[],
): Promise<LifecycleDocument<K>> {
  try {
    return await readLifecycleDocument(ctx.client, kind, id, ctx.signal);
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, completed);
    throw error;
  }
}

/** The output object `{ [outputKey]: detail, ...extra }` of a lifecycle tool. */
export function documentOutput<K extends LifecycleKind>(
  kind: K,
  dto: DetailByKind[K],
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { [KIND_TOOLS[kind].outputKey]: dto, ...extra };
}

/** Output schema `{ [outputKey]: detailSchema, ...extra }`. */
export function documentOutputSchema(
  kind: LifecycleKind,
  extra: Readonly<Record<string, z.ZodType>> = {},
): z.ZodObject {
  const info = KIND_TOOLS[kind];
  return z.object({ [info.outputKey]: info.detailSchema, ...extra });
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
