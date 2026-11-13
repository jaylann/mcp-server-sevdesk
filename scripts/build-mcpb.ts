/**
 * Builds the Claude Desktop extension (`.mcpb`, an MCP Bundle) and smoke-tests the packed file.
 *
 * 1. Bundles the server with all its dependencies into build/mcpb/server/index.mjs
 *    (tsdown.mcpb.config.ts) and checks that the file imports nothing but Node built-ins.
 * 2. Writes build/mcpb/manifest.json: mcpb/manifest.json, whose version must be package.json's,
 *    plus the `tools` generated from ALL_TOOLS; checks how its settings reach the server.
 * 3. Adds icon.png, LICENSE and THIRD_PARTY_LICENSES.txt (the license texts of every bundled
 *    package, which must be on the allow-list in scripts/lib/mcpb.ts).
 * 4. Validates and packs it with @anthropic-ai/mcpb (the library behind the `mcpb` CLI) into
 *    build/mcp-server-sevdesk-<version>.mcpb.
 * 5. Unpacks that file into a temp directory and starts its server the way Claude Desktop does:
 *    command, arguments and environment come from the unpacked manifest through the library's
 *    `getMcpConfigForManifest`. First with only the required token set, so every optional setting
 *    takes its default; the server must start, report the manifest's name and version and list
 *    only tools the manifest declares. Then with every tier, toolset and both folders: it must
 *    list exactly the manifest's tools.
 *
 * The smoke runs give the server a dummy token and an unreachable base URL, so nothing leaves the
 * machine. Usage: `pnpm mcpb`. Exit codes: 0 ok, 1 failure.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMcpConfigForManifest,
  MANIFEST_SCHEMAS,
  type McpbUserConfigValues,
  packExtension,
  unpackExtension,
  validateManifest,
} from "@anthropic-ai/mcpb";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "tsdown";

import { ALL_TOOLS } from "../src/tools/index.js";
import type { EmbeddedFont } from "./lib/mcpb.js";
import {
  bundleOutputProblems,
  licenseProblems,
  type Manifest,
  manifestProblems,
  manifestTools,
  packageRoots,
  readBundledPackage,
  releaseManifest,
  thirdPartyNotices,
} from "./lib/mcpb.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(ROOT, "build", "mcpb");
const ENTRY = "index.mjs";
const TIMEOUT_MS = 180_000;
const DUMMY_TOKEN = "0".repeat(32);
// Port 9 (discard) on loopback: connection refused immediately, nothing leaves the machine.
const UNREACHABLE_BASE_URL = "https://127.0.0.1:9/api/v1";

/** The fonts of the server's pages (`assets/fonts/`), with their license texts. */
function embeddedFonts(): EmbeddedFont[] {
  return [
    { name: "Archivo", source: "https://github.com/Omnibus-Type/Archivo", file: "Archivo-OFL.txt" },
    {
      name: "Martian Mono",
      source: "https://github.com/evilmartians/mono",
      file: "MartianMono-OFL.txt",
    },
  ].map(({ name, source, file }) => ({
    name,
    license: "OFL-1.1",
    source,
    text: readFileSync(join(ROOT, "licenses", "fonts", file), "utf8"),
  }));
}

