import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProfilesCommand } from "../../src/profiles-cli.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("profiles list", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sevdesk-profiles-cli-"));
    path = join(dir, "profiles.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function list(env: Record<string, string>) {
    let out = "";
    let err = "";
    const code = await runProfilesCommand(
      { SEVDESK_PROFILES_PATH: path, ...env },
      { out: (text) => (out += text), err: (text) => (err += text) },
    );
    expect(out + err).not.toContain(TOKEN);
    return { code, out, err };
  }

  it("lists every profile with its token source, tiers and toolsets, marking the active one", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: {
          work: { token: { keychain: "work" }, allow: ["write", "commit"], toolsets: "all" },
          demo: { token: { env: "SEVDESK_TOKEN_DEMO" }, readOnly: true, dryRun: true },
          plain: {},
        },
      }),
      { mode: 0o600 },
    );

    const result = await list({ SEVDESK_PROFILE: "demo", SEVDESK_TOKEN_DEMO: TOKEN });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toBe(
      [
        `Profiles in ${path}:`,
        "   PROFILE  TOKEN                   TIERS               TOOLSETS",
        "   work     keychain:work           write,commit        all",
        "*  demo     env:SEVDESK_TOKEN_DEMO  read-only, dry-run  -",
        "   plain    -                       -                   -",
        "",
      ].join("\n"),
    );
  });

  it("does not print a token pasted into tiers or toolsets (security review 2026-11, wave 2)", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: { work: { allow: TOKEN }, home: { toolsets: `invoices,${TOKEN}` } },
      }),
      { mode: 0o600 },
    );

    // `list` already checks that the token appears nowhere in the output.
    const result = await list({});

    expect(result.code).toBe(0);
    expect(result.out).toContain("[redacted]");
  });

  it("explains a missing or empty file", async () => {
    expect(await list({})).toEqual({
      code: 0,
      out:
        `No profiles file at ${path}. Create one (see Profiles in docs/configuration.md), or set ` +
        "SEVDESK_PROFILES_PATH to yours.\n",
      err: "",
    });

    await writeFile(path, '{"version": 1, "profiles": {}}', { mode: 0o600 });
    expect((await list({})).out).toBe(`${path} defines no profiles.\n`);
  });

  it("notes an active profile that the file lacks, never echoing a token", async () => {
    await writeFile(path, '{"version": 1, "profiles": {"work": {}}}', { mode: 0o600 });

    expect((await list({ SEVDESK_PROFILE: "home" })).err).toBe(
      'profiles: SEVDESK_PROFILE names "home", which is not in this file.\n',
    );
    expect((await list({ SEVDESK_PROFILE: TOKEN })).err).toMatch(
      /^profiles: SEVDESK_PROFILE looks like a sevDesk API token/,
    );
  });

  it("reports an invalid or untrusted file and a relative path", async () => {
    await writeFile(path, `{"version": 1, "profiles": {"work": {"token": "${TOKEN}"}}}`, {
      mode: 0o600,
    });
    const invalid = await list({});
    expect(invalid.code).toBe(1);
    expect(invalid.err).toMatch(
      /^profiles: Invalid configuration:\n {2}- Profiles file .+ token must/,
    );

    if (process.platform !== "win32") {
      await writeFile(path, '{"version": 1, "profiles": {}}');
      await chmod(path, 0o666);
      expect((await list({})).err).toMatch(/Other users can change the profiles file/);
    }

    let err = "";
    const code = await runProfilesCommand(
      { SEVDESK_PROFILES_PATH: "profiles.json" },
      { out: () => undefined, err: (text) => (err += text) },
      { platform: "linux" },
    );
    expect(code).toBe(1);
    expect(err).toBe(
      "profiles: SEVDESK_PROFILES_PATH must be an absolute path to the profiles file.\n",
    );
  });
});
