import type { WriteToolCase } from "../helpers/write-cases.js";
import { BANKING_CASES } from "./banking.js";
import { DRAFTS_CASES } from "./drafts.js";
import { LIFECYCLE_CASES } from "./lifecycle.js";
import { MASTERDATA_CASES } from "./masterdata.js";
import { REPORTS_CASES } from "./reports.js";
import { VOUCHERS_CASES } from "./vouchers.js";

/** Every write-tool case (lead-owned: add new area files here). */
export const WRITE_TOOL_CASES: readonly WriteToolCase[] = [
  ...DRAFTS_CASES,
  ...LIFECYCLE_CASES,
  ...MASTERDATA_CASES,
  ...VOUCHERS_CASES,
  ...BANKING_CASES,
  ...REPORTS_CASES,
];
