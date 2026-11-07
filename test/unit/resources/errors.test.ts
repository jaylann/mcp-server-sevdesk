import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { resourceReadError } from "../../../src/resources/errors.js";
import { SevdeskError, type SevdeskErrorKind } from "../../../src/sevdesk/errors.js";
import { TEST_TOKEN } from "../../helpers/config.js";

const URI = "sevdesk://invoices/12/pdf";
const config = { token: TEST_TOKEN };

function sevdeskError(kind: SevdeskErrorKind, status?: number): SevdeskError {
  return new SevdeskError({
    kind,
    message: `trusted ${kind} message`,
    ...(status === undefined ? {} : { status }),
    upstreamMessage: "UNTRUSTED upstream text",
  });
}

describe("resourceReadError", () => {
  it("maps not_found to ResourceNotFoundError with the trusted message", () => {
    const error = resourceReadError(sevdeskError("not_found", 404), URI, "invoice_pdf 12", config);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error.message).toBe("trusted not_found message");
    expect((error as ResourceNotFoundError).uri).toBe(URI);
  });

  it("maps local validation to invalid params and sevDesk validation to an internal error", () => {
    const local = resourceReadError(sevdeskError("validation"), URI, "x", config);
    const upstream = resourceReadError(sevdeskError("validation", 400), URI, "x", config);
    expect(local.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(upstream.code).toBe(ProtocolErrorCode.InternalError);
  });

  it.each(["auth", "rate_limited", "network", "timeout", "aborted", "blocked"] as const)(
    "maps %s to an internal error with the trusted message only",
    (kind) => {
      const error = resourceReadError(sevdeskError(kind), URI, "x", config);
      expect(error.code).toBe(ProtocolErrorCode.InternalError);
      expect(error.message).toBe(`trusted ${kind} message`);
      expect(error.message).not.toContain("UNTRUSTED");
    },
  );

  it.each(["unexpected_response", "server"] as const)("logs %s errors to stderr", (kind) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = resourceReadError(sevdeskError(kind, 500), URI, "invoice_pdf 12", config);
    expect(error.code).toBe(ProtocolErrorCode.InternalError);
    expect(stderr).toHaveBeenCalledWith(
      `mcp-server-sevdesk: resource invoice_pdf 12: ${kind} error: trusted ${kind} message`,
    );
  });

  it("passes protocol errors through", () => {
    const original = new ProtocolError(ProtocolErrorCode.InvalidParams, "bad");
    expect(resourceReadError(original, URI, "x", config)).toBe(original);
  });

  it("hides internal errors from the client and redacts the token in the log", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = resourceReadError(
      new Error(`boom with ${TEST_TOKEN} and ${"f".repeat(32)}`),
      URI,
      "invoice_pdf 12",
      config,
    );
    expect(error.code).toBe(ProtocolErrorCode.InternalError);
    expect(error.message).toMatch(/^Internal error in mcp-server-sevdesk while reading/);
    expect(error.message).not.toContain("boom");
    const logged = stderr.mock.calls.flat().join("\n");
    expect(logged).toContain("boom with [REDACTED] and [REDACTED]");
    expect(logged).not.toContain(TEST_TOKEN);
  });

  it("handles thrown non-errors", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resourceReadError("plain string", URI, "x", config);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("internal error: plain string"));
  });
});
