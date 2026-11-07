/**
 * Upstream drift check for the sevDesk OpenAPI spec and the sevDesk API-news feed.
 *
 * `spec/openapi.yaml` is a reference snapshot, not the source of truth (see spec/README.md). This
 * script tells a maintainer when upstream changed, so the change can be reviewed against
 * `spec/deviations.md` and the hand-written zod schemas in `src/sevdesk/`.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-spec-drift.ts [--report <path>] [--update] [--dir <path>]
 *
 *   --report <path>  On drift, write a Markdown report to <path> (used as the CI issue body).
 *   --update         Rewrite spec/openapi.yaml and spec/upstream.json to the upstream state.
 *   --dir <path>     Snapshot directory holding openapi.yaml + upstream.json (default: spec/).
 *
 * What it checks:
 *   - The spec URL stored in upstream.json, with a conditional request (If-None-Match and
 *     If-Modified-Since). A downloaded body is hashed (SHA-256) and compared with the stored hash;
 *     on a change the report lists added/removed paths, operations and schemas.
 *   - The API-news RSS feed (`apiNews.feedUrl`) for posts newer than `apiNews.latestPostDate`.
 *
 * Exit codes (contract with .github/workflows/spec-drift.yml):
 *   0   no drift
 *   10  drift found (report written when --report is given; files rewritten when --update is given)
 *   1   error (network failure, unexpected HTTP status, unreadable or invalid files)
 *
 * Logs go to stderr. Dependency-free: only `node:` builtins and the global fetch (Node >= 22).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const EXIT_NO_DRIFT = 0;
const EXIT_DRIFT = 10;
const EXIT_ERROR = 1;

const DEFAULT_SPEC_URL = "https://api.sevdesk.de/openapi.yaml";
const DEFAULT_NEWS_URL = "https://tech.sevdesk.com/api_news/";
const DEFAULT_FEED_URL = "https://tech.sevdesk.com/api_news/index.xml";
const USER_AGENT = "mcp-server-sevdesk-spec-drift (+https://github.com/jaylann/mcp-server-sevdesk)";
const TIMEOUT_MS = 60_000;
/** Longest list printed in the report before "N more omitted" (the CI issue body is capped). */
const MAX_LIST_ITEMS = 150;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const USAGE = `usage: check-spec-drift.ts [--report <path>] [--update] [--dir <path>]
exit codes: 0 no drift, 10 drift found, 1 error`;

/** Shape of spec/upstream.json. */
interface Baseline {
  url: string;
  etag: string | null;
  lastModified: string | null;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  apiNews: {
    url: string;
    feedUrl: string;
    latestPostUrl: string;
    latestPostTitle: string;
    latestPostDate: string;
  };
}

type SpecFetch =
  | { status: "not-modified" }
  | {
      status: "downloaded";
      body: Uint8Array;
      sha256: string;
      etag: string | null;
      lastModified: string | null;
    };

/**
 * - `unchanged`: 304, or the same bytes and validators as stored.
 * - `validators-only`: same bytes, but a new ETag/Last-Modified (not drift; `--update` refreshes).
 * - `changed`: the body hash differs from the stored one.
 * - `no-baseline`: spec/upstream.json does not exist yet.
 */
type SpecVerdict = "unchanged" | "validators-only" | "changed" | "no-baseline";

interface NewsPost {
  title: string;
  url: string;
  date: Date;
}

/** Top-level structure of an OpenAPI document, enough to summarize a change. */
interface SpecOutline {
  paths: Set<string>;
  /** `METHOD /path`, e.g. `GET /Invoice`. */
  operations: Set<string>;
  schemas: Set<string>;
}

interface SpecDiff {
  before: SpecOutline;
  after: SpecOutline;
  linesAdded: number;
  linesRemoved: number;
}

interface CheckResult {
  checkedAt: string;
  specUrl: string;
  feedUrl: string;
  baseline: Baseline | null;
  spec: SpecFetch;
  verdict: SpecVerdict;
  diff: SpecDiff | null;
  posts: NewsPost[];
  newPosts: NewsPost[];
}

