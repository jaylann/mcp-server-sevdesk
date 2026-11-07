import type { AnyToolDefinition } from "../types.js";
import { voucherGetTool } from "./get.js";
import { vouchersListTool } from "./list.js";

/** Tools of the `vouchers` toolset (Belege). */
export const VOUCHER_TOOLS: readonly AnyToolDefinition[] = [vouchersListTool, voucherGetTool];
