/**
 * The confirmation and audit state one server factory shares across all the instances it builds
 * (`serveStdio`: one per connection; `createMcpHandler`: one per HTTP request). Elicitation
 * rounds and browser approvals are therefore recognized whichever instance serves the retry, as
 * long as the same process does: the HMAC key and the nonce store live in memory only.
 */
import { randomBytes } from "node:crypto";

import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config.js";
import { type ApprovalService, createApprovalService } from "./approval-server.js";
import { type AuditLog, createAuditLog } from "./audit.js";
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
  /** Pending browser approvals and the lazily started local approval server. */
  readonly approvals: ApprovalService;
  readonly audit: AuditLog;
  /** Stops the approval server, if it was started. */
  close(): Promise<void>;
}

export interface SafetyRuntimeOptions {
  /** Epoch milliseconds for nonces and approvals; injectable for tests. */
  readonly now?: () => number;
  /** Wall clock for audit timestamps; injectable for tests. */
  readonly auditNow?: () => Date;
  /** Opens approval pages when `config.confirmOpen` is set (default: the OS opener). */
  readonly openUrl?: OpenUrl;
  /** Receives the approval-page log lines (default: stderr). */
  readonly log?: (line: string) => void;
}

/** Creates the runtime for `config`; the HMAC key is 32 fresh random bytes. */
export function createSafetyRuntime(
  config: Pick<Config, "auditLogPath" | "token" | "confirmOpen">,
  options: SafetyRuntimeOptions = {},
): SafetyRuntime {
  const audit = createAuditLog({
    path: config.auditLogPath,
    secrets: [config.token],
    ...(options.auditNow === undefined ? {} : { now: options.auditNow }),
  });
  const approvals = createApprovalService({
    ...(options.now === undefined ? {} : { now: options.now }),
    onDecision: ({ binding, reference, decision }) => {
      audit
        .record({
          event: "approval_decided",
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
    ...(config.confirmOpen ? { openUrl: options.openUrl ?? openInBrowser } : {}),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return {
    codec: createRequestStateCodec<ConfirmState>({
      key: new Uint8Array(randomBytes(32)),
      ttlSeconds: CONFIRMATION_TTL_SECONDS,
      // Binds a state to the method and, in authenticated HTTP mode, to the OAuth client, so it
      // cannot be replayed into another method or by another principal.
      bind: (ctx) => `${ctx.mcpReq.method}:${ctx.http?.authInfo?.clientId ?? ""}`,
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
