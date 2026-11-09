/**
 * Command-line parsing for `mcp-server-sevdesk`. Hand-written (no dependency): a few commands and
 * flags, unknown input is a usage error (exit code 2) instead of being ignored, so a typo such as
 * `--http2` cannot silently start the stdio server.
 */
import { localNameProblem, looksLikeToken } from "./config.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

/** What `token <action> <label>` does with the OS keychain item of `label`. */
type TokenAction = "set" | "check" | "delete";

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
  | { readonly kind: "healthcheck" }
  | { readonly kind: "token"; readonly action: TokenAction; readonly label: string }
  | { readonly kind: "profiles-list" };

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
  ${PACKAGE_NAME} generate-secret        Print a random value for SEVDESK_HTTP_SECRET or a bearer secret
  ${PACKAGE_NAME} account-id             Print the account id of the configured sevDesk token
  ${PACKAGE_NAME} healthcheck            Check the local HTTP server (for container health checks)
  ${PACKAGE_NAME} token set <label>      Store a sevDesk token in the OS keychain (asks for it)
  ${PACKAGE_NAME} token check <label>    Check the token stored under <label> with sevDesk
  ${PACKAGE_NAME} token delete <label>   Delete the token stored under <label>
  ${PACKAGE_NAME} profiles list          List the profiles of the profiles file
  ${PACKAGE_NAME} --version, -v          Print the version
  ${PACKAGE_NAME} --help, -h             Print this help

Docs: https://sevdesk-mcp.lanfermann.dev/docs/en/configuration#command-line
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
    case "token":
      return parseToken(rest);
    case "profiles":
      return rest.length === 1 && rest[0] === "list"
        ? { kind: "profiles-list" }
        : usage("Use: profiles list");
    default:
      return unexpected(first);
  }
}

/**
 * `token set|check|delete <label>`. The token itself never comes from the command line, where it
 * would stay in the shell history and be visible in the process list: `set` reads it from stdin.
 */
function parseToken(args: readonly string[]): Command | UsageError {
  const [action, label, ...extra] = args;
  if (action !== "set" && action !== "check" && action !== "delete") {
    return usage("Use: token set <label> | token check <label> | token delete <label>");
  }
  if (label === undefined) return usage(`token ${action} needs a label, for example: work`);
  if (extra.length > 0) {
    return usage(
      action === "set"
        ? "token set takes only a label and asks for the token (or reads it from stdin); never " +
            "put the token on the command line, where it stays in your shell history."
        : `token ${action} takes only a label.`,
    );
  }
  const problem = localNameProblem(label, "The label");
  return problem === undefined ? { kind: "token", action, label } : usage(problem);
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
  const shown =
    arg === undefined
      ? ""
      : /^[A-Za-z0-9_.-]{1,40}$/.test(arg) && !looksLikeToken(arg)
        ? arg
        : "(value)";
  return usage(`Unknown argument: ${shown}`);
}

function usage(message: string): UsageError {
  return { kind: "usage-error", message };
}
