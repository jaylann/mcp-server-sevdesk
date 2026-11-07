import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { resolveOutputDir, writeNewFile } from "../../../../src/tools/documents/save-file.js";

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
