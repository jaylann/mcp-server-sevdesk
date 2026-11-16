/**
 * The approval flow of a local server with nothing behind it, for `pnpm approvals:dev`
 * (`scripts/approvals-dev.ts`): the real safety runtime with the real local approval page
 * (`approval-local.ts`), real MCP clients that call the write tools as an assistant would, and a
 * {@link FakeSevdeskClient} per tool that answers from the recorded fixtures of
 * `test/write-cases/`. No sevDesk token, and nothing leaves the machine: `fetch` is refused while
 * the sandbox runs.
 *
 * Every confirmed write case (`commit` and `external`) is one "assistant task". Each has its own
 * server factory and client, as separate tool calls would, but all share one safety runtime, so
 * their approvals meet in one store and on one local server, exactly as the calls of one stdio
 * session do. The clock can be moved forward to let approvals expire.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";

import type { OpenUrl } from "../../src/safety/open-url.js";
import { createSafetyRuntime, type SafetyRuntime } from "../../src/safety/runtime.js";
import { requiresConfirmation } from "../../src/safety/tiers.js";
import { createServerFactory } from "../../src/server.js";
import { allEnabledConfig } from "../../test/helpers/config.js";
import { type ConfirmHarness, connectConfirming } from "../../test/helpers/confirm-client.js";
import { type FakeRoute, FakeSevdeskClient } from "../../test/helpers/fake-client.js";
import type { WriteToolCase } from "../../test/helpers/write-cases.js";
import { WRITE_TOOL_CASES } from "../../test/write-cases/index.js";

export interface SandboxOptions {
  /** Opens each approval page in the browser (`SEVDESK_CONFIRM_OPEN`). Default false. */
  readonly open?: boolean;
  /** The opener when `open` is set (default: the OS opener). */
  readonly openUrl?: OpenUrl;
  /** The approval page's log lines, with its link (default: stderr, as in production). */
  readonly log?: (line: string) => void;
}

/** What one tool call returned, as the assistant would read it. */
export interface CallOutcome {
  readonly task: string;
  readonly tool: string;
  /** `done`, `approval_pending`, `declined`, or `error` for a refused call (e.g. the limit). */
  readonly status: string;
  /** The approval's reference code while it waits. */
  readonly reference?: string;
  /** The summary line (or the error text). */
  readonly summary: string;
}

export interface Sandbox {
  /** Calls the next task that is not waiting for a decision: a new approval request. */
  request(): Promise<CallOutcome>;
  /** Calls every task that waits again, with the same arguments, as the assistant retries. */
  retryWaiting(): Promise<CallOutcome[]>;
  /**
   * Changes the stored record of the newest waiting task whose approval covers the record (a
   * finalize, send or enshrine), then retries it: the server asks again, "the record changed".
   * Undefined when no such task waits.
   */
  changeNewest(): Promise<CallOutcome | undefined>;
  /** Moves the clock of the approvals forward. */
  skip(ms: number): void;
  /** Tasks waiting for a decision, oldest first. */
  waiting(): readonly CallOutcome[];
  /** How many tasks there are to call. */
  readonly tasks: number;
  close(): Promise<void>;
}

interface Task {
  readonly testCase: WriteToolCase;
  /** The fake's route table; `changeNewest` replaces entries in place. */
  readonly routes: FakeRoute[];
  harness?: ConfirmHarness;
  last?: CallOutcome;
}

/** The confirmed write cases the sandbox can call without preparing files or folders. */
function confirmedCases(): WriteToolCase[] {
  return WRITE_TOOL_CASES.filter(
    (testCase) => requiresConfirmation(testCase.tool.tier) && testCase.setup === undefined,
  );
}

function outcomeOf(task: Task, result: CallToolResult): CallOutcome {
  const [first] = result.content;
  const text = first?.type === "text" ? first.text : "";
  const base = { task: task.testCase.label, tool: task.testCase.tool.name };
  if (result.isError === true) return { ...base, status: "error", summary: text };
  const split = text.indexOf("\n\n");
  const summary = split === -1 ? text : text.slice(0, split);
  const data = (split === -1 ? {} : JSON.parse(text.slice(split + 2))) as {
    status?: string;
    approval?: { reference?: string };
  };
  return {
    ...base,
    status: data.status ?? "unknown",
    ...(data.approval?.reference === undefined ? {} : { reference: data.approval.reference }),
    summary,
  };
}

/**
 * The record a binding approval covers: the first GET route that answers with one object
 * carrying sevDesk's `update` timestamp (the document the tool reads before it asks).
 */
function recordRoute(routes: readonly FakeRoute[]): number {
  return routes.findIndex((route) => {
    if ((route.method ?? "GET") !== "GET" || !("body" in route.response)) return false;
    const objects = (route.response.body as { objects?: unknown }).objects;
    return Array.isArray(objects) && objects.length === 1 && "update" in (objects[0] as object);
  });
}

/** Starts nothing yet: the local approval server starts with the first request. */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
  let skew = 0;
  const now = (): number => Date.now() + skew;
  const config = allEnabledConfig({ confirm: "browser", confirmOpen: options.open === true });
  const safety: SafetyRuntime = createSafetyRuntime(config, {
    now,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.openUrl === undefined ? {} : { openUrl: options.openUrl }),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.reject(new Error("approvals sandbox: nothing leaves this machine"));

  const tasks: Task[] = confirmedCases().map((testCase) => ({
    testCase,
    routes: [...testCase.routes],
  }));
  let cursor = 0;

  async function call(task: Task): Promise<CallOutcome> {
    if (task.harness === undefined) {
      const client = new FakeSevdeskClient(task.routes);
      const factory = createServerFactory({ config, client, tools: [task.testCase.tool], safety });
      task.harness = await connectConfirming(factory, { elicitation: false, transport: "stdio" });
    }
    const { tool, args } = task.testCase;
    const result = await task.harness.client.callTool({ name: tool.name, arguments: { ...args } });
    task.last = outcomeOf(task, result);
    return task.last;
  }

  const isWaiting = (task: Task): boolean => task.last?.status === "approval_pending";

  return {
    tasks: tasks.length,

    async request() {
      for (let tried = 0; tried < tasks.length; tried += 1) {
        const task = tasks[cursor % tasks.length];
        cursor += 1;
        if (task !== undefined && !isWaiting(task)) return call(task);
      }
      throw new Error("every task is waiting for a decision");
    },

    async retryWaiting() {
      const outcomes: CallOutcome[] = [];
      for (const task of tasks.filter(isWaiting)) outcomes.push(await call(task));
      return outcomes;
    },

    async changeNewest() {
      const task = [...tasks]
        .reverse()
        .find((candidate) => isWaiting(candidate) && recordRoute(candidate.routes) !== -1);
      if (task === undefined) return undefined;
      const at = recordRoute(task.routes);
      const route = task.routes[at];
      if (route === undefined || !("body" in route.response)) return undefined;
      const [record] = (route.response.body as { objects: Record<string, unknown>[] }).objects;
      const changed = { ...record, update: new Date(now()).toISOString() };
      task.routes[at] = { ...route, response: { body: { objects: [changed] } } };
      return call(task);
    },

    skip(ms) {
      skew += ms;
    },

    waiting() {
      return tasks.filter(isWaiting).map((task) => task.last as CallOutcome);
    },

    async close() {
      await Promise.all(
        tasks.flatMap((task) => (task.harness === undefined ? [] : [task.harness.close()])),
      );
      await safety.close();
      globalThis.fetch = realFetch;
    },
  };
}
