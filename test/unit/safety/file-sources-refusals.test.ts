/**
 * `localFileAccess.deliver` passes the trusted refusals of `writeNewFile` on as they are (review
 * 2026-11-20): they say what is left behind, which a generic "could not be saved" hid. The swap
 * that causes the refusal needs a race, so `writeNewFile` is replaced here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { localFileAccess } from "../../../src/safety/file-sources.js";
import { refused } from "../../../src/safety/output-files.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

const SWAPPED =
  "SEVDESK_OUTPUT_DIR changed while the file was being created (a folder was replaced); nothing " +
  "was saved, an empty file named RE-1001.pdf may be left behind. The user should check the folder";

vi.mock("../../../src/safety/output-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/safety/output-files.js")>();
  return {
    ...actual,
    writeNewFile: () => Promise.reject(actual.refused(SWAPPED)),
  };
});

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("localFileAccess: refusals while saving", () => {
  it("passes a refusal of writeNewFile on with its own text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdmcp-refusal-"));
    dirs.push(dir);
    const files = localFileAccess({ fileDirs: [], outputDir: dir });

    const error = await files
      .deliver({ filename: "RE-1001.pdf", kind: "pdf", bytes: new Uint8Array([1]) })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(refused(SWAPPED).message);
  });
});
