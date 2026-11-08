/**
 * Pins the Claude Code plugin's server to the package version: rewrites the
 * `mcp-server-sevdesk[@version]` argument in `plugin/.mcp.json` to `mcp-server-sevdesk@<version>`
 * from package.json.
 *
 * Why a script: release-please bumps package.json, server.json and plugin.json, but its JSON
 * updater can only replace a whole value with the bare version, not write `name@version` into an
 * npx argument. The release workflow runs this on the release PR branch after release-please
 * updated it (`pin-plugin` job), so the merged release pins the version it publishes, and
 * `test/unit/plugin/plugin.test.ts` fails whenever the two drift.
 *
 * Dependency-free on purpose: the workflow runs it with plain Node 24 (type stripping) without
 * installing packages, because that job holds a token that can push.
 *
 * Usage: `pnpm plugin:pin` (or `node scripts/pin-plugin-version.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MCP_CONFIG = new URL("../plugin/.mcp.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);

/** npm package names and semver versions, as far as this repository uses them. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * `text` (the .mcp.json source) with the JSON string `"<name>"` or `"<name>@…"` replaced by
 * `"<name>@<version>"`, keeping every other byte (so the file stays Prettier-formatted). Throws
 * unless the argument occurs exactly once.
 */
export function pinPackageArgument(text: string, name: string, version: string): string {
  if (!PACKAGE_NAME.test(name)) {
    throw new Error(`Unexpected package name ${JSON.stringify(name)}.`);
  }
  if (!VERSION.test(version)) {
    throw new Error(`Unexpected version ${JSON.stringify(version)}.`);
  }
  const escaped = name.replaceAll(".", String.raw`\.`);
  const argument = new RegExp(`"${escaped}(?:@[^"]*)?"`, "g");
  const matches = text.match(argument)?.length ?? 0;
  if (matches !== 1) {
    throw new Error(`Expected "${name}" exactly once in plugin/.mcp.json, found ${matches}.`);
  }
  return text.replace(argument, `"${name}@${version}"`);
}

function main(): void {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { name: string; version: string };
  const before = readFileSync(MCP_CONFIG, "utf8");
  const after = pinPackageArgument(before, pkg.name, pkg.version);
  if (after === before) {
    console.log(`plugin/.mcp.json already pins ${pkg.name}@${pkg.version}.`);
    return;
  }
  writeFileSync(MCP_CONFIG, after);
  console.log(`plugin/.mcp.json now pins ${pkg.name}@${pkg.version}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
