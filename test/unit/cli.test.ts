import { describe, expect, it } from "vitest";

import { HELP, parseArgs } from "../../src/cli.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("parseArgs", () => {
  it("serves stdio by default and on --stdio", () => {
    expect(parseArgs([])).toEqual({ kind: "serve", transport: "stdio" });
    expect(parseArgs(["--stdio"])).toEqual({ kind: "serve", transport: "stdio" });
  });

  it("serves HTTP on --http", () => {
    expect(parseArgs(["--http"])).toEqual({ kind: "serve", transport: "http" });
  });

  it("prints help or the version wherever the flag appears", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--http", "-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["grants", "--version"])).toEqual({ kind: "version" });
  });

  it("parses the utility commands", () => {
    expect(parseArgs(["generate-secret"])).toEqual({ kind: "generate-secret" });
    expect(parseArgs(["account-id"])).toEqual({ kind: "account-id" });
    expect(parseArgs(["healthcheck"])).toEqual({ kind: "healthcheck" });
  });

  it("parses grants commands", () => {
    expect(parseArgs(["grants", "list"])).toEqual({ kind: "grants-list", json: false });
    expect(parseArgs(["grants", "list", "--json"])).toEqual({ kind: "grants-list", json: true });
    expect(parseArgs(["grants", "revoke", "abc_-1"])).toEqual({
      kind: "grants-revoke",
      target: { grantId: "abc_-1" },
    });
    expect(parseArgs(["grants", "revoke", "--account", "123"])).toEqual({
      kind: "grants-revoke",
      target: { accountId: "123" },
    });
    expect(parseArgs(["grants", "revoke", "--all"])).toEqual({
      kind: "grants-revoke",
      target: { all: true },
    });
  });

  it("refuses unknown and malformed input", () => {
    expect(parseArgs(["--http2"])).toMatchObject({
      kind: "usage-error",
      message: "Unknown argument: --http2",
    });
    expect(parseArgs(["--http", "extra"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["grants"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["grants", "revoke"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["grants", "revoke", "a b"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["grants", "revoke", "--account"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["grants", "list", "--csv"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["generate-secret", "now"])).toMatchObject({ kind: "usage-error" });
  });

  it("never echoes a value that looks like a secret", () => {
    const result = parseArgs(["0123456789abcdef0123456789abcdef0123456789abcdef"]);
    expect(result).toEqual({ kind: "usage-error", message: "Unknown argument: (value)" });
    expect(parseArgs([TOKEN])).toEqual({
      kind: "usage-error",
      message: "Unknown argument: (value)",
    });
  });

  it("parses token commands with a label", () => {
    for (const action of ["set", "check", "delete"] as const) {
      expect(parseArgs(["token", action, "work.2026_a-b"])).toEqual({
        kind: "token",
        action,
        label: "work.2026_a-b",
      });
    }
  });

  it("refuses malformed token commands without echoing a token", () => {
    expect(parseArgs(["token"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["token", "show", "work"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["token", "set"])).toMatchObject({
      kind: "usage-error",
      message: "token set needs a label, for example: work",
    });
    expect(parseArgs(["token", "check", "a", "b"])).toMatchObject({
      kind: "usage-error",
      message: "token check takes only a label.",
    });
    expect(parseArgs(["token", "set", "-x"])).toMatchObject({ kind: "usage-error" });

    const asArgument = parseArgs(["token", "set", "work", TOKEN]);
    expect(asArgument).toMatchObject({ kind: "usage-error" });
    expect(JSON.stringify(asArgument)).toMatch(/never put the token on the command line/);
    expect(JSON.stringify(asArgument)).not.toContain(TOKEN);

    const asLabel = parseArgs(["token", "set", TOKEN]);
    expect(asLabel).toMatchObject({ kind: "usage-error" });
    expect(JSON.stringify(asLabel)).toMatch(/looks like a sevDesk API token/);
    expect(JSON.stringify(asLabel)).not.toContain(TOKEN);
  });

  it("parses profiles list", () => {
    expect(parseArgs(["profiles", "list"])).toEqual({ kind: "profiles-list" });
    expect(parseArgs(["profiles"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["profiles", "list", "--json"])).toMatchObject({ kind: "usage-error" });
  });

  it("documents every command in the help text", () => {
    for (const word of [
      "--stdio",
      "--http",
      "grants list",
      "grants revoke",
      "generate-secret",
      "account-id",
      "healthcheck",
      "token set <label>",
      "token check <label>",
      "token delete <label>",
      "profiles list",
    ]) {
      expect(HELP).toContain(word);
    }
  });
});
