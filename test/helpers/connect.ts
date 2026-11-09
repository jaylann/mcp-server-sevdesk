import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  type AuthInfo,
  createMcpHandler,
  type McpServerFactory,
  type ProtocolEra,
} from "@modelcontextprotocol/server";

import { createServerFactory, type ServerDeps } from "../../src/server.js";
import { testConfig } from "./config.js";
import { stubClient } from "./dummy-tools.js";

/** The modern protocol revision the test client pins. */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

export interface ConnectOptions {
  /**
   * Protocol era the client speaks: `modern` (default) pins 2026-07-28 via `server/discover`;
   * `legacy` runs the 2025 `initialize` handshake, which is the SDK client's own default and
   * what today's Claude clients speak.
   */
  readonly era?: ProtocolEra;
  /**
   * Passed to `handler.fetch` with every request, as the HTTP mode does after authenticating it
   * (bearer or OAuth). Absent: an unauthenticated request, as over stdio.
   */
  readonly authInfo?: AuthInfo;
}

/**
 * Connects a real SDK client to the server in process, through the stateless HTTP handler
 * (`createMcpHandler(...).fetch`, the same entry the HTTP mode uses). No sockets. `deps` default
 * to {@link testConfig} and a {@link stubClient}; `tools` defaults to the shipped catalog.
 */
export async function connectInProcess(
  deps: Partial<ServerDeps> = {},
  options: ConnectOptions = {},
): Promise<Client> {
  const factory = createServerFactory({
    config: deps.config ?? testConfig(),
    client: deps.client ?? stubClient(),
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
  });
  return connectFactory(factory, options);
}

/** Like {@link connectInProcess}, for a hand-built server factory. */
export async function connectFactory(
  factory: McpServerFactory,
  options: ConnectOptions = {},
): Promise<Client> {
  const handler = createMcpHandler(factory);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    options.era === "legacy"
      ? {}
      : { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) =>
        handler.fetch(
          new Request(url, init),
          options.authInfo === undefined ? undefined : { authInfo: options.authInfo },
        ),
    }),
  );
  return client;
}
