import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { failureMessage, main } from "../../../scripts/attach-release-attestation.js";

vi.mock("node:child_process", { spy: true });

// SHA-256 test vector for "abc"; no real signatures, identities or credentials in this fixture.
const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const statement = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: "fixture.mcpb", digest: { sha256: digest } }],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {},
};

function fixture(payload: unknown = statement) {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { certificate: { rawBytes: "Zml4dHVyZQ==" } },
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
      signatures: [{ sig: "Zml4dHVyZQ==", keyid: "" }],
    },
  };
}

let directory: string;
let asset: string;
let bundlePath: string;
const tag = "v1.4.0";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "release-attestation-"));
  asset = join(directory, "asset with spaces.mcpb");
  bundlePath = join(directory, "bundle.json");
  writeFileSync(asset, "abc");
  writeFileSync(bundlePath, `${JSON.stringify(fixture(), null, 2)}\n\n`);
  vi.stubEnv("GITHUB_REPOSITORY", "jaylann/mcp-server-sevdesk");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // Every gh call is intercepted: even tests of the upload path remain offline.
  vi.spyOn(childProcess, "execFileSync").mockReturnValue("");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function expectNoOutputFiles(): void {
  expect(existsSync(`${asset}.sigstore.json`)).toBe(false);
  expect(existsSync(`${asset}.intoto.jsonl`)).toBe(false);
}

describe("release attestation files", () => {
  it("preserves a supplied bundle byte-for-byte and writes exactly one compact DSSE JSON line", () => {
    main([tag, asset, bundlePath, "--dry-run"]);
    expect(readFileSync(`${asset}.sigstore.json`)).toEqual(readFileSync(bundlePath));
    const line = readFileSync(`${asset}.intoto.jsonl`, "utf8");
    expect(line).toBe(`${JSON.stringify(fixture().dsseEnvelope)}\n`);
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line)).toEqual(fixture().dsseEnvelope);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify([`${asset}.sigstore.json`, `${asset}.intoto.jsonl`])),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("release v1.4.0 (--clobber)"));
  });

  it("accepts the matching subject anywhere in the statement's subject array", () => {
    writeFileSync(
      bundlePath,
      JSON.stringify(
        fixture({
          ...statement,
          subject: [{ name: "other", digest: { sha256: "0".repeat(64) } }, ...statement.subject],
        }),
      ),
    );
    main(["--dry-run", tag, asset, bundlePath]);
    expect(existsSync(`${asset}.sigstore.json`)).toBe(true);
  });

  it("refuses a bundle for different asset bytes before writing or uploading", () => {
    writeFileSync(asset, "changed bytes");
    expect(() => {
      main([tag, asset, bundlePath]);
    }).toThrow("SHA-256 does not match");
    expectNoOutputFiles();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ["no subjects", fixture({ ...statement, subject: [] }), "SHA-256 does not match"],
    [
      "no sha256",
      fixture({ ...statement, subject: [{ digest: { sha512: digest } }] }),
      "SHA-256 does not match",
    ],
    ["not a statement", fixture({ subject: statement.subject }), "in-toto statement"],
    ["not an envelope", {}, "DSSE envelope"],
    [
      "no signature",
      { dsseEnvelope: { ...fixture().dsseEnvelope, signatures: [] } },
      "DSSE envelope",
    ],
    [
      "wrong payload type",
      { dsseEnvelope: { ...fixture().dsseEnvelope, payloadType: "text/plain" } },
      "DSSE envelope",
    ],
    [
      "invalid base64",
      {
        dsseEnvelope: { ...fixture().dsseEnvelope, payload: `${fixture().dsseEnvelope.payload}!` },
      },
      "valid base64",
    ],
    [
      "invalid payload JSON",
      {
        dsseEnvelope: {
          ...fixture().dsseEnvelope,
          payload: Buffer.from("not json").toString("base64"),
        },
      },
      "valid JSON",
    ],
  ])("refuses %s", (_label, bundle, message) => {
    writeFileSync(bundlePath, JSON.stringify(bundle));
    expect(() => {
      main([tag, asset, bundlePath]);
    }).toThrow(message);
    expectNoOutputFiles();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("uploads only the two checked files with clobber and an explicit repository, without a shell", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "example/repository");
    main([tag, asset, bundlePath]);
    expect(childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith(
      "gh",
      [
        "release",
        "upload",
        tag,
        `${asset}.sigstore.json`,
        `${asset}.intoto.jsonl`,
        "--clobber",
        "--repo",
        "example/repository",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(readFileSync(`${asset}.sigstore.json`)).toEqual(readFileSync(bundlePath));
  });
});

describe("attestation API lookup", () => {
  it("fetches by the asset digest and preserves the complete bundle, without uploading in dry-run", () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      JSON.stringify([{ attestations: [{ bundle: fixture() }] }]),
    );
    main(["--dry-run", tag, asset]);
    expect(childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        `repos/jaylann/mcp-server-sevdesk/attestations/sha256:${digest}?per_page=100`,
      ],
      expect.any(Object),
    );
    expect(JSON.parse(readFileSync(`${asset}.sigstore.json`, "utf8"))).toEqual(fixture());
    expect(readFileSync(`${asset}.intoto.jsonl`, "utf8")).toBe(
      `${JSON.stringify(fixture().dsseEnvelope)}\n`,
    );
  });

  it.each([
    ["zero", [{ attestations: [] }]],
    ["two on one page", [{ attestations: [{ bundle: fixture() }, { bundle: fixture() }] }]],
    [
      "two across pages",
      [{ attestations: [{ bundle: fixture() }] }, { attestations: [{ bundle: fixture() }] }],
    ],
  ])("refuses %s attestations before writing or uploading", (_label, pages) => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(JSON.stringify(pages));
    expect(() => {
      main([tag, asset]);
    }).toThrow("exactly one attestation");
    expectNoOutputFiles();
    expect(childProcess.execFileSync).toHaveBeenCalledOnce();
  });

  it("rechecks the subject digest even when the API was queried by digest", () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      JSON.stringify([
        {
          attestations: [
            {
              bundle: fixture({ ...statement, subject: [{ digest: { sha256: "0".repeat(64) } }] }),
            },
          ],
        },
      ]),
    );
    expect(() => {
      main([tag, asset]);
    }).toThrow("SHA-256 does not match");
    expectNoOutputFiles();
    expect(childProcess.execFileSync).toHaveBeenCalledOnce();
  });

  it.each([
    [[], "paginated attestation results"],
    [[{ attestations: null }], "attestations array"],
    [[{ attestations: [{ bundle_url: "https://example.invalid/bundle" }] }], "no bundle"],
  ])("refuses malformed API data (%j)", (pages, message) => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(JSON.stringify(pages));
    expect(() => {
      main([tag, asset]);
    }).toThrow(message);
    expectNoOutputFiles();
  });
});

