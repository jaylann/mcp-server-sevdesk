import { describe, expect, it } from "vitest";

import { HELP, parseArgs } from "../../src/cli.js";

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
    ]) {
      expect(HELP).toContain(word);
    }
  });
});
