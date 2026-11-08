/**
 * One known-good call per write tool, shared by the generic safety tests
 * (`test/integration/write-*.test.ts`): they run every case through MCP and check that nothing
 * is written before approval, in a dry run, or after a declined confirmation, and that the
 * approved call makes exactly `writes`.
 *
 * Each M3 work area owns one file in `test/write-cases/`; `test/write-cases/index.ts` joins them.
 * Every shipped write tool needs at least one case (checked by `write-cases.test.ts`).
 */
import type { Config } from "../../src/config.js";
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
  /**
   * Prepares what the case needs outside sevDesk for one run (a temp `SEVDESK_OUTPUT_DIR` or
   * `SEVDESK_FILE_DIRS` with a file in it, a download seam) and returns config overrides plus how
   * to undo it. Called once per test before the client exists; the consumers always undo.
   */
  readonly setup?: () => Promise<WriteCaseEnvironment>;
}

/** What {@link WriteToolCase.setup} prepared. */
interface WriteCaseEnvironment {
  /** Config overrides for this run, e.g. `{ outputDir }` or `{ fileDirs: [dir] }`. */
  readonly config?: Partial<Config>;
  /** Removes temp folders, restores seams. */
  readonly undo?: () => Promise<void> | void;
}

/**
 * Runs `run` with the case's environment (its `setup`, if any) and always undoes it afterwards.
 */
export async function withCaseEnvironment<T>(
  testCase: WriteToolCase,
  run: (config: Partial<Config>) => Promise<T>,
): Promise<T> {
  const environment = (await testCase.setup?.()) ?? {};
  try {
    return await run(environment.config ?? {});
  } finally {
    await environment.undo?.();
  }
}