function fail(message: string): never {
  throw new Error(message);
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Steps 1 and 3: the bundled server, the license files. Returns the bundled packages' count. */
async function bundleServer(version: string): Promise<number> {
  const handle = await build({
    config: join(ROOT, "tsdown.mcpb.config.ts"),
    cwd: ROOT,
    logLevel: "warn",
  });
  const outputs = handle.bundles.flatMap((bundle) => bundle.chunks);
  const problems = bundleOutputProblems(
    outputs.map((output) =>
      output.type === "chunk"
        ? {
            type: "chunk",
            fileName: output.fileName,
            imports: output.imports,
            dynamicImports: output.dynamicImports,
          }
        : { type: "asset", fileName: output.fileName },
    ),
    ENTRY,
  );
  if (problems.length > 0) fail(problems.join("\n"));

  const moduleIds = outputs.flatMap((output) => (output.type === "chunk" ? output.moduleIds : []));
  const packages = packageRoots(moduleIds).map((root) => readBundledPackage(root));
  const licenses = licenseProblems(packages);
  if (licenses.length > 0) fail(licenses.join("\n"));
  writeFileSync(
    join(BUNDLE, "THIRD_PARTY_LICENSES.txt"),
    thirdPartyNotices(packages, version, embeddedFonts()),
  );
  copyFileSync(join(ROOT, "LICENSE"), join(BUNDLE, "LICENSE"));
  return packages.length;
}

/** Step 2: the manifest with the generated tools, and the icon. */
function writeManifest(version: string): Manifest {
  const manifest = releaseManifest(
    readJson(join(ROOT, "mcpb", "manifest.json")),
    version,
    manifestTools(ALL_TOOLS),
  );
  const problems = manifestProblems(manifest);
  if (problems.length > 0) fail(problems.join("\n"));
  writeFileSync(join(BUNDLE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(ROOT, "mcpb", "icon.png"), join(BUNDLE, "icon.png"));
  return manifest;
}

/** Starts the unpacked server as Claude Desktop would and returns the tools it lists. */
async function listToolsAsDesktop(
  dir: string,
  userConfig: McpbUserConfigValues,
): Promise<{ name: string; version: string; tools: string[] }> {
  const manifest = MANIFEST_SCHEMAS["0.3"].parse(readJson(join(dir, "manifest.json")));
  const config = await getMcpConfigForManifest({
    manifest,
    extensionPath: dir,
    systemDirs: { HOME: dir, DESKTOP: dir, DOCUMENTS: dir, DOWNLOADS: dir },
    userConfig,
    pathSeparator: sep,
  });
  if (config === undefined) fail("getMcpConfigForManifest returned no server config.");
  const env = config.env ?? {};
  const unresolved = [config.command, ...(config.args ?? []), ...Object.values(env)].filter(
    (value) => value.includes("${"),
  );
  if (unresolved.length > 0) {
    fail(`The host would pass unresolved placeholders: ${unresolved.join(", ")}`);
  }
  if (config.command !== "node") fail(`Expected the command "node", got ${config.command}.`);
  const args = config.args ?? [];

  // Claude Desktop runs "node" with its own runtime; here the one running this script.
  const cliVersion = execFileSync(process.execPath, [...args, "--version"], {
    encoding: "utf8",
    cwd: dir,
  }).trim();
  const client = new Client({ name: "mcpb-smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args,
      env: { ...getDefaultEnvironment(), ...env, SEVDESK_BASE_URL: UNREACHABLE_BASE_URL },
      cwd: dir,
      stderr: "inherit",
    }),
  );
  try {
    const info = client.getServerVersion();
    if (info?.name !== manifest.name || info.version !== manifest.version) {
      fail(
        `The server reports ${String(info?.name)} ${String(info?.version)}, the manifest ${manifest.name} ${manifest.version}.`,
      );
    }
    if (cliVersion !== manifest.version) {
      fail(`--version printed ${cliVersion}, the manifest says ${manifest.version}.`);
    }
    const { tools } = await client.listTools();
    return { name: info.name, version: info.version, tools: tools.map((tool) => tool.name).sort() };
  } finally {
    await client.close();
  }
}

/** Step 5: the packed file, unpacked and started twice. */
async function smoke(mcpbPath: string, manifest: Manifest): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mcpb-smoke-"));
  try {
    if (!(await unpackExtension({ mcpbPath, outputDir: dir, silent: true }))) {
      fail(`Could not unpack ${mcpbPath}.`);
    }
    const declared = (manifest["tools"] as readonly { name: string }[])
      .map((tool) => tool.name)
      .sort();

    const defaults = await listToolsAsDesktop(dir, { api_token: DUMMY_TOKEN });
    const undeclared = defaults.tools.filter((tool) => !declared.includes(tool));
    if (defaults.tools.length === 0 || undeclared.length > 0) {
      fail(
        `With the default settings the server listed ${defaults.tools.length} tools; not in the manifest: ${undeclared.join(", ") || "none"}.`,
      );
    }

    const folder = mkdtempSync(join(tmpdir(), "mcpb-smoke-folder-"));
    try {
      const widest = await listToolsAsDesktop(dir, {
        api_token: DUMMY_TOKEN,
        allow: "all",
        toolsets: "all",
        file_dir: folder,
        output_dir: folder,
        audit_log: join(folder, "sevdesk.jsonl"),
      });
      if (JSON.stringify(widest.tools) !== JSON.stringify(declared)) {
        const missing = declared.filter((tool) => !widest.tools.includes(tool));
        const extra = widest.tools.filter((tool) => !declared.includes(tool));
        fail(
          `With every tier and toolset the server's tools differ from the manifest's: missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}.`,
        );
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    console.log(
      `smoke: ok, ${defaults.name} ${defaults.version}: ${defaults.tools.length} tools by default, ${declared.length} with every tier and toolset`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { version } = readJson(join(ROOT, "package.json"));
  if (typeof version !== "string") fail("package.json has no version.");

  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(BUNDLE, { recursive: true });
  const bundled = await bundleServer(version);
  const manifest = writeManifest(version);

  if (!validateManifest(BUNDLE)) fail("mcpb validate rejected build/mcpb/manifest.json.");
  const mcpbPath = join(ROOT, "build", `mcp-server-sevdesk-${version}.mcpb`);
  rmSync(mcpbPath, { force: true });
  if (!(await packExtension({ extensionPath: BUNDLE, outputPath: mcpbPath }))) {
    fail("mcpb pack failed.");
  }

  await smoke(mcpbPath, manifest);
  const size = (statSync(mcpbPath).size / 1024 / 1024).toFixed(2);
  console.log(`mcpb: ${mcpbPath} (${size} MB, ${bundled} bundled packages)`);
}

// A hung server must not hang CI. Unref'd, so a finished run exits at once.
setTimeout(() => {
  console.error(`mcpb: timed out after ${TIMEOUT_MS / 1000} s`);
  process.exit(1);
}, TIMEOUT_MS).unref();

try {
  await main();
} catch (error) {
  console.error(`mcpb: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
