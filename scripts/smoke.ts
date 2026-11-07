/**
 * Package smoke test: runs an *installed* copy of the bin over stdio and checks the MCP handshake.
 * CI installs the `npm pack` tarball into a temp dir and points this script at it, so it catches
 * broken `files`/`bin` entries and missing runtime dependencies.
 *
 * The server gets a dummy token and an unreachable base URL, so it never contacts sevDesk: its
 * non-fatal startup check just logs a warning to stderr.
 *
 * Usage: pnpm exec tsx scripts/smoke.ts <path-to-installed>/dist/index.js
 * Exit codes: 0 ok, 1 failure, 2 usage error.
 */
import { execFileSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const EXPECTED_NAME = "mcp-server-sevdesk";
const TIMEOUT_MS = 30_000;
const SERVER_ENV = {
  ...getDefaultEnvironment(),
  SEVDESK_API_TOKEN: "0".repeat(32),
  // Port 9 (discard) on loopback: connection refused immediately, nothing leaves the machine.
  SEVDESK_BASE_URL: "https://127.0.0.1:9/api/v1",
};

const binPath = process.argv[2];
if (!binPath) {
  console.error("usage: smoke.ts <path-to-dist/index.js>");
  process.exit(2);
}

const timer = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS} ms`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const cliVersion = execFileSync(process.execPath, [binPath, "--version"], {
    encoding: "utf8",
  }).trim();

  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [binPath],
      env: SERVER_ENV,
      stderr: "inherit",
    }),
  );

  const info = client.getServerVersion();
  if (info?.name !== EXPECTED_NAME) {
    throw new Error(`expected server name ${EXPECTED_NAME}, got ${String(info?.name)}`);
  }
  if (info.version !== cliVersion) {
    throw new Error(`--version printed ${cliVersion} but the server reports ${info.version}`);
  }
  const { tools } = await client.listTools();
  if (tools.length === 0) {
    throw new Error("the server listed no tools");
  }
  await client.close();

  console.log(`smoke: ok, ${info.name} ${info.version}, ${tools.length} tools`);
  clearTimeout(timer);
} catch (error) {
  console.error("smoke: failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
