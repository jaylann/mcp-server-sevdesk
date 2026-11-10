/**
 * The stdio server for an invalid configuration. A client that hides the server's stderr (Claude
 * Desktop shows only "Server disconnected" when the process exits) would leave the user without
 * the reason, so over stdio the server starts anyway: no sevDesk tool, no request to sevDesk, the
 * problems in its instructions and in one tool, `sevdesk_setup_problem`, that the model can call
 * to tell the user what to fix. The HTTP mode still refuses to start (operators read its log).
 *
 * The problems are trusted text from `src/config.ts` and the profile and keychain readers: they
 * name settings, never the token.
 */
import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { z } from "zod";

import { SERVER_INFO } from "./server.js";

/** The one tool of a server that could not load its configuration. */
export const SETUP_PROBLEM_TOOL = "sevdesk_setup_problem";

/** What the user is told to do, for every client. */
function remedy(): string {
  return (
    "Fix the setting in the MCP client's configuration of this server (in the Claude Desktop " +
    "extension: Settings → Extensions → sevDesk → Configure), then restart the server. Until " +
    "then no sevDesk tool is available and nothing is sent to sevDesk."
  );
}

/** The full explanation: the problems as a list, then the remedy. */
function setupProblemText(problems: readonly string[]): string {
  return (
    "mcp-server-sevdesk could not start: its configuration is invalid.\n" +
    `${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
    remedy()
  );
}

/** A factory for {@link serveStdio} whose instances only explain `problems`. */
export function createSetupProblemFactory(problems: readonly string[]): McpServerFactory {
  const text = setupProblemText(problems);
  return () => {
    const server = new McpServer(SERVER_INFO, {
      capabilities: { tools: { listChanged: false } },
      instructions:
        `${text}\nTell the user this before anything else; call ${SETUP_PROBLEM_TOOL} to ` +
        "read it again.",
    });
    server.registerTool(
      SETUP_PROBLEM_TOOL,
      {
        title: "Show the setup problem",
        description:
          "The sevDesk server could not load its configuration and offers no sevDesk tools. " +
          "Returns what is wrong and which setting the user has to fix. Reads nothing from " +
          "sevDesk.",
        inputSchema: z.object({}),
        annotations: {
          title: "Show the setup problem",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      () => ({ content: [{ type: "text", text }] }),
    );
    return server;
  };
}
