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
import { voucherDetailDtoSchema } from "../../domain/vouchers.js";
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
