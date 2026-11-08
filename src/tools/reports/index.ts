import type { AnyToolDefinition } from "../types.js";
import { payablesAgingTool, receivablesAgingTool } from "./aging.js";
import { cashPositionTool } from "./cash-position.js";
import { changedSinceTool } from "./changed-since.js";
import { REPORT_EXPORT_TOOLS } from "./export-tools.js";
import { recordsSummarizeTool } from "./summarize.js";
import { REPORT_TAX_TOOLS } from "./tax-tools.js";

/** Tools of the `reports` toolset (Auswertungen: aggregates computed from sevDesk records). */
export const REPORT_TOOLS: readonly AnyToolDefinition[] = [
  recordsSummarizeTool,
  receivablesAgingTool,
  payablesAgingTool,
  cashPositionTool,
  changedSinceTool,
  ...REPORT_TAX_TOOLS,
  ...REPORT_EXPORT_TOOLS,
];
