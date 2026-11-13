import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import {
  CREDIT_NOTE_STATUS_FILTERS,
  creditNoteRowSchema,
  type CreditNoteStatusFilter,
  listCreditNotes,
} from "../../domain/credit-notes.js";
import {
  documentListData,
  documentListSummary,
  localFilterOutputShape,
} from "../../domain/document-positions.js";
import {
  creditNoteSummary,
  creditNoteSummarySchema,
  listDetailInputShape,
} from "../../domain/list-summary.js";
import { pageOutputShape, pagingInputShape } from "../../domain/paging.js";
import { defineTool } from "../define-tool.js";

const STATUS_KEYS = Object.keys(CREDIT_NOTE_STATUS_FILTERS) as [
  CreditNoteStatusFilter,
  ...CreditNoteStatusFilter[],
];

const output = z.object({
  items: z.array(z.union([creditNoteRowSchema, creditNoteSummarySchema])),
  ...pageOutputShape,
  ...localFilterOutputShape,
});

/** `sevdesk_credit_notes_list`: find credit notes by status, contact, number or date. */
export const creditNotesListTool = defineTool({
  name: "sevdesk_credit_notes_list",
  title: "List sevDesk credit notes",
  description:
    "List credit notes (Gutschriften) with compact rows: number, status, contact, date, " +
    "net/tax/gross, booking category (e.g. UNDERACHIEVEMENT = Minderleistung, PROVISION) and " +
    "the invoice they refer to (sourceInvoiceId). Filter by status (draft = Entwurf, open, " +
    "partially_paid, paid), contactId, exact credit note number (Gutschriftsnummer) and date " +
    "range. Page with offset = nextOffset while hasMore. Use detail=summary to browse/find. Use sevdesk_credit_note_get for details and positions. " +
    "The source invoice: sevdesk_invoice_get.",
  toolset: "credit-notes",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...listDetailInputShape,
    status: z
      .enum(STATUS_KEYS)
      .optional()
      .describe("draft (100), open (200), partially_paid (750) or paid (1000)."),
    contactId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Only credit notes of this contact."),
    number: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Exact credit note number, e.g. 'GU-1000'."),
    ...dateRangeInputShape,
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listCreditNotes(ctx.client, args, ctx.signal);
    return {
      data: {
        ...documentListData(result, args),
        items: args.detail === "summary" ? result.items.map(creditNoteSummary) : [...result.items],
      },
      summary: documentListSummary("Credit notes", "matching credit notes", result, args),
    };
  },
});
