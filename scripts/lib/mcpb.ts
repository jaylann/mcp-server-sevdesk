/**
 * The checked parts of the `.mcpb` build (scripts/build-mcpb.ts), kept apart so they are unit
 * tested (test/unit/scripts/mcpb.test.ts): the release manifest with its generated tool list, the
 * checks on how its settings reach the server, the check that the bundled server imports nothing
 * but Node built-ins, and the third-party license notices that ship inside the bundle.
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";

import { loadConfig } from "../../src/config.js";
import { selectTools } from "../../src/tools/registry.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";

/** A manifest as parsed JSON (manifest_version 0.3); the build reads only a few fields. */
export type Manifest = Readonly<Record<string, unknown>>;

/** One entry of the manifest's `tools`, which Claude Desktop shows before installing. */
interface ManifestTool {
  readonly name: string;
  readonly description: string;
}

/**
 * The manifest's `tools`: every tool a bundle install can offer, i.e. what `selectTools` picks for
 * the widest stdio configuration (all tiers, all toolsets, a file and an output folder). Tools that
 * need another transport are left out. Sorted by name; the description is the title and the tier.
 */
export function manifestTools(tools: readonly AnyToolDefinition[]): ManifestTool[] {
  const folder = resolve("/");
  const widest = loadConfig({
    SEVDESK_API_TOKEN: "0".repeat(32),
    SEVDESK_ALLOW: "all",
    SEVDESK_TOOLSETS: "all",
    SEVDESK_FILE_DIRS: folder,
    SEVDESK_OUTPUT_DIR: folder,
  });
  return selectTools(tools, widest).map((tool) => ({
    name: tool.name,
    description: `${tool.title} (tier: ${tool.tier})`,
  }));
}

/**
 * The manifest that goes into the bundle: `template` (mcpb/manifest.json) plus the generated
 * `tools`. Throws when the template's version is not `version` (package.json's), or when it lists
 * tools itself (they are generated, so they cannot drift from the code).
 */
export function releaseManifest(
  template: Manifest,
  version: string,
  tools: readonly ManifestTool[],
): Manifest {
  if (template["version"] !== version) {
    throw new Error(
      `mcpb/manifest.json version is ${JSON.stringify(template["version"])}, but package.json is at "${version}".`,
    );
  }
  if ("tools" in template) {
    throw new Error("mcpb/manifest.json must not list tools; the build generates them.");
  }
  if (tools.length === 0) {
    throw new Error("No tools to list in the manifest.");
  }
  return { ...template, tools };
}

const USER_CONFIG_REFERENCE = /\$\{user_config\.([^}]*)\}/g;

/**
 * Problems with how the manifest starts the server and passes its settings, as messages (empty
 * when fine):
 *
 * - `mcp_config` runs `node ${__dirname}/<entry_point>`.
 * - Every `${user_config.<key>}` names a declared setting, and every setting is passed on.
 * - Every optional setting has a `default`. Hosts substitute only settings that have a value
 *   (`getMcpConfigForManifest` in @anthropic-ai/mcpb, the code Claude Desktop uses), so an optional
 *   setting left empty without a default would reach the server as the literal text
 *   `${user_config.<key>}`. With a default of `""` it arrives empty, which the server treats as
 *   unset.
 * - A required setting has no default (the host must ask for it).
 * - A sensitive setting is passed in `env` only: arguments are visible in the process list.
 */
