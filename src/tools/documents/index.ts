import type { AnyToolDefinition } from "../types.js";
import { creditNotePdfTool, invoicePdfTool, invoiceXmlTool, orderPdfTool } from "./file-tools.js";
import { documentSaveTool } from "./save-tool.js";

/**
 * Document file tools (PDF, e-invoice XML). The read tools set the toolset of their document
 * type; `sevdesk_document_save` is registered only when files can be delivered (SEVDESK_OUTPUT_DIR
 * or remote download links, `canDeliverFiles`).
 */
export const DOCUMENT_FILE_TOOLS: readonly AnyToolDefinition[] = [
  invoicePdfTool,
  creditNotePdfTool,
  orderPdfTool,
  invoiceXmlTool,
  documentSaveTool,
];
