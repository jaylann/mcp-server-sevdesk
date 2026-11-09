/**
 * The confirmation and audit state one server factory shares across all the instances it builds
 * (`serveStdio`: one per connection; `createMcpHandler`: one per HTTP request) and, in OAuth
 * mode, across every account it serves. Elicitation rounds and browser approvals are therefore
 * recognized whichever instance serves the retry, as long as the same process does: the HMAC key
 * and the nonce and approval stores live in memory only.
 *
 * Principals stay apart (see `RequestPrincipal`): a signed elicitation state is bound to the
 * method, the OAuth client, the grant and the account, so it is refused when presented by anyone
 * else; browser approvals are owned by grant and account (`approval-store.ts`).
 */
import { randomBytes } from "node:crypto";

import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import { z } from "zod";

import { requestPrincipal } from "../accounts/types.js";
import type { Config, Deployment, Settings } from "../config.js";
import { createLocalApprovalChannel } from "./approval-local.js";
import { createApprovalStore } from "./approval-store.js";
import type { ApprovalChannel, ApprovalStore } from "./approval-types.js";
import { type AuditLog, auditPrincipal, createAuditLog } from "./audit.js";
import { createNonceStore, type NonceStore } from "./nonces.js";
import { openInBrowser, type OpenUrl } from "./open-url.js";

/** How long an elicitation round (signed state and nonce) stays valid. */
export const CONFIRMATION_TTL_SECONDS = 600;

/**
 * The payload of the signed `requestState` of an elicitation round. Signed, not encrypted: the
 * client can read it, so it holds hashes and random ids only.
 */
export const confirmStateSchema = z.strictObject({
  v: z.literal(1),
  tool: z.string(),
  argsHash: z.string(),
  previewHash: z.string(),
  nonce: z.string(),
  callId: z.string(),
});

export type ConfirmState = z.output<typeof confirmStateSchema>;

export interface SafetyRuntime {
  /** Seals and verifies elicitation `requestState` (wired as `ServerOptions.requestState.verify`). */
  readonly codec: RequestStateCodec<ConfirmState>;
  /** Single-use nonces of elicitation rounds. */
  readonly nonces: NonceStore;
  /** Browser approvals, presented through the runtime's approval channel. */
  readonly approvals: ApprovalStore;
  readonly audit: AuditLog;
  /** Forgets the approvals and closes the channel (stops the local approval server, if started). */
  close(): Promise<void>;
}

/**
 * What the runtime reads from the configuration: a {@link Config} (stdio, bearer) or the process
 * {@link Settings} (OAuth mode, where each account brings its own token to each audit line).
 */
export type SafetyRuntimeConfig = Pick<Settings, "auditLogPath" | "confirmOpen"> & {
  /** Redacted from every audit line (the fixed account's token). */
  readonly token?: string | undefined;
  readonly account?: Config["account"];
  /**
   * Where requests without an OAuth grant come from (default stdio): decides their principal in
   * the elicitation binding.
   */
  readonly deployment?: Deployment | undefined;
};

export interface SafetyRuntimeOptions {
  /** Epoch milliseconds for nonces and approvals; injectable for tests. */
  readonly now?: () => number;
  /** Wall clock for audit timestamps; injectable for tests. */
  readonly auditNow?: () => Date;
  /**
   * How new browser approvals reach the human. Default: the local 127.0.0.1 page
   * (`approval-local.ts`), for stdio. The HTTP mode passes the approvals inbox channel.
   */
  readonly approvalChannel?: ApprovalChannel;
  /** Default local channel only: opens pages when `confirmOpen` is set (default: the OS opener). */
  readonly openUrl?: OpenUrl;
  /** Default local channel only: receives the approval-page log lines (default: stderr). */
  readonly log?: (line: string) => void;
}

const STDIO: Deployment = { kind: "stdio" };

/** Creates the runtime for `config`; the HMAC key is 32 fresh random bytes. */
export function createSafetyRuntime(
  config: SafetyRuntimeConfig,
  options: SafetyRuntimeOptions = {},
): SafetyRuntime {
  const audit = createAuditLog({
    path: config.auditLogPath,
    secrets: config.token === undefined ? [] : [config.token],
    ...(options.auditNow === undefined ? {} : { now: options.auditNow }),
  });
  const channel =
    options.approvalChannel ??
    createLocalApprovalChannel({
      ...(config.confirmOpen ? { openUrl: options.openUrl ?? openInBrowser } : {}),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  const approvals = createApprovalStore({
    channel,
    ...(options.now === undefined ? {} : { now: options.now }),
    onDecision: ({ owner, binding, reference, decision }) => {
      audit
        .record({
          event: "approval_decided",
          ...auditPrincipal(owner),
          callId: binding.callId,
          tool: binding.toolName,
          tier: binding.tier,
          argsHash: binding.argsHash,
          previewHash: binding.previewHash,
          reference,
          decision,
        })
        .catch((error: unknown) => {
          console.error(
            `mcp-server-sevdesk: ${binding.toolName}: audit log: could not write the ` +
              `approval_decided line: ${error instanceof Error ? error.name : "unknown error"}`,
          );
        });
    },
  });
  const scope = { account: config.account, deployment: config.deployment ?? STDIO };
  return {
    codec: createRequestStateCodec<ConfirmState>({
      key: new Uint8Array(randomBytes(32)),
      ttlSeconds: CONFIRMATION_TTL_SECONDS,
      // Binds a state to the method and the principal (OAuth client, grant, account), so it can
      // be replayed neither into another method nor by another connection or account. The client
      // id alone is shared by every user of one OAuth client (e.g. all claude.ai users).
      bind: (ctx) => {
        const authInfo = ctx.http?.authInfo;
        const { grantKey, accountScope } = requestPrincipal(authInfo, scope);
        return JSON.stringify([
          ctx.mcpReq.method,
          authInfo?.clientId ?? "",
          grantKey,
          accountScope,
        ]);
      },
    }),
    nonces: createNonceStore({
      ttlMs: CONFIRMATION_TTL_SECONDS * 1000,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    approvals,
    audit,
    close: () => approvals.close(),
  };
}
