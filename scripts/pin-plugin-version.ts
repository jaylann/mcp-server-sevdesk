/**
 * Pins the release version where release-please cannot, and checks every place that carries it.
 *
 * - `plugin/.mcp.json`: the npx argument becomes `mcp-server-sevdesk@<version>`.
 * - `server.json`: the OCI package's image tag becomes `<version>`. The MCP Registry takes an OCI
 *   package's version from the tag in its `identifier` and refuses a separate `version` field.
 *
 * Why a script: release-please bumps package.json, server.json and plugin.json, but its JSON
 * updater can only replace a whole value with the bare version, not write `name@version` into an
 * npx argument or `image:version` into an identifier. The release workflow runs this on the release
 * PR branch after release-please updated it (`pin-plugin` job), so the merged release pins the
 * version it publishes; `test/unit/plugin/plugin.test.ts` and
 * `test/unit/scripts/pin-plugin-version.test.ts` fail whenever they drift.
 *
 * `--check <version>` writes nothing: it exits 1 unless package.json, server.json (both packages),
 * plugin.json and plugin/.mcp.json all carry `<version>` and server.json's name is package.json's
 * `mcpName`. With `--image <repository>` it also requires the OCI package to name that repository.
 * The publish jobs run it before anything leaves the repository.
 *
 * Dependency-free on purpose: the workflow runs it with plain Node 24 (type stripping) without
 * installing packages, because that job holds a token that can push.
 *
 * Usage: `pnpm plugin:pin` (or `node scripts/pin-plugin-version.ts`),
 * `node scripts/pin-plugin-version.ts --check <version> [--image <repository>]`.
 * Exit codes: 0 ok, 1 a check failed or a file could not be pinned, 2 usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MCP_CONFIG = new URL("../plugin/.mcp.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const SERVER_JSON = new URL("../server.json", import.meta.url);
const PLUGIN_JSON = new URL("../plugin/.claude-plugin/plugin.json", import.meta.url);

/** npm package names and semver versions, as far as this repository uses them. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** `registry/path:tag` with a registry host (a dot) and no digest: the form server.json uses. */
const IMAGE_REFERENCE =
  /^(?<repository>[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[a-z0-9._-]+)+):(?<tag>\w[\w.-]{0,127})$/;

/**
 * `text` (the .mcp.json source) with the JSON string `"<name>"` or `"<name>@…"` replaced by
 * `"<name>@<version>"`, keeping every other byte (so the file stays Prettier-formatted). Throws
 * unless the argument occurs exactly once.
 */
export function pinPackageArgument(text: string, name: string, version: string): string {
  if (!PACKAGE_NAME.test(name)) {
    throw new Error(`Unexpected package name ${JSON.stringify(name)}.`);
  }
  checkVersion(version);
  const argument = new RegExp(`"${escapeRegExp(name)}(?:@[^"]*)?"`, "g");
  const matches = text.match(argument)?.length ?? 0;
  if (matches !== 1) {
    throw new Error(`Expected "${name}" exactly once in plugin/.mcp.json, found ${matches}.`);
  }
  return text.replace(argument, `"${name}@${version}"`);
}

/**
 * `text` (the server.json source) with the tag of the OCI package's `identifier` replaced by
 * `version`, keeping every other byte. Throws unless server.json has exactly one OCI package, its
 * identifier is `registry/path:tag`, and that identifier occurs exactly once in the text.
 */
export function pinImageTag(text: string, version: string): string {
  checkVersion(version);
  const { repository } = imageReference(ociPackage(JSON.parse(text)).identifier);
  const identifier = new RegExp(`"${escapeRegExp(repository)}:[^"]*"`, "g");
  const matches = text.match(identifier)?.length ?? 0;
  if (matches !== 1) {
    throw new Error(`Expected "${repository}:…" exactly once in server.json, found ${matches}.`);
  }
  return text.replace(identifier, `"${repository}:${version}"`);
}

/** The sources of the files that carry the release version. */
export interface ReleaseFiles {
  readonly packageJson: string;
  readonly serverJson: string;
  readonly pluginJson: string;
  readonly mcpJson: string;
}

/**
 * Every place in `files` that does not carry `version`, as messages (empty when all match).
 * `image`, when given, is the repository the OCI package must name (`ghcr.io/owner/name`).
 * Throws only for malformed JSON.
 */
