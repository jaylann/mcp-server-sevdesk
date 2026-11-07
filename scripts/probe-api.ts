/**
 * Probes the real sevDesk API for the open questions of the M3 recording session and writes a
 * Markdown report: finding, scrubbed evidence, and which spec/deviations.md entry it confirms or
 * contradicts.
 *
 * Usage:
 *   pnpm probe --out <report.md> [--allow-writes] [--only <id,…>]
 *   pnpm probe --list
 *
 *   --out <path>      Where to write the report (required unless --list).
 *   --allow-writes    Also run write probes, which create tagged test data. Trial accounts only:
 *                     also needs SEVDESK_LIVE_I_UNDERSTAND_WRITES=1, and the run is refused when
 *                     the account already holds more than SEVDESK_LIVE_MAX_EXISTING_RECORDS
 *                     (default 60) invoices plus contacts it did not create.
 *   --probe-email <a> With --allow-writes: also run the e-mail probe, which sends ONE e-mail to
 *                     this address (one you own; never a contact's). Enables the external tier
 *                     for that probe only; without it nothing is ever e-mailed.
 *   --only <ids>      Run only these probes (opt-in probes such as read-rate-limit-burst run only
 *                     when listed here).
 *   --list            Print every probe and the checks that are never probed, then stop.
 *
 * Environment: SEVDESK_API_TOKEN (or SEVDESK_API_TOKEN_FILE), optional SEVDESK_BASE_URL,
 * SEVDESK_RATE_LIMIT, SEVDESK_TIMEOUT_MS. Without --allow-writes the client runs read-only and
 * refuses every data-changing request before sending it. Write runs enable the write and commit
 * tiers (plus external only with --probe-email); nothing is ever enshrined or exported.
 *
 * Exit codes: 0 report written, 1 a probe errored or the run failed, 2 configuration problem.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { createSevdeskClient } from "../src/sevdesk/client.js";
import {
  berlinToday,
  foreignRecordCounts,
  maxExistingRecords,
  probeEmailAddress,
  readOnlyEnv,
  runTag,
  tokenMissingReason,
  trialCheck,
  WRITE_WARNING,
  writeEnv,
  writeGate,
} from "./lib/live-env.js";
import { ALL_PROBES, NOT_PROBED } from "./lib/probes/catalog.js";
import { renderReport } from "./lib/probes/report.js";
import { runProbes } from "./lib/probes/runner.js";
import { assertNoSecrets, createScrubber } from "./lib/scrub.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "allow-writes": { type: "boolean", default: false },
      only: { type: "string" },
      list: { type: "boolean", default: false },
      "probe-email": { type: "string" },
    },
    strict: true,
  });

  if (values.list) {
    for (const probe of ALL_PROBES) {
      const flags = `${probe.mode}${probe.optIn === true ? ", opt-in" : ""}`;
      console.log(`${probe.id} [${flags}] ${probe.deviations.join(", ")}\n    ${probe.question}`);
    }
    console.log("\nNot probed (manual):");
    for (const check of NOT_PROBED) console.log(`  - ${check.what}: ${check.why}`);
    return 0;
  }
  if (values.out === undefined) {
    console.error("Missing --out <report.md>. Run with --list to see the probes.");
    return 2;
  }
  const missing = tokenMissingReason(process.env);
  if (missing !== undefined) {
    console.error(missing);
    return 2;
  }
  const only = values.only
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = (only ?? []).filter((id) => !ALL_PROBES.some((probe) => probe.id === id));
  if (unknown.length > 0) {
    console.error(`Unknown probe ids: ${unknown.join(", ")} (see --list).`);
    return 2;
  }

  const allowWrites = values["allow-writes"];
  const probeEmail = probeEmailAddress(values["probe-email"]);
  if (probeEmail !== undefined && !allowWrites) {
    console.error("--probe-email needs --allow-writes (the e-mail probe is a write probe).");
    return 2;
  }
  if (allowWrites) {
    const gate = writeGate(process.env, true);
    if (!gate.open) {
      console.error(gate.reason);
      return 2;
    }
    console.error(`\n${WRITE_WARNING}\n`);
    const readOnly = loadConfig(readOnlyEnv(process.env));
    const counts = await foreignRecordCounts(createSevdeskClient(readOnly));
    const refusal = trialCheck(counts, maxExistingRecords(process.env));
    if (refusal !== undefined) {
      console.error(refusal);
      return 2;
    }
  }

  const config = loadConfig(
    allowWrites
      ? writeEnv(process.env, { external: probeEmail !== undefined })
      : readOnlyEnv(process.env),
  );
  const scrubber = createScrubber({ secrets: [config.token] });
  const tag = runTag();
  const today = berlinToday();
  const mode = allowWrites
    ? `with writes, tag "${tag}"${probeEmail === undefined ? "" : `, one e-mail to ${probeEmail}`}`
    : "read-only";
  console.log(`Probing ${config.baseUrl} (${mode}).`);

  const report = await runProbes({
    client: createSevdeskClient(config),
    scrubber,
    probes: ALL_PROBES,
    allowWrites,
    ...(only === undefined ? {} : { only }),
    tag,
    today,
    nowSeconds: Math.floor(Date.now() / 1000),
    baseUrl: config.baseUrl,
    ...(probeEmail === undefined ? {} : { probeEmail }),
    makeClient: (requestsPerSecond, onEvent) =>
      createSevdeskClient({ ...config, requestsPerSecond }, { onEvent }),
    log: (line) => {
      console.log(`  ${line}`);
    },
  });

  const markdown = renderReport(report);
  assertNoSecrets(markdown, [config.token]);
  const target = resolve(values.out);
  await writeFile(target, markdown, { mode: 0o644 });

  const count = (status: string) =>
    report.results.filter((result) => result.status === status).length;
  console.log(
    `\nReport: ${target}\n` +
      `${count("confirmed")} confirmed, ${count("contradicted")} contradicted, ${count("observed")} observed, ` +
      `${count("inconclusive")} inconclusive, ${count("skipped")} skipped, ${count("error")} errors.`,
  );
  if (report.created.length > 0) {
    console.log(
      `Created ${report.created.length} test records; the cleanup list is at the end of the report.`,
    );
  }
  return count("error") > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
