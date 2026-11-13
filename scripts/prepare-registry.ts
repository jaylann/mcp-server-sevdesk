/**
 * Adds the release's MCPB package to the server.json sent to the MCP Registry. The source file
 * stays a template: a bundle hash is only known after packing, and re-runs may replace the asset.
 * The publish job downloads the public release asset first, then hashes those exact bytes here.
 *
 * Dependency-free because the publish job has OIDC permission and must not install packages.
 * Input checks deliberately use plain Node; tests validate the result against the official schema.
 * `unzip -p` reads only the manifest, without extracting or executing the bundle's contents.
 *
 * Usage: node scripts/prepare-registry.ts <version> <tag> <bundle> <output>
 * For a local dry run, use the bundle made by `pnpm mcpb` and an output under build/.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "https://github.com/jaylann/mcp-server-sevdesk";
const NAME = "mcp-server-sevdesk";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Only fixed, script-owned messages belong here: these are safe to print in release logs. */
export class RegistryInputError extends Error {}

/** Preserve the generic guidance without exposing parser input, paths or subprocess stderr. */
export function failureMessage(error: unknown): string {
  const prefix =
    "Could not prepare the registry manifest. Check the version, tag, bundle and output path.";
  const detail =
    error instanceof RegistryInputError
      ? error.message
      : error instanceof Error
        ? `Unexpected error (${error.name}).`
        : "Unexpected error.";
  return `${prefix} ${detail}`;
}

/**
 * Returns a fresh registry document with exactly one MCPB package for the verified release.
 * Refuses stale versions, a different bundle/server identity and an already populated template.
 * All other registry metadata and packages are preserved.
 */
export function registryWithBundle(
  source: unknown,
  manifest: unknown,
  bundle: Uint8Array,
  version: string,
  tag: string,
): Record<string, unknown> {
  if (!VERSION.test(version) || tag !== `v${version}`) {
    throw new RegistryInputError("Expected a release version and its v-prefixed tag.");
  }
  const server = record(source);
  const extension = record(manifest);
  if (
    server["version"] !== version ||
    server["name"] !== `io.github.jaylann/${NAME}` ||
    record(server["repository"])["url"] !== REPOSITORY
  ) {
    throw new RegistryInputError(
      "server.json must identify this repository and the release version.",
    );
  }
  if (extension["name"] !== NAME || extension["version"] !== version) {
    throw new RegistryInputError(
      "The bundle manifest must identify this package and the release version.",
    );
  }
  if (bundle.byteLength === 0) throw new RegistryInputError("The bundle is empty.");
  const packages: unknown = server["packages"];
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new RegistryInputError("server.json must list the existing registry packages.");
  }
  const entries: Record<string, unknown>[] = packages.map(record);
  if (entries.some((entry) => entry["registryType"] === "mcpb")) {
    throw new RegistryInputError(
      "The server.json template must not contain a precomputed MCPB entry.",
    );
  }
  return {
    ...server,
    packages: [
      ...entries,
      {
        registryType: "mcpb",
        identifier: `${REPOSITORY}/releases/download/${tag}/${NAME}-${version}.mcpb`,
        fileSha256: createHash("sha256").update(bundle).digest("hex"),
        transport: { type: "stdio" },
      },
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryInputError("Expected a JSON object in the registry or bundle manifest.");
  }
  return value as Record<string, unknown>;
}

function inputStep<T>(message: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw new RegistryInputError(message, { cause });
  }
}

/** Run the dependency-free CLI; callers report failures through failureMessage. */
export function main(argv: readonly string[]): void {
  const [version, tag, bundlePath, output, ...rest] = argv;
  if (
    version === undefined ||
    tag === undefined ||
    bundlePath === undefined ||
    output === undefined ||
    rest.length !== 0
  ) {
    throw new RegistryInputError("usage: prepare-registry.ts <version> <tag> <bundle> <output>");
  }
  if (!VERSION.test(version) || basename(bundlePath) !== `${NAME}-${version}.mcpb`) {
    throw new RegistryInputError("The bundle filename must match the release version.");
  }
  const bundle = inputStep("The bundle file is not readable.", () => readFileSync(bundlePath));
  const manifestText = inputStep("unzip could not read manifest.json from the bundle.", () =>
    execFileSync("unzip", ["-p", resolve(bundlePath), "manifest.json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }),
  );
  const manifest = inputStep("The bundle's manifest is not valid JSON.", (): unknown =>
    JSON.parse(manifestText),
  );
  const sourceText = inputStep("server.json is not readable.", () =>
    readFileSync(new URL("../server.json", import.meta.url), "utf8"),
  );
  const source = inputStep("server.json is not valid JSON.", (): unknown => JSON.parse(sourceText));
  const result = registryWithBundle(source, manifest, bundle, version, tag);
  inputStep("Could not write the prepared registry manifest.", () => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  });
  console.log("Prepared server.json with the release bundle's URL and SHA-256.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(failureMessage(error));
    process.exitCode = 1;
  }
}
