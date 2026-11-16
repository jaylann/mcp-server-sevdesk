/**
 * `pnpm approvals:dev`: try the approval pages for real, without sevDesk. An assistant is played
 * by keys: each request calls a confirmed write tool (finalize, send, book, cancel, …) against
 * recorded fixtures, the server opens its local approval page as it does for Claude Desktop or
 * Claude Code, and you decide in the browser. No token is needed and nothing leaves the machine
 * (`scripts/lib/approvals-sandbox.ts`).
 *
 *   pnpm approvals:dev                     # keys only
 *   pnpm approvals:dev --scenario steady   # a new request every 20 s
 *   pnpm approvals:dev --scenario burst    # three at once, two more after 15 s
 *   pnpm approvals:dev --no-open           # don't open pages; follow the links in the log
 *
 * Keys: n new request · b three at once · r the assistant retries every waiting call (approved
 * ones run, rejected ones are declined) · c change the newest waiting record, then retry ·
 * e/x skip 9/10 minutes · f fill up to the limit and one more · l list waiting · q quit.
 */
import { emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";

import { type CallOutcome, createSandbox } from "./lib/approvals-sandbox.js";

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    "no-open": { type: "boolean", default: false },
  },
});
if (values.scenario !== undefined && !["steady", "burst"].includes(values.scenario)) {
  throw new Error(`approvals:dev: unknown scenario "${values.scenario}" (steady, burst)`);
}

const MINUTE = 60_000;
const HELP =
  "keys: n new · b three at once · r retry waiting · c change newest record · " +
  "e +9 min · x +10 min · f fill to the limit · l list · q quit";

const time = (): string => new Date().toTimeString().slice(0, 8);
const say = (line: string): void => {
  console.log(`${time()}  ${line}`);
};

function report(outcome: CallOutcome): void {
  const reference = outcome.reference === undefined ? "" : ` ${outcome.reference}`;
  const changed = outcome.summary.startsWith("The record changed") ? " (record changed)" : "";
  say(`${outcome.tool} (${outcome.task}): ${outcome.status}${reference}${changed}`);
  if (outcome.status === "error" || outcome.status === "declined") say(`  ${outcome.summary}`);
}

const sandbox = createSandbox({ open: !values["no-open"] });
say(
  `approvals sandbox: ${String(sandbox.tasks)} tasks, fake sevDesk, no token, nothing leaves ` +
    "this machine. Approval links appear below (stderr).",
);
say(HELP);

/** `count` new requests, one after another. */
async function requests(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) report(await sandbox.request());
}

/** One action at a time, in the order the keys came. */
let queue = Promise.resolve();
function run(action: () => Promise<void>): void {
  queue = queue.then(action).catch((error: unknown) => {
    say(`failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const timers: NodeJS.Timeout[] = [];
async function quit(): Promise<void> {
  for (const timer of timers) clearInterval(timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await queue;
  await sandbox.close();
  say("closed");
}

const KEYS: Record<string, () => Promise<void>> = {
  n: () => requests(1),
  b: () => requests(3),
  r: async () => {
    const outcomes = await sandbox.retryWaiting();
    if (outcomes.length === 0) say("nothing waits");
    outcomes.forEach(report);
  },
  c: async () => {
    const outcome = await sandbox.changeNewest();
    if (outcome === undefined) say("no waiting finalize, send or enshrine to change");
    else report(outcome);
  },
  e: () => {
    sandbox.skip(9 * MINUTE);
    say("clock +9 min: one minute left for the oldest requests");
    return Promise.resolve();
  },
  x: () => {
    sandbox.skip(10 * MINUTE);
    say("clock +10 min: every waiting request has expired");
    return Promise.resolve();
  },
  f: async () => {
    for (let i = 0; i < 6; i += 1) {
      const outcome = await sandbox.request();
      report(outcome);
      if (outcome.status === "error") break;
    }
  },
  l: () => {
    const waiting = sandbox.waiting();
    if (waiting.length === 0) say("nothing waits");
    for (const outcome of waiting) say(`  waiting: ${outcome.reference ?? "?"} ${outcome.tool}`);
    return Promise.resolve();
  },
  h: () => {
    say(HELP);
    return Promise.resolve();
  },
};

function press(key: string): void {
  if (key === "q") {
    void quit();
    return;
  }
  const action = KEYS[key];
  if (action !== undefined) run(action);
}

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (text: string | undefined, key: { ctrl?: boolean; name?: string }) => {
  if (key.ctrl === true && key.name === "c") press("q");
  else if (text !== undefined) press(text.toLowerCase());
});

if (values.scenario === "steady") {
  run(() => requests(1));
  timers.push(
    setInterval(() => {
      run(() => requests(1));
    }, 20_000),
  );
} else if (values.scenario === "burst") {
  run(() => requests(3));
  timers.push(
    setTimeout(() => {
      run(() => requests(2));
    }, 15_000),
  );
}
