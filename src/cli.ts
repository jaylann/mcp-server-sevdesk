/**
 * Command-line parsing for `mcp-server-sevdesk`. Hand-written (no dependency): a few commands and
 * flags, unknown input is a usage error (exit code 2) instead of being ignored, so a typo such as
 * `--htttp` cannot silently start the stdio server.
 */
import { PACKAGE_NAME, VERSION } from "./version.js";

export type Command =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "serve"; readonly transport: "stdio" | "http" }
  | { readonly kind: "grants-list"; readonly json: boolean }
  | {
      readonly kind: "grants-revoke";
      readonly target:
        { readonly grantId: string } | { readonly accountId: string } | { readonly all: true };
    }
  | { readonly kind: "generate-secret" }
  | { readonly kind: "account-id" }
  | { readonly kind: "healthcheck" };

/** A command line that could not be parsed; print `message` and {@link HELP}, exit 2. */
export interface UsageError {
  readonly kind: "usage-error";
  readonly message: string;
}

export const HELP = `${PACKAGE_NAME} ${VERSION}
MCP server for the sevDesk accounting API (unofficial).

Usage:
  ${PACKAGE_NAME} [--stdio]              Serve MCP over stdio (configure it in your MCP client)
  ${PACKAGE_NAME} --http                 Serve MCP over Streamable HTTP (needs SEVDESK_HTTP_AUTH)
  ${PACKAGE_NAME} grants list [--json]   List OAuth grants (needs SEVDESK_HTTP_STATE_DIR)
  ${PACKAGE_NAME} grants revoke <id>     Revoke one grant (or --account <id>, or --all)
  ${PACKAGE_NAME} generate-secret        Print a random value for SEVDESK_HTTP_SECRET
  ${PACKAGE_NAME} account-id             Print the account id of SEVDESK_API_TOKEN
  ${PACKAGE_NAME} healthcheck            Check the local HTTP server (for container health checks)
  ${PACKAGE_NAME} --version              Print the version
  ${PACKAGE_NAME} --help                 Print this help

Docs: https://github.com/jaylann/mcp-server-sevdesk#readme
`;

/** An OAuth grant id or account id: printable, no spaces, bounded. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parses `argv` (without `node` and the script path). */
export function parseArgs(argv: readonly string[]): Command | UsageError {
  const args = [...argv];
  if (args.length === 0) return { kind: "serve", transport: "stdio" };
  if (args.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
  if (args.some((arg) => arg === "--version" || arg === "-v")) return { kind: "version" };

  const [first, ...rest] = args;
  switch (first) {
    case "--stdio":
    case "--http":
      return rest.length === 0
        ? { kind: "serve", transport: first === "--http" ? "http" : "stdio" }
        : unexpected(rest[0]);
    case "generate-secret":
    case "account-id":
    case "healthcheck":
      return rest.length === 0 ? { kind: first } : unexpected(rest[0]);
    case "grants":
      return parseGrants(rest);
    default:
      return unexpected(first);
  }
}

function parseGrants(args: readonly string[]): Command | UsageError {
  const [action, ...rest] = args;
  if (action === "list") {
    if (rest.length === 0) return { kind: "grants-list", json: false };
    if (rest.length === 1 && rest[0] === "--json") return { kind: "grants-list", json: true };
    return unexpected(rest.find((arg) => arg !== "--json"));
  }
  if (action === "revoke") {
    if (rest.length === 1 && rest[0] === "--all") {
      return { kind: "grants-revoke", target: { all: true } };
    }
    if (rest.length === 2 && rest[0] === "--account") {
      const accountId = rest[1] ?? "";
      return ID.test(accountId)
        ? { kind: "grants-revoke", target: { accountId } }
        : usage("grants revoke --account needs an account id.");
    }
    if (rest.length === 1 && rest[0] !== undefined && !rest[0].startsWith("-")) {
      const grantId = rest[0];
      return ID.test(grantId)
        ? { kind: "grants-revoke", target: { grantId } }
        : usage("grants revoke needs a grant id as shown by `grants list`.");
    }
    return usage("Use: grants revoke <grant-id> | --account <account-id> | --all");
  }
  return usage("Use: grants list [--json] | grants revoke <grant-id> | --account <id> | --all");
}

function unexpected(arg: string | undefined): UsageError {
  // Arguments are echoed only as a safe excerpt: a pasted secret must not end up in a log.
  const shown = arg === undefined ? "" : /^[A-Za-z0-9_.-]{1,40}$/.test(arg) ? arg : "(value)";
  return usage(`Unknown argument: ${shown}`);
}

function usage(message: string): UsageError {
  return { kind: "usage-error", message };
}