// ---------------------------------------------------------------------------------------------
// Files

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${where}: "${key}" must be a string`);
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${where}: "${key}" must be a string or null`);
  return value;
}

function parseBaseline(text: string, where: string): Baseline {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error(`${where}: expected a JSON object`);
  const news = data.apiNews;
  if (!isRecord(news)) throw new Error(`${where}: "apiNews" must be an object`);
  const bytes = data.bytes;
  if (typeof bytes !== "number") throw new Error(`${where}: "bytes" must be a number`);
  return {
    url: stringField(data, "url", where),
    etag: nullableStringField(data, "etag", where),
    lastModified: nullableStringField(data, "lastModified", where),
    sha256: stringField(data, "sha256", where),
    bytes,
    fetchedAt: stringField(data, "fetchedAt", where),
    apiNews: {
      url: stringField(news, "url", where),
      feedUrl: nullableStringField(news, "feedUrl", where) ?? DEFAULT_FEED_URL,
      latestPostUrl: stringField(news, "latestPostUrl", where),
      latestPostTitle: nullableStringField(news, "latestPostTitle", where) ?? "",
      latestPostDate: stringField(news, "latestPostDate", where),
    },
  };
}

/** Reads a file, or returns null when it does not exist. */
async function readOptional(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && sha256Hex(a) === sha256Hex(b);
}

// ---------------------------------------------------------------------------------------------
// Network

function get(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Weak and strong forms of the same ETag compare equal (a CDN may weaken it on compression). */
function sameEtag(a: string | null, b: string | null): boolean {
  const strip = (tag: string | null): string | null => tag?.replace(/^W\//, "") ?? null;
  return strip(a) === strip(b);
}

async function fetchSpec(url: string, validators: Baseline | null): Promise<SpecFetch> {
  const headers: Record<string, string> = { accept: "application/yaml, text/yaml, */*" };
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;

  const response = await get(url, headers);
  if (response.status === 304) return { status: "not-modified" };
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);

  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: "downloaded",
    body,
    sha256: sha256Hex(body),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function fetchNewsPosts(feedUrl: string): Promise<NewsPost[]> {
  const response = await get(feedUrl, { accept: "application/rss+xml, application/xml" });
  if (!response.ok) throw new Error(`GET ${feedUrl} returned HTTP ${response.status}`);
  const posts = parseRssItems(await response.text());
  if (posts.length === 0) {
    throw new Error(`no <item> with <link> and <pubDate> in ${feedUrl}; did the format change?`);
  }
  return posts.sort((a, b) => b.date.getTime() - a.date.getTime());
}

// ---------------------------------------------------------------------------------------------
// Parsing (deliberately minimal: no XML or YAML dependency)

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    if (/^#x/i.test(name)) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Text content of the first `<tag>` element, CDATA unwrapped and entities decoded. */
function elementText(xml: string, tag: string): string | null {
  const raw = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
  if (raw === undefined) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)?.[1];
  return cdata === undefined ? decodeXml(raw).trim() : cdata.trim();
}

/** Parses RSS 2.0 `<item>`s (the Hugo feed at tech.sevdesk.com/api_news/index.xml). */
function parseRssItems(xml: string): NewsPost[] {
  const posts: NewsPost[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const item = match[1] ?? "";
    const url = elementText(item, "link");
    const pubDate = elementText(item, "pubDate");
    const time = pubDate === null ? Number.NaN : Date.parse(pubDate);
    if (url === null || Number.isNaN(time)) continue;
    posts.push({ title: elementText(item, "title") ?? url, url, date: new Date(time) });
  }
  return posts;
}

/** Key of a block-mapping line (`key:` or `key: value`), unquoted; null for anything else. */
function mappingKey(trimmed: string): string | null {
  if (trimmed.startsWith("- ") || trimmed.startsWith("#")) return null;
  const match = /^(?:'([^']*)'|"([^"]*)"|([^\s'"][^:]*?))\s*:(?:\s|$)/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/**
 * Collects `paths` keys, their HTTP operations and `components.schemas` keys by indentation.
 * Good enough for the block-style YAML sevDesk publishes; block-scalar text is always indented
 * deeper than the two levels inspected here, so descriptions cannot produce false keys.
 */
function outlineSpec(yaml: string): SpecOutline {
  const outline: SpecOutline = { paths: new Set(), operations: new Set(), schemas: new Set() };
  let unit = 0;
  let section = "";
  let subsection = "";
  let currentPath: string | null = null;

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const key = mappingKey(trimmed);

    if (indent === 0) {
      section = key ?? "";
      subsection = "";
      currentPath = null;
      continue;
    }
    if (unit === 0) unit = indent;
    if (key === null) continue;

    if (section === "paths") {
      if (indent === unit && key.startsWith("/")) {
        currentPath = key;
        outline.paths.add(key);
      } else if (indent === 2 * unit && currentPath !== null && HTTP_METHODS.has(key)) {
        outline.operations.add(`${key.toUpperCase()} ${currentPath}`);
      }
    } else if (section === "components") {
      if (indent === unit) subsection = key;
      else if (indent === 2 * unit && subsection === "schemas") outline.schemas.add(key);
    }
  }
  return outline;
}

/** Order-insensitive line churn: lines only in `after` / only in `before` (multiset). */
function lineChurn(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before.split(/\r?\n/)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split(/\r?\n/)) {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of counts.values()) removed += count;
  return { added, removed };
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((item) => !b.has(item)).sort();
}

