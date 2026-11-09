#!/usr/bin/env node
/**
 * CLI entry point (`mcp-server-sevdesk`). Serves MCP over stdio by default, or over Streamable
 * HTTP with `--http`; see `src/cli.ts` for the commands.
 *
 * stdout belongs to the MCP transport in stdio mode: everything else (diagnostics, errors) goes
 * to stderr. Utility commands (`generate-secret`, `grants list`, …) print their result to stdout.
 */
import { readFileSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createIdentityLookup } from "./accounts/identity.js";
import { IdentityError } from "./accounts/types.js";
import { HELP, parseArgs } from "./cli.js";
import {
  type Config,
  ConfigError,
  type Env,
  loadConfig,
  readSecret,
  readSettings,
  sevdeskTokenProblem,
} from "./config.js";
import { runGrantsCommand } from "./grants-cli.js";
import { runHealthcheck } from "./http/healthcheck.js";
import { generateSecret } from "./http/keys.js";
import { StateDirError } from "./http/oauth/index.js";
import { runHttp } from "./http/run.js";
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
      void runHttp({ env: process.env }).catch(fail);
      return;
    case "grants-list":
    case "grants-revoke":
      void runGrantsCommand(command, process.env).then(exitWith, fail);
      return;
    case "account-id":
      void printAccountId(process.env).then(exitWith, fail);
      return;
    case "healthcheck":
      void runHealthcheck(process.env).then(exitWith, fail);
      return;
  }
}

/** Prints the usage problem and the help, then exits with code 2. */
function usageExit(message: string): never {
  process.stderr.write(`${PACKAGE_NAME}: ${message}\n\n${HELP}`);
  process.exit(2);
}

function exitWith(code: number): void {
  process.exit(code);
}

/**
 * Reports a startup failure and exits 1. Configuration and state-directory problems are trusted
 * text without secrets; anything else is reported by name only.
 */
function fail(error: unknown): void {
  const message =
    error instanceof ConfigError || error instanceof StateDirError
      ? error.message
      : `unexpected error (${error instanceof Error ? error.name : "unknown"}); see the docs for ` +
        "the configuration, or report it at https://github.com/jaylann/mcp-server-sevdesk/issues.";
  console.error(`${PACKAGE_NAME}: ${message}`);
  process.exit(1);
}

/** `account-id`: the `SevClient` id of `SEVDESK_API_TOKEN`, for `SEVDESK_OAUTH_ACCOUNTS`. */
async function printAccountId(env: Env): Promise<number> {
  const problems: string[] = [];
  const token = readSecret(
    env,
    "SEVDESK_API_TOKEN",
    (path) => readFileSync(path, "utf8"),
    problems,
    {
      required: true,
      validate: (value) => sevdeskTokenProblem(value),
    },
  );
  const settings = readSettings(env, problems);
  if (token === undefined || problems.length > 0) throw new ConfigError(problems);
  try {
    const identity = await createIdentityLookup(settings)(token, AbortSignal.timeout(15_000));
    process.stdout.write(`${identity.accountId}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    console.error(`${PACKAGE_NAME}: ${error.message}`);
    return 1;
  }
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
