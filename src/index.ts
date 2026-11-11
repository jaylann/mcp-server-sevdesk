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
import { loadLocalConfig } from "./accounts/local-config.js";
import { IdentityError } from "./accounts/types.js";
import { HELP, parseArgs } from "./cli.js";
import { checkSettingNames, ConfigError, type Env } from "./config.js";
import { runGrantsCommand } from "./grants-cli.js";
import { runHealthcheck } from "./http/healthcheck.js";
import { generateSecret } from "./http/keys.js";
import { StateDirError } from "./http/oauth/index.js";
import { runHttp } from "./http/run.js";
import { runProfilesCommand } from "./profiles-cli.js";
import { configuredSecrets, redactSecrets } from "./safety/redact.js";
import { createServerFactory } from "./server.js";
import { createSetupProblemFactory } from "./setup-problem.js";
import { createSevdeskClient } from "./sevdesk/client.js";
import { checkConnection } from "./startup.js";
import { runTokenCommand } from "./token-cli.js";
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
        void serveOverStdio().catch(fail);
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
    case "token":
      void runTokenCommand(command, process.env).then(exitWith, fail);
      return;
    case "profiles-list":
      void runProfilesCommand(process.env).then(exitWith, fail);
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
      ? withoutConfiguredSecrets(error.message)
      : `unexpected error (${error instanceof Error ? error.name : "unknown"}); see the docs for ` +
        "the configuration, or report it at https://github.com/jaylann/mcp-server-sevdesk/issues.";
  console.error(`${PACKAGE_NAME}: ${message}`);
  process.exit(1);
}

/**
 * `text` without the secrets the environment configures (`configuredSecrets`: values, rotation
 * members, `*_FILE` contents). A configuration problem quotes the value it rejects; when a secret
 * was pasted into the wrong setting, that value is the secret (security review 2026-11,
 * finding 8). `ConfigError` already redacts sevDesk-token-shaped values.
 */
function withoutConfiguredSecrets(text: string): string {
  return redactSecrets(
    text,
    configuredSecrets(process.env, (path) => readFileSync(path, "utf8")),
  );
}

/**
 * `account-id`: the `SevClient` id of the configured token (`SEVDESK_API_TOKEN`, its `_FILE`, the
 * keychain or a profile), for `SEVDESK_OAUTH_ACCOUNTS`.
 */
async function printAccountId(env: Env): Promise<number> {
  const { config, warnings } = await loadLocalConfig(env);
  for (const warning of [...warnings, ...checkSettingNames(env).warnings]) {
    console.error(`${PACKAGE_NAME}: warning: ${warning}`);
  }
  try {
    const identity = await createIdentityLookup(config)(config.token, AbortSignal.timeout(15_000));
    process.stdout.write(`${identity.accountId}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    console.error(`${PACKAGE_NAME}: ${error.message}`);
    return 1;
  }
}

/**
 * Serves stdio. A {@link ConfigError} (every problem, never the token) is printed to stderr and
 * then served by the setup-problem server (`src/setup-problem.ts`), so clients that hide stderr
 * still tell the user what to fix.
 */
async function serveOverStdio(): Promise<void> {
  // SEVDESK_* names nothing reads: a misspelt setting is a configuration problem (below); the
  // rest only gets a line here, names only (review 2026-11, round 3).
  const unknownNames = checkSettingNames(process.env).warnings;
  let loaded: Awaited<ReturnType<typeof loadLocalConfig>>;
  try {
    loaded = await loadLocalConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const warning of unknownNames) console.error(`${PACKAGE_NAME}: warning: ${warning}`);
    console.error(`${PACKAGE_NAME}: ${withoutConfiguredSecrets(error.message)}`);
    console.error(
      `${PACKAGE_NAME}: serving only the setup problem until the configuration is fixed`,
    );
    const handle = serveStdio(
      createSetupProblemFactory(error.problems.map((problem) => withoutConfiguredSecrets(problem))),
    );
    const stop = (): void => {
      handle.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  const { config, warnings } = loaded;
  const client = createSevdeskClient(config);
  const log = (line: string): void => {
    console.error(`${PACKAGE_NAME}: ${redactSecrets(line, [config.token])}`);
  };
  for (const warning of [...warnings, ...unknownNames]) log(`warning: ${warning}`);
  if (config.profile !== undefined) log(`using profile "${config.profile}"`);
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
