import type { AnyToolDefinition } from "../types.js";
import { einvoiceParseTool } from "./einvoice-parse.js";

/** E-invoice tools of the `vouchers` toolset: the local XRechnung/ZUGFeRD parser. */
export const VOUCHER_EINVOICE_TOOLS: readonly AnyToolDefinition[] = [einvoiceParseTool];
