/**
 * One known-good call per write tool, shared by the generic safety tests
 * (`test/integration/write-*.test.ts`): they run every case through MCP and check that nothing
 * is written before approval, in a dry run, or after a declined confirmation, and that the
 * approved call makes exactly `writes`.
 *
 * Each M3 work area owns one file in `test/write-cases/`; `test/write-cases/index.ts` joins them.
 * Every shipped write tool needs at least one case (checked by `write-cases.test.ts`).
 */
import type { HttpMethod } from "../../src/sevdesk/types.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import type { FakeRoute } from "./fake-client.js";

export interface WriteToolCase {
  /** Short label for test names, e.g. "finalize a draft invoice". */
  readonly label: string;
  readonly tool: AnyWriteToolDefinition;
  /** Valid arguments, without `dryRun`. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Routes for a fake client that let `prepare` and `execute` (incl. read-back) succeed. */
  readonly routes: readonly FakeRoute[];
  /** The data-changing requests an approved call makes, in order. */
  readonly writes: readonly { readonly method: HttpMethod; readonly path: string }[];
}
