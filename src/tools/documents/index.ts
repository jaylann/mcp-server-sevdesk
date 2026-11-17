import type { AnyToolDefinition } from "../types.js";
import { documentDeleteDraftTool } from "./delete-draft-tool.js";
import { creditNotePdfTool, invoicePdfTool, invoiceXmlTool, orderPdfTool } from "./file-tools.js";
import { documentSetLayoutTool } from "./layout-tool.js";
import { documentSaveTool } from "./save-tool.js";

/**
 * Document tools across kinds: the file tools (PDF, e-invoice XML), the layout of a draft and the
 * draft delete. The read tools set the toolset of their document type; `sevdesk_document_save` is
 * registered only when files can be delivered (SEVDESK_OUTPUT_DIR or remote download links,
 * `canDeliverFiles`); `sevdesk_document_set_layout` and `sevdesk_document_delete_draft` (both
 * commit) when one of the three document toolsets is enabled. The tools in `meta` check the
 * toolset of the requested kind on every call.
 */
export const DOCUMENT_FILE_TOOLS: readonly AnyToolDefinition[] = [
  invoicePdfTool,
  creditNotePdfTool,
  orderPdfTool,
  invoiceXmlTool,
  documentSaveTool,
  documentSetLayoutTool,
  documentDeleteDraftTool,
];
