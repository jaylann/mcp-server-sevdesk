import type { WriteToolCase } from "../helpers/write-cases.js";
import { DRAFTS_CASES } from "./drafts.js";
import { LIFECYCLE_CASES } from "./lifecycle.js";
import { MASTERDATA_CASES } from "./masterdata.js";

/** Every write-tool case (lead-owned: add new area files here). */
export const WRITE_TOOL_CASES: readonly WriteToolCase[] = [
  ...DRAFTS_CASES,
  ...LIFECYCLE_CASES,
  ...MASTERDATA_CASES,
];
