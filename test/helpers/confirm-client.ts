/**
 * Real SDK clients that answer confirmation prompts, for the write-flow tests.
 *
 * - `transport: "http"` serves through `createMcpHandler(...).fetch` (the HTTP mode's entry, one
 *   server instance per request). Modern clients get the multi-round-trip flow there; legacy
 *   clients cannot be asked at all (per-request legacy instances have no client capabilities).
 * - `transport: "stdio"` serves through `serveStdio` over an in-memory transport pair (the stdio
 *   entry, one instance pinned per connection). A legacy client there gets real
 *   `elicitation/create` requests from the SDK's legacy shim.
 *
 * In both eras the client's `elicitation/create` handler answers: on the modern era the client
 * auto-fulfils `input_required` results through it, on the legacy era the shim calls it.
 */
import {
  Client,
  type ElicitRequestFormParams,
  type ElicitResult,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type AuthInfo,
  createMcpHandler,
  InMemoryTransport,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** How the simulated human answers each prompt. */
export type Answer = (params: ElicitRequestFormParams) => ElicitResult | Promise<ElicitResult>;

export const approve: Answer = () => ({ action: "accept", content: { approve: true } });

export interface ConfirmConnectOptions {
  readonly era?: "modern" | "legacy";
  readonly transport?: "http" | "stdio";
  /** Declare `elicitation: { form: {} }` and answer prompts (default true). */
  readonly elicitation?: boolean;
  /** Default: approve every prompt. */
  readonly answer?: Answer;
  /** Manual multi-round-trip mode (modern era): `input_required` results are returned as they are. */
  readonly manual?: boolean;
  /**
   * `transport: "http"` only: passed to `handler.fetch` with every request, as the HTTP mode does
   * after authenticating it (bearer, or OAuth with a `VerifiedGrant`).
   */
  readonly authInfo?: AuthInfo;
}

export interface ConfirmHarness {
  readonly client: Client;
  /** Every prompt the client was shown, in order. */
  readonly prompts: ElicitRequestFormParams[];
  close(): Promise<void>;
}

export async function connectConfirming(
  factory: McpServerFactory,
  options: ConfirmConnectOptions = {},
): Promise<ConfirmHarness> {
  const era = options.era ?? "modern";
  const elicitation = options.elicitation ?? true;
  const answer = options.answer ?? approve;
  const prompts: ElicitRequestFormParams[] = [];
  const client = new Client(
    { name: "confirm-test-client", version: "0.0.0" },
    {
      ...(elicitation ? { capabilities: { elicitation: { form: {} } } } : {}),
      ...(era === "modern"
        ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
        : {}),
      ...(options.manual === true ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (elicitation) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as ElicitRequestFormParams;
      prompts.push(params);
      return answer(params);
    });
  }

  let closeServer: () => Promise<void> = () => Promise.resolve();
  if ((options.transport ?? "http") === "http") {
    const handler = createMcpHandler(factory);
    const { authInfo } = options;
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) =>
          handler.fetch(new Request(url, init), authInfo === undefined ? undefined : { authInfo }),
      }),
    );
  } else {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(factory, { transport: serverSide });
    closeServer = () => handle.close();
    await client.connect(clientSide);
  }

  return {
    client,
    prompts,
    async close() {
      await client.close();
      await closeServer();
    },
  };
}