export function releaseVersionProblems(
  files: ReleaseFiles,
  version: string,
  image?: string,
): string[] {
  const problems: string[] = [];
  const expect = (where: string, got: unknown) => {
    if (got !== version) {
      problems.push(`${where} is ${JSON.stringify(got)}, expected "${version}".`);
    }
  };

  const pkg = record(JSON.parse(files.packageJson));
  const server = record(JSON.parse(files.serverJson));
  const plugin = record(JSON.parse(files.pluginJson));
  const mcp = record(JSON.parse(files.mcpJson));

  expect("package.json version", pkg["version"]);
  expect("server.json version", server["version"]);
  expect("plugin/.claude-plugin/plugin.json version", plugin["version"]);

  if (server["name"] !== pkg["mcpName"]) {
    problems.push(
      `server.json name ${JSON.stringify(server["name"])} differs from package.json mcpName ${JSON.stringify(pkg["mcpName"])}.`,
    );
  }

  const packages = Array.isArray(server["packages"]) ? server["packages"].map(record) : [];
  const ofType = (type: string) => packages.filter((entry) => entry["registryType"] === type);
  const [npm, ...moreNpm] = ofType("npm");
  if (npm === undefined || moreNpm.length > 0) {
    problems.push("server.json must list exactly one npm package.");
  } else {
    if (npm["identifier"] !== pkg["name"]) {
      problems.push(
        `server.json npm package is ${JSON.stringify(npm["identifier"])}, expected ${JSON.stringify(pkg["name"])}.`,
      );
    }
    expect("server.json npm package version", npm["version"]);
  }
  const [oci, ...moreOci] = ofType("oci");
  if (oci === undefined || moreOci.length > 0) {
    problems.push("server.json must list exactly one OCI package.");
  } else {
    const reference = typeof oci["identifier"] === "string" ? oci["identifier"] : "";
    const match = IMAGE_REFERENCE.exec(reference)?.groups;
    if (match === undefined) {
      problems.push(
        `server.json OCI identifier ${JSON.stringify(oci["identifier"])} is not registry/path:tag.`,
      );
    } else {
      expect("server.json OCI image tag", match["tag"]);
      if (image !== undefined && match["repository"] !== image) {
        problems.push(
          `server.json OCI image is ${JSON.stringify(match["repository"])}, expected ${JSON.stringify(image)}.`,
        );
      }
    }
    for (const field of ["version", "registryBaseUrl"]) {
      if (field in oci) {
        problems.push(`server.json OCI package must not have "${field}" (the tag is the version).`);
      }
    }
  }

  const servers = record(mcp["mcpServers"]);
  const args = record(servers["sevdesk"])["args"];
  const name = typeof pkg["name"] === "string" ? pkg["name"] : "";
  const pin = Array.isArray(args)
    ? args.find((arg): arg is string => typeof arg === "string" && arg.startsWith(`${name}@`))
    : undefined;
  expect("plugin/.mcp.json pin", pin?.slice(name.length + 1));

  return problems;
}

function checkVersion(version: string): void {
  if (!VERSION.test(version)) {
    throw new Error(`Unexpected version ${JSON.stringify(version)}.`);
  }
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ociPackage(server: unknown): { identifier: string } {
  const packages = record(server)["packages"];
  const oci = (Array.isArray(packages) ? packages.map(record) : []).filter(
    (entry) => entry["registryType"] === "oci",
  );
  const identifier = oci[0]?.["identifier"];
  if (oci.length !== 1 || typeof identifier !== "string") {
    throw new Error(
      `Expected exactly one OCI package with an identifier in server.json, found ${oci.length}.`,
    );
  }
  return { identifier };
}

function imageReference(identifier: string): { repository: string; tag: string } {
  const groups = IMAGE_REFERENCE.exec(identifier)?.groups;
  if (groups?.["repository"] === undefined || groups["tag"] === undefined) {
    throw new Error(
      `The OCI identifier ${JSON.stringify(identifier)} in server.json is not registry/path:tag.`,
    );
  }
  return { repository: groups["repository"], tag: groups["tag"] };
}

function readFiles(): ReleaseFiles {
  return {
    packageJson: readFileSync(PACKAGE_JSON, "utf8"),
    serverJson: readFileSync(SERVER_JSON, "utf8"),
    pluginJson: readFileSync(PLUGIN_JSON, "utf8"),
    mcpJson: readFileSync(MCP_CONFIG, "utf8"),
  };
}

function pin(): void {
  const files = readFiles();
  const pkg = JSON.parse(files.packageJson) as { name: string; version: string };
  const targets = [
    {
      path: MCP_CONFIG,
      label: "plugin/.mcp.json",
      before: files.mcpJson,
      after: pinPackageArgument(files.mcpJson, pkg.name, pkg.version),
    },
    {
      path: SERVER_JSON,
      label: "server.json",
      before: files.serverJson,
      after: pinImageTag(files.serverJson, pkg.version),
    },
  ];
  for (const { path, label, before, after } of targets) {
    if (after === before) {
      console.log(`${label} already pins ${pkg.version}.`);
    } else {
      writeFileSync(path, after);
      console.log(`${label} now pins ${pkg.version}.`);
    }
  }
}

function check(version: string, image: string | undefined): number {
  const problems = releaseVersionProblems(readFiles(), version, image);
  // GitHub Actions turns `::error::` lines into annotations on the run.
  const prefix = process.env["GITHUB_ACTIONS"] === "true" ? "::error::" : "error: ";
  for (const problem of problems) {
    console.log(`${prefix}${problem}`);
  }
  if (problems.length === 0) {
    console.log(`package.json, server.json and the plugin are at ${version}.`);
  }
  return problems.length === 0 ? 0 : 1;
}

function main(argv: readonly string[]): number {
  if (argv.length === 0) {
    pin();
    return 0;
  }
  const [flag, version, imageFlag, image, ...rest] = argv;
  const usable =
    flag === "--check" &&
    version !== undefined &&
    VERSION.test(version) &&
    rest.length === 0 &&
    (imageFlag === undefined || (imageFlag === "--image" && image !== undefined));
  if (!usable) {
    console.error(
      "usage: pin-plugin-version.ts [--check <version> [--image <repository>]] (no arguments: pin)",
    );
    return 2;
  }
  return check(version, image);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
