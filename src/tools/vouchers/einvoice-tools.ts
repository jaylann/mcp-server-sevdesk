import type { AnyToolDefinition } from "../types.js";
import { einvoiceParseTool } from "./einvoice-parse.js";

/** E-invoice tools of the `vouchers` toolset, M4: the local XRechnung/ZUGFeRD parser. Owned by the m4-einvoice agent. */
export const VOUCHER_EINVOICE_TOOLS: readonly AnyToolDefinition[] = [einvoiceParseTool];
