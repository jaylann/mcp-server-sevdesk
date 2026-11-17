import type { AnyToolDefinition } from "../types.js";
import { creditNotePdfTool, invoicePdfTool, invoiceXmlTool, orderPdfTool } from "./file-tools.js";
import { documentSetLayoutTool } from "./layout-tool.js";
import { documentSaveTool } from "./save-tool.js";
import { documentTagTool } from "./tag-tool.js";
import { tagsListTool } from "./tags-list.js";

/**
 * Document file tools (PDF, e-invoice XML) and the layout of a draft. The read tools set the
 * toolset of their document type; `sevdesk_document_save` is registered only when files can be
 * delivered (SEVDESK_OUTPUT_DIR or remote download links, `canDeliverFiles`);
 * `sevdesk_document_set_layout` (commit) when one of the three document toolsets is enabled.
 */
export const DOCUMENT_FILE_TOOLS: readonly AnyToolDefinition[] = [
  invoicePdfTool,
  creditNotePdfTool,
  orderPdfTool,
  invoiceXmlTool,
  documentSaveTool,
  documentSetLayoutTool,
];

/**
 * Tag tools (Tags of invoices, credit notes, orders and vouchers): toolset `meta`, registered when
 * at least one of those four toolsets is enabled (`tag-kinds.ts`).
 */
export const DOCUMENT_TAG_TOOLS: readonly AnyToolDefinition[] = [tagsListTool, documentTagTool];
