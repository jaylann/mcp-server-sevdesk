import type { AnyToolDefinition } from "../types.js";
import { documentDeleteDraftTool } from "./delete-draft-tool.js";
import { creditNotePdfTool, invoicePdfTool, invoiceXmlTool, orderPdfTool } from "./file-tools.js";
import { documentSaveTool } from "./save-tool.js";

/**
 * Document tools across kinds: the file tools (PDF, e-invoice XML) and the draft delete. The read
 * tools set the toolset of their document type; `sevdesk_document_save` is registered only when
 * files can be delivered (SEVDESK_OUTPUT_DIR or remote download links, `canDeliverFiles`);
 * `sevdesk_document_save` and `sevdesk_document_delete_draft` sit in `meta` and check the
 * toolset of the requested kind on every call.
 */
export const DOCUMENT_FILE_TOOLS: readonly AnyToolDefinition[] = [
  invoicePdfTool,
  creditNotePdfTool,
  orderPdfTool,
  invoiceXmlTool,
  documentSaveTool,
  documentDeleteDraftTool,
];