export function manifestProblems(manifest: Manifest): string[] {
  const problems: string[] = [];
  const server = record(manifest["server"]);
  const config = record(server["mcp_config"]);
  const entry = server["entry_point"];
  const args = Array.isArray(config["args"]) ? config["args"].map(String) : [];
  const settings = record(manifest["user_config"]);

  if (
    config["command"] !== "node" ||
    typeof entry !== "string" ||
    args[0] !== `\${__dirname}/${entry}`
  ) {
    problems.push(
      'mcp_config must run "node" with "${__dirname}/<entry_point>" as its first argument.',
    );
  }

  const places: (readonly [where: string, value: string])[] = [
    ...args.map((arg) => ["args", arg] as const),
    ...Object.entries(record(config["env"])).map(
      ([name, value]) => [`env ${name}`, String(value)] as const,
    ),
  ];
  const referenced = new Set<string>();
  const inArgs = new Set<string>();
  for (const [where, value] of places) {
    for (const [, key = ""] of value.matchAll(USER_CONFIG_REFERENCE)) {
      referenced.add(key);
      if (where === "args") inArgs.add(key);
      if (!(key in settings)) {
        problems.push(
          `mcp_config ${where} uses \${user_config.${key}}, which user_config does not declare.`,
        );
      }
    }
  }

  for (const [key, value] of Object.entries(settings)) {
    const setting = record(value);
    if (!referenced.has(key)) {
      problems.push(`user_config.${key} is never passed to the server.`);
    }
    if (setting["required"] === true) {
      if ("default" in setting) {
        problems.push(`user_config.${key} is required, so it must not have a default.`);
      }
    } else if (!("default" in setting)) {
      problems.push(
        `user_config.${key} is optional but has no default: left empty, it would reach the server as the literal text \${user_config.${key}}.`,
      );
    }
    if (setting["sensitive"] === true && inArgs.has(key)) {
      problems.push(`user_config.${key} is sensitive, so pass it in env, not in args.`);
    }
  }
  return problems;
}

/** What the build reads from one output chunk or asset of the bundler. */
interface BuildOutput {
  readonly type: "chunk" | "asset";
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

/**
 * Problems with the bundled server, as messages (empty when fine): it must be the single file
 * `entry` and import nothing but Node built-ins, since a bundle has no `node_modules`.
 */
export function bundleOutputProblems(outputs: readonly BuildOutput[], entry: string): string[] {
  const problems: string[] = [];
  const files = outputs.map((output) => output.fileName);
  if (files.length !== 1 || files[0] !== entry) {
    problems.push(
      `Expected the bundle to be the single file ${entry}, got ${files.join(", ") || "nothing"}.`,
    );
  }
  for (const output of outputs) {
    for (const source of [...(output.imports ?? []), ...(output.dynamicImports ?? [])]) {
      if (!isBuiltin(source)) {
        problems.push(`${output.fileName} imports ${source}, which the bundle does not contain.`);
      }
    }
  }
  return problems;
}

/** A package whose code is bundled into the server, with its license texts. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** SPDX expression from package.json, or "UNKNOWN". */
  readonly license: string;
  readonly author: string | undefined;
  readonly repository: string | undefined;
  /** License, notice and copying files of the package, by file name. */
  readonly notices: readonly { readonly file: string; readonly text: string }[];
}

/**
 * The package directories (`…/node_modules/<name>` or `…/node_modules/@scope/<name>`) that bundled
 * module ids come from, sorted and without duplicates. Ids outside `node_modules` (this project's
 * sources, the bundler's virtual modules) are skipped. Paths use `/` on every platform.
 */
export function packageRoots(moduleIds: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const id of moduleIds) {
    if (id.startsWith("\0")) continue;
    const path = id.replace(/[?#].*$/, "").replaceAll("\\", "/");
    const marker = path.lastIndexOf("/node_modules/");
    if (marker === -1) continue;
    const rest = path.slice(marker + "/node_modules/".length).split("/");
    // `@scope/name` or `name`.
    const segments = rest[0]?.startsWith("@") ? 2 : 1;
    const name = rest.slice(0, segments);
    if (name.length < segments || name.some((part) => part === "")) continue;
    roots.add(`${path.slice(0, marker)}/node_modules/${name.join("/")}`);
  }
  return [...roots].sort();
}

/** File system access of {@link readBundledPackage}; tests pass a fake. */
export interface PackageFiles {
  readonly readFile: (path: string) => string;
  readonly listFiles: (dir: string) => readonly string[];
}

const NODE_FILES: PackageFiles = {
  readFile: (path) => readFileSync(path, "utf8"),
  listFiles: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry: Dirent) => entry.isFile())
      .map((entry) => entry.name),
};

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][\w.-]*)?$/i;

