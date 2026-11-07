/**
 * The fixture recorder behind `pnpm fixtures:record`: runs the {@link recordPlan} against a
 * real account through the normal sevDesk client (read-only mode, pacing, redirects refused,
 * token redaction on errors) and writes scrubbed fixtures in the format of
 * `test/fixtures/README.md` with `_provenance.source: "recorded"`.
 *
 * It uses `client.download` for every read because that returns the raw body, envelope and
 * `total` included, exactly as sevDesk sent it; the fixture format needs that, the unwrapping
 * `client.request` loses it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { format, resolveConfig } from "prettier";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import { describeEntry, type Ids, type RecordEntry, resolveEntry, rowsOf } from "./fixture-plan.js";
import { assertNoSecrets, type Scrubber } from "./scrub.js";

export interface RecordOptions {
  /** A client in read-only mode (`readOnlyEnv`). */
  readonly client: SevdeskClient;
  readonly scrubber: Scrubber;
  /** Strings that must never reach a file (the token). */
  readonly secrets: readonly string[];
  /** The session folder, e.g. `<repo>/test/fixtures/recorded/2026-11-20`. */
  readonly outDir: string;
  /** Recording date, YYYY-MM-DD (provenance). */
  readonly date: string;
  /** Rows per recorded list page (1–1000). */
  readonly limit: number;
  readonly entries: readonly RecordEntry[];
  /** Overwrite existing files (default: refuse). */
  readonly force?: boolean;
  readonly log?: (line: string) => void;
}

export interface RecordOutcome {
  readonly systemVersion: "1.0" | "2.0";
  readonly written: readonly { readonly file: string; readonly rows: number }[];
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
  readonly failed: readonly { readonly file: string; readonly reason: string }[];
}

/** What a recorded fixture file contains (the format `loadFixture` validates). */
interface RecordedFixture {
  readonly _provenance: {
    readonly source: "recorded";
    readonly ref: string;
    readonly date: string;
    readonly systemVersion: "1.0" | "2.0";
    readonly note: string;
  };
  readonly status: 200;
  readonly body: unknown;
}

/** Records every entry; failures of single entries are collected, not thrown. */
export async function recordFixtures(options: RecordOptions): Promise<RecordOutcome> {
  const log = options.log ?? (() => undefined);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("limit must be a whole number from 1 to 1000.");
  }
  const systemVersion = await readSystemVersion(options.client);
  const known: Ids = {};
  const written: { file: string; rows: number }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const failed: { file: string; reason: string }[] = [];

  for (const entry of options.entries) {
    const resolved = resolveEntry(entry, known);
    if (!resolved.ok) {
      const reason = `no ${resolved.missing} id: the account has no matching record`;
      skipped.push({ file: entry.file, reason });
      log(`skip  ${entry.file} (${reason})`);
      continue;
    }
    const query =
      entry.list === true
        ? { ...resolved.query, limit: entry.limit ?? options.limit, offset: 0, countAll: true }
        : resolved.query;

    let body: unknown;
    try {
      const response = await options.client.download({ method: "GET", path: resolved.path, query });
      body = parseJson(response.body);
    } catch (error) {
      const reason = describeFailure(error, options.scrubber);
      // A refusal (e.g. getXml for an invoice that is not an e-invoice) is information, not a crash.
      (isRefusal(error) ? skipped : failed).push({ file: entry.file, reason });
      log(`${isRefusal(error) ? "skip " : "FAIL "} ${entry.file} (${reason})`);
      continue;
    }

    const objects = (body as { objects?: unknown } | null)?.objects;
    Object.assign(known, entry.collect?.(objects) ?? {});

    const fixture: RecordedFixture = {
      _provenance: {
        source: "recorded",
        ref: `${describeEntry(entry)} (recording session ${options.date})`,
        date: options.date,
        systemVersion,
        note: provenanceNote(entry),
      },
      status: 200,
      body: options.scrubber.scrub(body, entry.mode ?? "full"),
    };
    const target = join(options.outDir, entry.file);
    await writeFixture(target, fixture, options.secrets, options.force === true);
    const rows = objects === undefined || objects === null ? 0 : rowsOf(objects).length;
    written.push({ file: entry.file, rows });
    log(`wrote ${entry.file} (${rows} row${rows === 1 ? "" : "s"})`);
  }

  return { systemVersion, written, skipped, failed };
}

/** Serializes, checks for secrets, formats with the repo's Prettier config and writes. */
async function writeFixture(
  target: string,
  fixture: RecordedFixture,
  secrets: readonly string[],
  force: boolean,
): Promise<void> {
  const json = JSON.stringify(fixture, null, 2);
  assertNoSecrets(json, secrets);
  const config = (await resolveConfig(target)) ?? {};
  const formatted = await format(json, { ...config, parser: "json" });
  assertNoSecrets(formatted, secrets);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, formatted, { flag: force ? "w" : "wx", mode: 0o644 });
}

function provenanceNote(entry: RecordEntry): string {
  const parts = [
    entry.mode === "reference"
      ? "System reference data, kept verbatim except for account ids and contact data."
      : "Personal and company data replaced by scripts/lib/scrub.ts; keys, nulls and scalar types as recorded.",
  ];
  if (entry.mirrors.length > 0) parts.push(`Mirrors ${entry.mirrors.join(", ")}.`);
  if (entry.list === true) parts.push("A recorded single page (has total).");
  if (entry.note !== undefined) parts.push(entry.note);
  return parts.join(" ");
}

async function readSystemVersion(client: SevdeskClient): Promise<"1.0" | "2.0"> {
  const response = await client.download({
    method: "GET",
    path: "/Tools/bookkeepingSystemVersion",
  });
  const body = parseJson(response.body) as { objects?: { version?: unknown } } | null;
  const version = body?.objects?.version;
  if (version === "1.0" || version === "2.0") return version;
  throw new Error("Unexpected bookkeepingSystemVersion response: no version 1.0 or 2.0.");
}

function parseJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`The response is not JSON (${bytes.length} bytes).`);
  }
}

function isRefusal(error: unknown): boolean {
  return (
    error instanceof SevdeskError && (error.kind === "validation" || error.kind === "not_found")
  );
}

/** A trusted description; sevDesk's own message only after scrubbing. */
function describeFailure(error: unknown, scrubber: Scrubber): string {
  if (error instanceof SevdeskError) {
    const status = error.status === undefined ? "" : ` ${error.status}`;
    const upstream =
      error.upstreamMessage === undefined ? "" : `: ${scrubber.scrubText(error.upstreamMessage)}`;
    return `${error.kind}${status}${upstream}`;
  }
  return scrubber.scrubText(error instanceof Error ? error.message : String(error));
}
