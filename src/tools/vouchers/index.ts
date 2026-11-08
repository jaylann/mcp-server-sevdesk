import type { AnyToolDefinition } from "../types.js";
import { VOUCHER_EINVOICE_TOOLS } from "./einvoice-tools.js";
import { voucherGetTool } from "./get.js";
import { vouchersListTool } from "./list.js";
import { VOUCHER_WRITE_TOOLS } from "./write-tools.js";

/** Tools of the `vouchers` toolset (Belege). */
export const VOUCHER_TOOLS: readonly AnyToolDefinition[] = [
  vouchersListTool,
  voucherGetTool,
  ...VOUCHER_WRITE_TOOLS,
  ...VOUCHER_EINVOICE_TOOLS,
];