/** Name, version, license and the license/notice files of the package at `root`. */
export function readBundledPackage(root: string, files: PackageFiles = NODE_FILES): BundledPackage {
  const pkg = record(JSON.parse(files.readFile(`${root}/package.json`)));
  const notices = files
    .listFiles(root)
    .filter((file) => NOTICE_FILE.test(file))
    .sort()
    .map((file) => ({ file, text: files.readFile(`${root}/${file}`).trim() }));
  return {
    name: String(pkg["name"]),
    version: String(pkg["version"]),
    license: typeof pkg["license"] === "string" ? pkg["license"] : "UNKNOWN",
    author: person(pkg["author"]),
    repository: repositoryUrl(pkg["repository"]),
    notices,
  };
}

/**
 * Licenses that may be bundled into an MIT-licensed release: permissive, and satisfied by shipping
 * the license texts (THIRD_PARTY_LICENSES.txt).
 */
const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Zlib",
]);

/**
 * Problems with the bundled packages' licenses, as messages: every SPDX identifier in a license
 * expression must be on the allow-list (for `OR`, one allowed alternative is enough). A package
 * whose package.json names no license counts as "UNKNOWN" and fails.
 */
export function licenseProblems(packages: readonly BundledPackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of packages) {
    if (!licenseAllowed(pkg.license)) {
      problems.push(
        `${pkg.name}@${pkg.version} is licensed ${JSON.stringify(pkg.license)}, which is not on the bundle's allow-list (${[...ALLOWED_LICENSES].join(", ")}).`,
      );
    }
  }
  return problems;
}

function licenseAllowed(expression: string): boolean {
  const alternatives = expression.replaceAll(/[()]/g, " ").split(/\s+OR\s+/);
  return alternatives.some((alternative) =>
    alternative
      .split(/\s+AND\s+/)
      .map((id) => id.trim())
      .every((id) => ALLOWED_LICENSES.has(id)),
  );
}

const RULE = "-".repeat(80);

/** A font embedded in the server (`src/pages/assets.generated.ts`), with its license text. */
export interface EmbeddedFont {
  readonly name: string;
  /** SPDX identifier, e.g. "OFL-1.1". */
  readonly license: string;
  readonly source: string;
  /** The license file as the font's authors publish it (with their copyright line). */
  readonly text: string;
}

/**
 * THIRD_PARTY_LICENSES.txt: who wrote the bundled code and under which terms, sorted by name,
 * followed by the fonts the server embeds for its own pages.
 */
export function thirdPartyNotices(
  packages: readonly BundledPackage[],
  version: string,
  fonts: readonly EmbeddedFont[] = [],
): string {
  const sorted = [...packages].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  const lines = [
    `Third-party software in the mcp-server-sevdesk ${version} bundle`,
    "",
    "server/index.mjs contains code from the packages below. Their license texts follow.",
    "mcp-server-sevdesk itself is MIT-licensed; see LICENSE.",
    "",
    ...sorted.map((pkg) => `- ${pkg.name} ${pkg.version}: ${pkg.license}`),
    ...fonts.map((font) => `- ${font.name} (font): ${font.license}`),
  ];
  for (const pkg of sorted) {
    lines.push("", RULE, `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`);
    if (pkg.repository !== undefined) lines.push(`Source: ${pkg.repository}`);
    if (pkg.notices.length === 0) {
      lines.push(
        "",
        `The package ships no license file; its package.json declares the ${pkg.license} license` +
          (pkg.author === undefined ? "." : ` and the author ${pkg.author}.`),
      );
    }
    for (const notice of pkg.notices) {
      lines.push("", ...(pkg.notices.length > 1 ? [`${notice.file}:`, ""] : []), notice.text);
    }
  }
  for (const font of fonts) {
    lines.push(
      "",
      RULE,
      `${font.name} (font, embedded unmodified for the server's own pages)`,
      `License: ${font.license}`,
      `Source: ${font.source}`,
      "",
      font.text.trim(),
    );
  }
  return `${lines.join("\n")}\n`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function person(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const name = record(value)["name"];
  return typeof name === "string" ? name : undefined;
}

function repositoryUrl(value: unknown): string | undefined {
  const url = typeof value === "string" ? value : record(value)["url"];
  return typeof url === "string" ? url.replace(/^git\+/, "") : undefined;
}
