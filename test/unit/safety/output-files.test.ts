import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOutputDir, writeNewFile } from "../../../src/safety/output-files.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-save-"));
  temporary.push(dir);
  return resolveOutputDir(dir);
}

describe("resolveOutputDir", () => {
  it("throws a local validation error naming the setting when unset", async () => {
    const error: unknown = await resolveOutputDir(undefined).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ kind: "validation", status: undefined });
    expect((error as SevdeskError).message).toMatch(/SEVDESK_OUTPUT_DIR is not set.*\.$/);
  });
});

describe("writeNewFile", () => {
  it.each(["a/b.pdf", "..", ".", ""])("rejects %j as a file name", async (name) => {
    const dir = await tempDir();
    await expect(writeNewFile(dir, name, new Uint8Array([1]))).rejects.toThrow(/plain basename/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("suffixes names without an extension too", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "README"), "x");
    await expect(writeNewFile(dir, "README", new Uint8Array([1]))).resolves.toBe(
      join(dir, "README-1"),
    );
  });

  it("gives up after 100 taken names", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "RE.pdf"), "x");
    await Promise.all(
      Array.from({ length: 99 }, (_, index) => writeFile(join(dir, `RE-${index + 1}.pdf`), "x")),
    );

    await expect(writeNewFile(dir, "RE.pdf", new Uint8Array([1]))).rejects.toThrow(
      /100 files named like RE\.pdf already exist/,
    );
  });

  it("removes a partly written file when writing fails", async () => {
    const dir = await tempDir();
    const notBytes = 42 as unknown as Uint8Array;

    await expect(writeNewFile(dir, "RE.pdf", notBytes)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("rethrows errors other than an existing file", async () => {
    const dir = await tempDir();
    await expect(
      writeNewFile(join(dir, "missing"), "RE.pdf", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeNewFile: an output folder swapped for a link (security review 2026-11, finding 10)", () => {
  it("creates nothing outside and refuses when the folder now leads elsewhere", async () => {
    const parent = await tempDir();
    const elsewhere = await tempDir();
    await mkdir(join(parent, "out"));
    const directory = await resolveOutputDir(join(parent, "out"));

    // After resolving, `out` is replaced by a link to another folder.
    await rename(join(parent, "out"), join(parent, "out-old"));
    await symlink(elsewhere, join(parent, "out"));

    const error: unknown = await writeNewFile(directory, "RE-1001.pdf", new Uint8Array([1])).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toContain("SEVDESK_OUTPUT_DIR changed");
    // No byte reached the other folder. The empty file is left, not removed by its path: that
    // path leads through the replaced folder, where removing could hit someone else's file
    // (security review 2026-11, wave 2).
    expect(await readdir(elsewhere)).toEqual(["RE-1001.pdf"]);
    expect((await stat(join(elsewhere, "RE-1001.pdf"))).size).toBe(0);
  });
});