function diffSpecs(beforeBytes: Uint8Array, afterBytes: Uint8Array): SpecDiff {
  const decoder = new TextDecoder();
  const before = decoder.decode(beforeBytes);
  const after = decoder.decode(afterBytes);
  const churn = lineChurn(before, after);
  return {
    before: outlineSpec(before),
    after: outlineSpec(after),
    linesAdded: churn.added,
    linesRemoved: churn.removed,
  };
}

// ---------------------------------------------------------------------------------------------
// Report

/** Escapes untrusted feed text for Markdown and defuses @-mentions in the CI issue. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|#]/g, "\\$&").replace(/@/g, "&#64;");
}

function code(text: string | null): string {
  return text === null ? "_none_" : `\`${text.replace(/`/g, "'")}\``;
}

function bulletList(items: string[]): string[] {
  const shown = items.slice(0, MAX_LIST_ITEMS).map((item) => `- ${code(item)}`);
  const omitted = items.length - shown.length;
  return omitted > 0 ? [...shown, `- … ${omitted} more omitted`] : shown;
}

function setChanges(label: string, before: Set<string>, after: Set<string>): string[] {
  const added = difference(after, before);
  const removed = difference(before, after);
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push("", `Added ${label} (${added.length}):`, "", ...bulletList(added));
  }
  if (removed.length > 0) {
    lines.push("", `Removed ${label} (${removed.length}):`, "", ...bulletList(removed));
  }
  return lines;
}

function renderSpecSection(result: CheckResult): string[] {
  const { baseline, spec, verdict, diff } = result;
  const lines = ["## OpenAPI spec", "", `Source: ${result.specUrl}`, ""];

  if (verdict === "no-baseline") {
    lines.push("No baseline: `spec/upstream.json` is missing. Run the script with `--update`.");
    return lines;
  }
  if (verdict === "unchanged" || verdict === "validators-only" || baseline === null) {
    lines.push("Unchanged (same content as the stored snapshot).");
    return lines;
  }
  if (spec.status !== "downloaded") return lines;

  lines.push(
    "**Changed.**",
    "",
    "| Field | Stored | Upstream |",
    "| --- | --- | --- |",
    `| ETag | ${code(baseline.etag)} | ${code(spec.etag)} |`,
    `| Last-Modified | ${baseline.lastModified ?? "_none_"} | ${spec.lastModified ?? "_none_"} |`,
    `| SHA-256 | ${code(baseline.sha256)} | ${code(spec.sha256)} |`,
    `| Bytes | ${baseline.bytes} | ${spec.body.byteLength} |`,
  );

  if (diff === null) {
    lines.push("", "No local `spec/openapi.yaml` to compare the structure with.");
    return lines;
  }
  const { before, after } = diff;
  lines.push(
    "",
    "### Structure",
    "",
    "| | Stored | Upstream |",
    "| --- | --- | --- |",
    `| Paths | ${before.paths.size} | ${after.paths.size} |`,
    `| Operations | ${before.operations.size} | ${after.operations.size} |`,
    `| Schemas | ${before.schemas.size} | ${after.schemas.size} |`,
    "",
    `Changed lines (order-insensitive estimate): +${diff.linesAdded} / −${diff.linesRemoved}.`,
    ...setChanges("paths", before.paths, after.paths),
    ...setChanges("operations", before.operations, after.operations),
    ...setChanges("schemas", before.schemas, after.schemas),
  );
  const sameOperations = difference(before.operations, after.operations).length === 0;
  if (sameOperations && before.operations.size === after.operations.size) {
    lines.push("", "No operations were added or removed; the change is inside existing ones.");
  }
  return lines;
}

function postLink(post: NewsPost): string {
  return `[${escapeMarkdown(post.title)}](${post.url})`;
}

function renderNewsSection(result: CheckResult): string[] {
  const source = result.baseline?.apiNews.url ?? DEFAULT_NEWS_URL;
  const lines = ["## API news", "", `Source: ${source}`, ""];
  if (result.newPosts.length === 0) {
    const latest = result.posts[0];
    lines.push(
      latest === undefined
        ? "No posts found."
        : `No new posts. Latest: ${postLink(latest)} (${day(latest.date)}).`,
    );
    return lines;
  }
  lines.push(`${result.newPosts.length} new post(s):`, "");
  for (const post of result.newPosts) lines.push(`- ${day(post.date)}: ${postLink(post)}`);
  return lines;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function renderReport(result: CheckResult): string {
  return [
    "# Upstream drift: sevDesk API",
    "",
    `Checked at ${result.checkedAt} by \`scripts/check-spec-drift.ts\`.`,
    "",
    ...renderSpecSection(result),
    "",
    ...renderNewsSection(result),
    "",
    "## Next steps",
    "",
    "1. Read the new API-news posts and diff the spec (`--update` writes it to `spec/openapi.yaml`;",
    "   `git diff spec/` then shows the change).",
    "2. Check affected entries in `spec/deviations.md` and the zod schemas in `src/sevdesk/`. A new",
    "   deviation gets an entry and a test.",
    "3. Refresh the snapshot with `pnpm exec tsx scripts/check-spec-drift.ts --update` and commit",
    "   `spec/` in a PR that closes this issue.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main

function decideVerdict(baseline: Baseline | null, spec: SpecFetch): SpecVerdict {
  if (baseline === null) return "no-baseline";
  if (spec.status === "not-modified") return "unchanged";
  if (spec.sha256 !== baseline.sha256) return "changed";
  const sameValidators =
    sameEtag(spec.etag, baseline.etag) && spec.lastModified === baseline.lastModified;
  return sameValidators ? "unchanged" : "validators-only";
}

function nextBaseline(result: CheckResult): Baseline {
  const { baseline, spec } = result;
  const latest = result.posts[0];
  const apiNews: Baseline["apiNews"] =
    latest === undefined && baseline !== null
      ? baseline.apiNews
      : {
          url: baseline?.apiNews.url ?? DEFAULT_NEWS_URL,
          feedUrl: result.feedUrl,
          latestPostUrl: latest?.url ?? "",
          latestPostTitle: latest?.title ?? "",
          latestPostDate: latest?.date.toISOString() ?? "",
        };

  if (spec.status === "downloaded") {
    return {
      url: result.specUrl,
      etag: spec.etag,
      lastModified: spec.lastModified,
      sha256: spec.sha256,
      bytes: spec.body.byteLength,
      fetchedAt: result.checkedAt,
      apiNews,
    };
  }
  if (baseline === null) throw new Error("cannot build a baseline without downloading the spec");
  return { ...baseline, apiNews };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      update: { type: "boolean", default: false },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.error(USAGE);
    return EXIT_NO_DRIFT;
  }

  const dir = resolve(values.dir ?? resolve(import.meta.dirname, "..", "spec"));
  const specPath = resolve(dir, "openapi.yaml");
  const baselinePath = resolve(dir, "upstream.json");

  const baselineBytes = await readOptional(baselinePath);
  const baselineText = baselineBytes === null ? null : new TextDecoder().decode(baselineBytes);
  const baseline = baselineText === null ? null : parseBaseline(baselineText, baselinePath);
  const localSpec = await readOptional(specPath);
  const specUrl = baseline?.url ?? DEFAULT_SPEC_URL;
  const feedUrl = baseline?.apiNews.feedUrl ?? DEFAULT_FEED_URL;

  // Without a local snapshot a 304 would leave nothing to compare or update, so ask for the body.
  const [spec, posts] = await Promise.all([
    fetchSpec(specUrl, localSpec === null ? null : baseline),
    fetchNewsPosts(feedUrl),
  ]);

  const verdict = decideVerdict(baseline, spec);
  const diff =
    verdict === "changed" && spec.status === "downloaded" && localSpec !== null
      ? diffSpecs(localSpec, spec.body)
      : null;

  const storedLatest = baseline === null ? Number.NaN : Date.parse(baseline.apiNews.latestPostDate);
  if (baseline !== null && Number.isNaN(storedLatest)) {
    throw new Error(`${baselinePath}: "apiNews.latestPostDate" is not a valid date`);
  }
  const newPosts = baseline === null ? [] : posts.filter((p) => p.date.getTime() > storedLatest);

  const result: CheckResult = {
    checkedAt: new Date().toISOString(),
    specUrl,
    feedUrl,
    baseline,
    spec,
    verdict,
    diff,
    posts,
    newPosts,
  };

  logSummary(result);
  const drift = verdict === "changed" || verdict === "no-baseline" || newPosts.length > 0;

  if (drift && values.report !== undefined) {
    await writeFile(values.report, renderReport(result));
    console.error(`report: wrote ${values.report}`);
  }

  if (values.update) {
    if (spec.status === "downloaded" && (localSpec === null || !sameBytes(localSpec, spec.body))) {
      await writeFile(specPath, spec.body);
      console.error(`update: wrote ${specPath}`);
    }
    const nextText = `${JSON.stringify(nextBaseline(result), null, 2)}\n`;
    if (nextText !== baselineText) {
      await writeFile(baselinePath, nextText);
      console.error(`update: wrote ${baselinePath}`);
    }
  }

  return drift ? EXIT_DRIFT : EXIT_NO_DRIFT;
}

function logSummary(result: CheckResult): void {
  const { spec, verdict, diff } = result;
  switch (verdict) {
    case "no-baseline":
      console.error("spec: no baseline (upstream.json missing); run with --update to create it");
      break;
    case "unchanged":
      console.error(
        spec.status === "not-modified"
          ? "spec: not modified (HTTP 304)"
          : "spec: unchanged (SHA-256 matches)",
      );
      break;
    case "validators-only":
      console.error(
        "spec: same content, new ETag/Last-Modified; run with --update to store the new validators",
      );
      break;
    case "changed": {
      console.error("spec: CHANGED (SHA-256 differs)");
      if (diff !== null) {
        const { before, after } = diff;
        console.error(`  paths ${before.paths.size} -> ${after.paths.size}`);
        console.error(`  operations ${before.operations.size} -> ${after.operations.size}`);
        console.error(`  lines +${diff.linesAdded} / -${diff.linesRemoved} (estimate)`);
      }
      break;
    }
  }

  const latest = result.posts[0];
  if (result.newPosts.length > 0) {
    console.error(`api news: ${result.newPosts.length} new post(s)`);
    for (const post of result.newPosts) {
      console.error(`  ${day(post.date)} ${post.title} ${post.url}`);
    }
  } else if (latest !== undefined) {
    console.error(`api news: no new posts (latest ${day(latest.date)}: ${latest.title})`);
  }
}

/** fetch() reports every network failure as "fetch failed"; the cause names the real problem. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  console.error(`check-spec-drift: ${describeError(error)}`);
  process.exitCode = EXIT_ERROR;
}