describe("CLI diagnostics", () => {
  it.each([
    [],
    [tag],
    ["--unknown", tag, "asset"],
    ["--repo=other", "asset"],
    [tag, "asset", "bundle", "extra"],
    ["--dry-run", tag, "asset", "--dry-run"],
  ])("rejects invalid arguments (%j)", (...args) => {
    expect(() => {
      main(args);
    }).toThrow("usage:");
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("refuses an invalid repository before contacting gh", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repo?query=value");
    expect(() => {
      main([tag, asset, bundlePath]);
    }).toThrow("owner/repo");
    expectNoOutputFiles();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it.each(["fetch", "upload"])(
    "does not leak subprocess errors or tokens on %s failure",
    (operation) => {
      const marker = "FAKE_CREDENTIAL_DO_NOT_PRINT";
      vi.stubEnv("GH_TOKEN", marker);
      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw Object.assign(new Error(marker), { stderr: Buffer.from(marker) });
      });
      let message = "";
      try {
        main(operation === "fetch" ? [tag, asset] : [tag, asset, bundlePath]);
      } catch (error) {
        message = failureMessage(error);
      }
      expect(message).toContain(operation === "fetch" ? "Could not fetch" : "Could not upload");
      expect(message).not.toContain(marker);
      expect(console.log).not.toHaveBeenCalled();
      expect(failureMessage(new Error(marker))).toBe(
        "Could not attach release attestation. Unexpected failure.",
      );
    },
  );

  it.skipIf(!process.features.typescript)(
    "runs dry-run and reports mismatches with plain Node and no dependency loader",
    () => {
      const script = fileURLToPath(
        new URL("../../../scripts/attach-release-attestation.ts", import.meta.url),
      );
      const args = [script, "--dry-run", tag, asset, bundlePath];
      const valid = childProcess.spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(valid.error).toBeUndefined();
      expect(valid.status).toBe(0);
      expect(valid.stdout).toContain("Dry run: would upload");
      expect(valid.stderr).toBe("");
      expect(readFileSync(`${asset}.sigstore.json`)).toEqual(readFileSync(bundlePath));
      writeFileSync(asset, "changed");
      const invalid = childProcess.spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("SHA-256 does not match the asset");
    },
  );
});
