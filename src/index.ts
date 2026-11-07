#!/usr/bin/env node
/**
 * CLI entry point (`mcp-server-sevdesk`). Serves MCP over stdio by default.
 *
 * stdout belongs to the MCP transport: everything else (diagnostics, errors) goes to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { type Config, loadConfig } from "./config.js";
import { redactSecrets } from "./safety/redact.js";
import { createServerFactory } from "./server.js";
import { createSevdeskClient } from "./sevdesk/client.js";
import { checkConnection } from "./startup.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

const HELP = `${PACKAGE_NAME} ${VERSION}
MCP server for the sevDesk accounting API (unofficial).

Usage:
  ${PACKAGE_NAME}            Serve MCP over stdio (configure it in your MCP client)
  ${PACKAGE_NAME} --version  Print the version
  ${PACKAGE_NAME} --help     Print this help

Docs: https://github.com/jaylann/mcp-server-sevdesk#readme
`;

function main(argv: readonly string[]): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // ConfigError lists every problem; it never contains the token.
    console.error(`${PACKAGE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const client = createSevdeskClient(config);
  const log = (line: string): void => {
    console.error(`${PACKAGE_NAME}: ${redactSecrets(line, [config.token])}`);
  };
  // Non-fatal by design; see checkConnection.
  void checkConnection(client, config, log);

  const factory = createServerFactory({ config, client });
  const handle = serveStdio(factory, {
    onerror: (error) => {
      log(error.message);
    },
  });

  // Also stops the local approval page (SEVDESK_CONFIRM=browser), if it was started; its server
  // is unref'd, so it never keeps the process alive on its own.
  const shutdown = (): void => {
    Promise.all([handle.close(), factory.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main(process.argv.slice(2));
