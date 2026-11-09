#!/usr/bin/env node
/**
 * CLI entry point (`mcp-server-sevdesk`). Serves MCP over stdio by default, or over Streamable
 * HTTP with `--http`; see `src/cli.ts` for the commands.
 *
 * stdout belongs to the MCP transport in stdio mode: everything else (diagnostics, errors) goes
 * to stderr. Utility commands (`generate-secret`, `grants list`, …) print their result to stdout.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { HELP, parseArgs } from "./cli.js";
import { type Config, loadConfig } from "./config.js";
import { generateSecret } from "./http/keys.js";
import { redactSecrets } from "./safety/redact.js";
import { createServerFactory } from "./server.js";
import { createSevdeskClient } from "./sevdesk/client.js";
import { checkConnection } from "./startup.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

function main(argv: readonly string[]): void {
  const command = parseArgs(argv);
  switch (command.kind) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "help":
      process.stdout.write(HELP);
      return;
    case "usage-error":
      return usageExit(command.message);
    case "generate-secret":
      process.stdout.write(`${generateSecret()}\n`);
      return;
    case "serve":
      if (command.transport === "stdio") {
        serveOverStdio();
        return;
      }
      notYet("--http");
      return;
    case "grants-list":
    case "grants-revoke":
      notYet("grants");
      return;
    case "account-id":
    case "healthcheck":
      notYet(command.kind);
      return;
  }
}

/** Prints the usage problem and the help, then exits with code 2. */
function usageExit(message: string): never {
  process.stderr.write(`${PACKAGE_NAME}: ${message}\n\n${HELP}`);
  process.exit(2);
}

/** Placeholder until the HTTP mode is wired (M5 integration). */
function notYet(what: string): void {
  process.stderr.write(`${PACKAGE_NAME}: ${what} is not available in this build yet.\n`);
  process.exit(1);
}

function serveOverStdio(): void {
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
