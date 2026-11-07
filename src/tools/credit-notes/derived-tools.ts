import type { AnyToolDefinition } from "../types.js";
import { creditNoteFromInvoiceTool } from "./from-invoice.js";

/** Credit notes derived from other documents, e.g. from an invoice (M3 master-data work). */
export const CREDIT_NOTE_DERIVED_TOOLS: readonly AnyToolDefinition[] = [creditNoteFromInvoiceTool];
