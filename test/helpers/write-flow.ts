/**
 * Shared setup for the MCP-level write-flow tests (`test/integration/write-*.test.ts`): a server
 * factory over a `FakeSevdeskClient` for one write-tool case, connected to a confirming client,
 * plus readers for the wrapped write result.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { afterEach } from "vitest";

import { GRANT_EXTRA_KEY, VerifiedGrant } from "../../src/accounts/types.js";
import type { Config, Deployment } from "../../src/config.js";
import {
  createSafetyRuntime,
  type SafetyRuntime,
  type SafetyRuntimeOptions,
} from "../../src/safety/runtime.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createServerFactory, type ServerFactory } from "../../src/server.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { allEnabledConfig } from "./config.js";
import {
  type ConfirmConnectOptions,
  type ConfirmHarness,
  connectConfirming,
} from "./confirm-client.js";
import { type FakeRoute, FakeSevdeskClient } from "./fake-client.js";

const cleanups: (() => Promise<void>)[] = [];

/** Registers the per-test cleanup; call once at the top level of a test file. */
export function closeWriteHarnessesAfterEach(): void {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });
}

export interface WriteHarness extends ConfirmHarness {
  readonly fake: FakeSevdeskClient;
  readonly factory: ServerFactory;
  readonly safety: SafetyRuntime;
  /** Lines the approval service logged (stderr in production). */
  readonly approvalLog: string[];
  /** URLs handed to the (fake) browser opener. */
  readonly openedUrls: string[];
  /** The URL of the newest approval page, as the human would find it (log or browser). */
  readonly lastApprovalUrl: () => string;
}

export interface WriteHarnessOptions {
  readonly tools: readonly AnyToolDefinition[];
  readonly routes: readonly FakeRoute[];
  readonly config?: Partial<Config>;
  readonly connect?: ConfirmConnectOptions;
  /** Clock and other runtime options; the log and the opener are always captured. */
  readonly safetyOptions?: SafetyRuntimeOptions;
  /**
   * Browser opener (`SEVDESK_CONFIRM_OPEN`): `"opens"` and `"fails"` turn it on with a fake that
   * reports success or failure; default off, as in `testConfig`. A real browser is never started.
   */
  readonly opener?: "opens" | "fails";
}

/** The launch link of a local approval page: a single-use ticket (`approval-local.ts`). */
const APPROVAL_URL = /http:\/\/127\.0\.0\.1:\d+\/open\/[A-Za-z0-9_-]{43}/;

/** A connected client against a server with exactly `tools`, every tier and toolset enabled. */
export async function writeHarness(options: WriteHarnessOptions): Promise<WriteHarness> {
  const fake = new FakeSevdeskClient(options.routes);
  const config = allEnabledConfig({
    ...(options.opener === undefined ? {} : { confirmOpen: true }),
    ...options.config,
  });
  const approvalLog: string[] = [];
  const openedUrls: string[] = [];
  const safety = createSafetyRuntime(config, {
    ...options.safetyOptions,
    log: (line) => approvalLog.push(line),
    openUrl: (url) => {
      openedUrls.push(url);
      return Promise.resolve(options.opener === "opens");
    },
  });
  const factory = createServerFactory({ config, client: fake, tools: options.tools, safety });
  const harness = await connectConfirming(factory, options.connect);
  cleanups.push(async () => {
    await harness.close();
    await factory.close();
  });
  const lastApprovalUrl = (): string => {
    const url = APPROVAL_URL.exec(approvalLog.at(-1) ?? "")?.[0];
    if (url === undefined) throw new Error("no approval page was logged");
    return url;
  };
  return { ...harness, fake, factory, safety, approvalLog, openedUrls, lastApprovalUrl };
}

/** The text of a result's first content block. */
export function resultText(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

/** The JSON data block of a successful result (after the summary line). */
export function resultData(result: CallToolResult): Record<string, unknown> {
  const text = resultText(result);
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as Record<string, unknown>;
}

/** The summary line of a successful result. */
export function resultSummary(result: CallToolResult): string {
  const text = resultText(result);
  return text.slice(0, text.indexOf("\n\n"));
}

/** Method and path of every data-changing request the fake client received. */
export function writesOf(fake: FakeSevdeskClient): { method: string; path: string }[] {
  return fake.writes().map(({ method, path }) => ({ method, path }));
}

/** The CIMD client id claude.ai uses: shared by every claude.ai user of one server. */
const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

/** An HTTP deployment as `loadHttpConfig` builds it (`approvalsUrl` with `SEVDESK_CONFIRM=browser`). */
export function httpDeployment(
  auth: "oauth" | "bearer",
  approvalsUrl: string | undefined = "https://mcp.example.com/approvals",
): Deployment {
  return { kind: "http", auth, publicOrigin: "https://mcp.example.com", approvalsUrl };
}

export interface GrantOptions {
  readonly accountId: string;
  /** The sevDesk token pasted at consent. */
  readonly token: string;
  readonly grantId?: string;
  readonly tiers?: readonly Tier[];
  readonly clientId?: string;
}

/**
 * The `AuthInfo` the OAuth verifier hands to the MCP handler: a `VerifiedGrant` in
 * `extra[GRANT_EXTRA_KEY]` (the grant id defaults to `grant-<accountId>`, the tiers to all).
 */
export function grantAuthInfo(options: GrantOptions): AuthInfo {
  const tiers = options.tiers ?? ["read", "write", "commit", "external"];
  const clientId = options.clientId ?? CLAUDE_CLIENT_ID;
  return {
    token: "sdmcp_at.test",
    clientId,
    scopes: [...tiers],
    extra: {
      [GRANT_EXTRA_KEY]: new VerifiedGrant(
        {
          grantId: options.grantId ?? `grant-${options.accountId}`,
          accountId: options.accountId,
          clientId,
          tiers: new Set(tiers),
        },
        options.token,
      ),
    },
  };
}
