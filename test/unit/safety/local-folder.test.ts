/**
 * The receipt folder scan (`scanConfinedFolder`) on a real temporary folder: every confinement
 * rule (symbolic links out of the folder, `..`, hidden entries, other types, wrong content,
 * oversized files, the caps, the time budget) and that nothing but paths, sizes, dates and
 * checksums comes back.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localFileAccess } from "../../../src/safety/file-sources.js";
import { type FolderScan, scanConfinedFolder } from "../../../src/safety/local-folder.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { filesConfig, filesDeployment, useTransfer } from "../../helpers/transfer.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const PDF = encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
const PDF_2 = encode("%PDF-1.4\nanother receipt\n%%EOF\n");
const PDF_3 = encode("%PDF-1.4\nthe deep one\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const XML = encode('<?xml version="1.0"?><Invoice/>');
const SECRET = "0123456789abcdef0123456789abcdef";
/** Larger than the lowered per-file limit, smaller than the default one. */
const BIG = new Uint8Array(3_000).fill(0x25);
const LIMITS = { maxFileBytes: 2_000 };
const BIDI = String.fromCodePoint(0x202e);

let base: string;
let root: string;
let outside: string;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-local-folder-")));
  root = join(base, "Belege");
  outside = join(base, "secret");
  await mkdir(join(root, "2026", "03"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(outside);
  await writeFile(join(root, "a-receipt.pdf"), PDF);
  await writeFile(join(root, "b-photo.JPG"), JPEG);
  await writeFile(join(root, "c-xrechnung.xml"), XML);
  await writeFile(join(root, "d-image.png"), PNG);
  await writeFile(join(root, "notes.txt"), "a note");
  await writeFile(join(root, "fake.pdf"), "just text, no header");
  await writeFile(join(root, "big.pdf"), BIG);
  await writeFile(join(root, ".hidden.pdf"), PDF_2);
  await writeFile(join(root, ".git", "x.pdf"), PDF_2);
  await writeFile(join(root, `receipt${BIDI}fdp.pdf`), PDF_2);
  await writeFile(join(root, "2026", "march.pdf"), PDF_2);
  await writeFile(join(root, "2026", "03", "deep.pdf"), PDF_3);
  await writeFile(join(outside, "looks-like.pdf"), encode(`%PDF-1.4 ${SECRET}`));
  await writeFile(join(outside, "token.txt"), SECRET);
  await symlink(join(outside, "looks-like.pdf"), join(root, "escape.pdf"));
  await symlink(join(root, "a-receipt.pdf"), join(root, "alias.pdf"));
  await symlink(outside, join(root, "linkdir"));
  await symlink(root, join(base, "root-link"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    const sevdeskError = error as SevdeskError;
    expect(sevdeskError.kind).toBe("validation");
    return sevdeskError.message;
  }
  throw new Error("expected a refusal");
}

function names(scan: FolderScan): string[] {
  return scan.files.map((file) => file.path.slice(root.length + 1));
}

describe("scanConfinedFolder", () => {
  it("hashes the folder's own receipt files, sorted, and skips everything else", async () => {
    const scan = await scanConfinedFolder([root], undefined, {
      subfolders: false,
      limits: LIMITS,
    });

    expect(scan.folders).toEqual([root]);
    expect(names(scan)).toEqual(["a-receipt.pdf", "b-photo.JPG", "c-xrechnung.xml", "d-image.png"]);
    expect(scan.files.map((file) => [file.kind, file.sha256, file.size])).toEqual([
      ["pdf", sha(PDF), PDF.length],
      ["jpeg", sha(JPEG), JPEG.length],
      ["xml", sha(XML), XML.length],
      ["png", sha(PNG), PNG.length],
    ]);
    for (const file of scan.files) expect(file.modifiedMs).toBeGreaterThan(0);
    expect(scan.skipped).toEqual({
      hidden: 2,
      link: 3,
      special: 0,
      unusable_name: 1,
      other_type: 1,
      wrong_content: 1,
      too_large: 1,
      unreadable: 0,
      changed: 0,
    });
    expect(scan.notChecked).toEqual([
      { path: join(root, "big.pdf"), reason: "too_large" },
      { path: join(root, "fake.pdf"), reason: "wrong_content" },
    ]);
    expect(scan.foldersRead).toBe(1);
    expect(scan.subfoldersNotRead).toBe(1);
    expect(scan.cut).toEqual([]);
  });

  it("never follows a symbolic link and returns no content", async () => {
    const scan = await scanConfinedFolder([root], undefined, { subfolders: true });
    const text = JSON.stringify(scan);

    expect(text).not.toContain(outside);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("%PDF");
    expect(text).not.toContain("escape.pdf");
    expect(text).not.toContain("alias.pdf");
    expect(text).not.toContain(BIDI);
    for (const file of scan.files) expect(file.path.startsWith(`${root}/`)).toBe(true);
  });

  it("reads subfolders only when asked, up to the depth limit", async () => {
    const all = await scanConfinedFolder([root], undefined, { subfolders: true });
    expect(names(all)).toEqual([
      "a-receipt.pdf",
      "b-photo.JPG",
      "c-xrechnung.xml",
      "d-image.png",
      "2026/march.pdf",
      "2026/03/deep.pdf",
    ]);
    expect(all.foldersRead).toBe(3);
    expect(all.cut).toEqual([]);
    // Under the default size limit big.pdf is read, but it does not start like a PDF.
    expect(all.notChecked).toContainEqual({ path: join(root, "big.pdf"), reason: "wrong_content" });

    const shallow = await scanConfinedFolder([root], undefined, {
      subfolders: true,
      limits: { maxDepth: 1 },
    });
    expect(names(shallow)).toContain("2026/march.pdf");
    expect(names(shallow)).not.toContain("2026/03/deep.pdf");
    expect(shallow.subfoldersNotRead).toBe(1);
    expect(shallow.cut).toEqual(["depth"]);
  });

  it("takes a folder relative to a configured one, absolute, or the configured one itself", async () => {
    const relative = await scanConfinedFolder([outside, root], "2026", { subfolders: false });
    expect(relative.folders).toEqual([join(root, "2026")]);
    expect(relative.files.map((file) => file.path)).toEqual([join(root, "2026", "march.pdf")]);

    const absolute = await scanConfinedFolder([root], join(root, "2026", "03"), {
      subfolders: false,
    });
    expect(absolute.files.map((file) => file.sha256)).toEqual([sha(PDF_3)]);

    const itself = await scanConfinedFolder([root], ".", { subfolders: false });
    expect(itself.folders).toEqual([root]);
  });

  it("scans every configured folder once, by its real path", async () => {
    const scan = await scanConfinedFolder([join(base, "root-link"), root], undefined, {
      subfolders: false,
    });
    expect(scan.folders).toEqual([root]);
    expect(scan.foldersRead).toBe(1);
  });

  it("refuses folders outside, reached through a link or ..", async () => {
    const message = "is not a readable folder inside the folders listed in SEVDESK_FILE_DIRS";
    const options = { subfolders: false };
    expect(await refusalOf(scanConfinedFolder([root], outside, options))).toContain(message);
    expect(await refusalOf(scanConfinedFolder([root], "../secret", options))).toContain(message);
    expect(await refusalOf(scanConfinedFolder([root], "linkdir", options))).toContain(message);
    expect(await refusalOf(scanConfinedFolder([root], "2026/../../secret", options))).toContain(
      message,
    );
  });

  it("answers the same for a missing folder and one outside (no oracle)", async () => {
    const options = { subfolders: false };
    const existing = await refusalOf(scanConfinedFolder([root], join(base, "secret"), options));
    const missing = await refusalOf(scanConfinedFolder([root], join(base, "nope"), options));
    expect(existing.replace("secret", "X")).toBe(missing.replace("nope", "X"));
  });

  it("refuses a file, an empty or hidden path, a network path and an unset setting", async () => {
    const options = { subfolders: false };
    expect(await refusalOf(scanConfinedFolder([root], "a-receipt.pdf", options))).toContain(
      'The folder "a-receipt.pdf" is not a folder',
    );
    expect(await refusalOf(scanConfinedFolder([root], " ", options))).toContain(
      "The folder path is empty or invalid",
    );
    const hidden = await refusalOf(scanConfinedFolder([root], `2026${BIDI}`, options));
    expect(hidden).toContain("invisible or control characters");
    expect(hidden).not.toContain(BIDI);
    expect(await refusalOf(scanConfinedFolder([root], "//host/share", options))).toContain(
      "is a network or device path; only folders inside SEVDESK_FILE_DIRS can be read",
    );
    expect(await refusalOf(scanConfinedFolder([], undefined, options))).toContain(
      "SEVDESK_FILE_DIRS is not set",
    );
    expect(await refusalOf(scanConfinedFolder([join(base, "none")], undefined, options))).toContain(
      "None of the folders",
    );
  });

  it("stops at the file cap and says so", async () => {
    const scan = await scanConfinedFolder([root], undefined, {
      subfolders: true,
      limits: { maxFiles: 2 },
    });
    expect(names(scan)).toEqual(["a-receipt.pdf", "b-photo.JPG"]);
    expect(scan.cut).toEqual(["files"]);
    expect(scan.foldersRead).toBe(1);
  });

  it("stops at the byte cap before reading a file that would pass it", async () => {
    const scan = await scanConfinedFolder([root], undefined, {
      subfolders: false,
      limits: { maxTotalBytes: PDF.length + JPEG.length + 1 },
    });
    expect(names(scan)).toEqual(["a-receipt.pdf", "b-photo.JPG"]);
    expect(scan.cut).toEqual(["bytes"]);
  });

  it("stops at the entry and folder caps", async () => {
    const entries = await scanConfinedFolder([root], undefined, {
      subfolders: true,
      limits: { maxEntries: 3 },
    });
    expect(entries.cut).toEqual(["entries"]);
    expect(entries.foldersRead).toBe(1);

    const folders = await scanConfinedFolder([root], undefined, {
      subfolders: true,
      limits: { maxFolders: 1 },
    });
    expect(folders.cut).toEqual(["folders"]);
    expect(names(folders)).not.toContain("2026/march.pdf");
  });

  it("keeps the first entries by name when a folder holds more than the entry cap", async () => {
    const folder = join(base, "many");
    await mkdir(folder);
    // Written out of order, so that neither creation order (or its reverse) nor a hashed listing
    // (APFS, ext4) puts a, b and c first.
    for (const name of ["g", "a", "k", "d", "i", "b", "l", "e", "h", "c", "j", "f"]) {
      await writeFile(join(folder, `${name}.pdf`), encode(`%PDF-1.4 receipt ${name}`));
    }
    const scan = await scanConfinedFolder([folder], undefined, {
      subfolders: false,
      limits: { maxEntries: 3 },
    });
    expect(scan.files.map((file) => file.path.slice(folder.length + 1))).toEqual([
      "a.pdf",
      "b.pdf",
      "c.pdf",
    ]);
    expect(scan.cut).toEqual(["entries"]);
  });

  it("stops when the time budget runs out", async () => {
    let calls = 0;
    const scan = await scanConfinedFolder([root], undefined, {
      subfolders: false,
      stop: () => (calls += 1) > 2,
    });
    expect(scan.cut).toEqual(["time"]);
    expect(scan.files).toHaveLength(1);
  });

  it("stops with an aborted error when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanConfinedFolder([root], undefined, { subfolders: false, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it.skipIf(process.platform === "win32")(
    "skips a FIFO without opening it, whatever its name",
    async () => {
      const folder = join(base, "fifo");
      await mkdir(folder);
      execFileSync("mkfifo", [join(folder, "pipe.pdf")]);
      const scan = await scanConfinedFolder([folder], undefined, { subfolders: false });
      expect(scan.files).toEqual([]);
      expect(scan.skipped.special).toBe(1);
    },
  );
});

describe("FileAccess.scanFolder", () => {
  const transfer = useTransfer();

  it("scans the local folders", async () => {
    const access = localFileAccess({ fileDirs: [root], outputDir: undefined });
    const scan = await access.scanFolder("2026", { subfolders: false });
    expect(scan.files.map((file) => file.sha256)).toEqual([sha(PDF_2)]);
  });

  it("refuses on a remote server without local folders: uploads are single files", async () => {
    const access = (await transfer()).access(filesConfig());
    expect(await refusalOf(access.scanFolder(undefined, { subfolders: false }))).toContain(
      "This server reads no local folders",
    );
  });

  it("scans the server's folders in bearer mode with SEVDESK_FILE_DIRS", async () => {
    const config = filesConfig({ deployment: filesDeployment("bearer"), fileDirs: [root] });
    const scan = await (await transfer()).access(config).scanFolder("2026", { subfolders: false });
    expect(scan.files).toHaveLength(1);
  });
});
