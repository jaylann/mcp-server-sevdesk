/**
 * Records scrubbed fixtures from a real sevDesk account (read-only).
 *
 * Usage:
 *   pnpm fixtures:record [--dry-run] [--out-dir <dir>] [--limit <n>] [--only <file,…>] [--force]
 *
 *   --dry-run         List the requests it would make, then stop (no token needed, nothing sent).
 *   --out-dir <dir>   Parent folder (default test/fixtures/recorded); files go to <dir>/<date>/.
 *   --limit <n>       Rows per recorded list page (default 5, max 1000).
 *   --only <files>    Comma-separated entry files (e.g. invoices/invoices-list.json); entries
 *                     whose ids come from other lists still need those lists.
 *   --force           Overwrite files of the same session instead of refusing.
 *
 * Environment: SEVDESK_API_TOKEN (or SEVDESK_API_TOKEN_FILE), optional SEVDESK_BASE_URL,
 * SEVDESK_RATE_LIMIT, SEVDESK_TIMEOUT_MS. Nothing else is read: the client runs with
 * SEVDESK_READ_ONLY=1, so it refuses any request that would change data.
 *
 * Exit codes: 0 done, 1 an entry failed or an error occurred, 2 configuration problem.
 * Review the scrubbed files (git diff) before committing; see docs/recording-session.md.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { createSevdeskClient } from "../src/sevdesk/client.js";
import { describeEntry, recordPlan } from "./lib/fixture-plan.js";
import { berlinToday, readOnlyEnv, tokenMissingReason } from "./lib/live-env.js";
import { recordFixtures } from "./lib/record.js";
import { createScrubber } from "./lib/scrub.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "out-dir": { type: "string", default: resolve(REPO_ROOT, "test/fixtures/recorded") },
      limit: { type: "string", default: "5" },
      only: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });

  const today = berlinToday();
  const only = values.only
    ?.split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const plan = recordPlan(today).filter((entry) => only === undefined || only.includes(entry.file));
  const outDir = resolve(values["out-dir"], today);

  if (values["dry-run"]) {
    console.log(`Dry run: ${plan.length} read requests, files would go to ${outDir}`);
    for (const entry of plan) {
      const needs = entry.requires === undefined ? "" : `  (needs ${entry.requires.join(", ")})`;
      console.log(`  ${describeEntry(entry).padEnd(78)} -> ${entry.file}${needs}`);
    }
    return 0;
  }

  const missing = tokenMissingReason(process.env);
  if (missing !== undefined) {
    console.error(missing);
    return 2;
  }
  const limit = Number(values.limit);
  const config = loadConfig(readOnlyEnv(process.env));
  const scrubber = createScrubber({ secrets: [config.token] });
  console.log(`Recording ${plan.length} read requests into ${outDir} (read-only mode).`);

  const outcome = await recordFixtures({
    client: createSevdeskClient(config),
    scrubber,
    secrets: [config.token],
    outDir,
    date: today,
    limit,
    entries: plan,
    force: values.force,
    log: (line) => {
      console.log(`  ${line}`);
    },
  });

  const stats = scrubber.stats();
  console.log(
    `\nDone: ${outcome.written.length} written, ${outcome.skipped.length} skipped, ` +
      `${outcome.failed.length} failed (system version ${outcome.systemVersion}).`,
  );
  console.log(`Scrubbed values per rule: ${JSON.stringify(stats.byRule)}`);
  if (stats.defaultedKeys.length > 0) {
    console.log(
      `Review: text under these keys was replaced by the default rule: ${stats.defaultedKeys.join(", ")}`,
    );
  }
  console.log("Review every file (git diff) before committing; see docs/recording-session.md.");
  return outcome.failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors from loadConfig and the client never contain the token.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
