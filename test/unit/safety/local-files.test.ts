import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openedInside, readConfinedFile, sniffKind } from "../../../src/safety/local-files.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

const PDF = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj<<>>endobj\n%%EOF\n");
const XML = new TextEncoder().encode('﻿  <?xml version="1.0"?><Invoice/>');
const OPTIONS = { maxBytes: 1_000, kinds: ["pdf", "xml"] } as const;

let base: string;
let inbox: string;
let other: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-local-files-")));
  inbox = join(base, "Belege");
  other = join(base, "Rechnungen");
  outside = join(base, "secret");
  await mkdir(join(inbox, "2026"), { recursive: true });
  await mkdir(other);
  await mkdir(outside);
  await writeFile(join(inbox, "receipt.pdf"), PDF);
  await writeFile(join(inbox, "2026", "xrechnung.xml"), XML);
  await writeFile(join(other, "only-here.pdf"), PDF);
  await writeFile(join(outside, "token.txt"), "0123456789abcdef0123456789abcdef");
  await writeFile(join(outside, "looks-like.pdf"), PDF);
  await writeFile(join(inbox, "big.pdf"), new Uint8Array(2_000).fill(0x25));
  await writeFile(join(inbox, "fake.pdf"), "just text, no header");
  await symlink(join(outside, "looks-like.pdf"), join(inbox, "escape.pdf"));
  await symlink(join(inbox, "receipt.pdf"), join(inbox, "alias.pdf"));
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

describe("readConfinedFile", () => {
  it("reads an absolute path inside a configured folder", async () => {
    const file = await readConfinedFile([inbox], join(inbox, "receipt.pdf"), OPTIONS);
    expect(file).toMatchObject({
      name: "receipt.pdf",
      kind: "pdf",
      path: join(inbox, "receipt.pdf"),
    });
    expect(file.bytes).toEqual(PDF);
  });

  it("resolves a relative path against each folder in order", async () => {
    const xml = await readConfinedFile([inbox, other], "2026/xrechnung.xml", OPTIONS);
    expect(xml.kind).toBe("xml");
    const pdf = await readConfinedFile([inbox, other], "only-here.pdf", OPTIONS);
    expect(pdf.path).toBe(join(other, "only-here.pdf"));
  });

  it("follows a symlink that stays inside, reading its real target", async () => {
    const file = await readConfinedFile([inbox], "alias.pdf", OPTIONS);
    expect(file.path).toBe(join(inbox, "receipt.pdf"));
  });

  it("refuses symlinks and .. segments that leave the folders", async () => {
    expect(await refusalOf(readConfinedFile([inbox], "escape.pdf", OPTIONS))).toContain(
      "is not a readable file inside the folders listed in SEVDESK_FILE_DIRS",
    );
    expect(await refusalOf(readConfinedFile([inbox], "../secret/token.txt", OPTIONS))).toContain(
      "is not a readable file inside the folders",
    );
    expect(
      await refusalOf(readConfinedFile([inbox], join(outside, "looks-like.pdf"), OPTIONS)),
    ).toContain("is not a readable file inside the folders");
  });

  it("refuses the folder itself and other directories", async () => {
    expect(await refusalOf(readConfinedFile([inbox], inbox, OPTIONS))).toContain(
      "is not a readable file inside",
    );
    expect(await refusalOf(readConfinedFile([inbox], "2026", OPTIONS))).toContain(
      "not a regular file",
    );
  });

  it("refuses when nothing is configured or no folder exists", async () => {
    expect(await refusalOf(readConfinedFile([], "receipt.pdf", OPTIONS))).toContain(
      "SEVDESK_FILE_DIRS is not set",
    );
    expect(await refusalOf(readConfinedFile([join(base, "missing")], "x.pdf", OPTIONS))).toContain(
      "None of the folders",
    );
  });

  it("refuses missing files, too large files and content of the wrong kind", async () => {
    expect(await refusalOf(readConfinedFile([inbox], "nope.pdf", OPTIONS))).toContain(
      'The file "nope.pdf" is not a readable file inside the folders',
    );
    expect(await refusalOf(readConfinedFile([inbox], "big.pdf", OPTIONS))).toContain(
      "the limit is 1000 bytes",
    );
    expect(await refusalOf(readConfinedFile([inbox], "fake.pdf", OPTIONS))).toContain(
      "not an accepted file type (accepted: PDF, XML;",
    );
    expect(
      await refusalOf(
        readConfinedFile([inbox], "receipt.pdf", { maxBytes: 1_000, kinds: ["xml"] }),
      ),
    ).toContain("(accepted: XML;");
  });

  it("refuses empty paths, NUL bytes and hidden characters without echoing them", async () => {
    expect(await refusalOf(readConfinedFile([inbox], " ", OPTIONS))).toContain("empty or invalid");
    expect(await refusalOf(readConfinedFile([inbox], "a\0b.pdf", OPTIONS))).toContain(
      "empty or invalid",
    );
    const bidi = `receipt${String.fromCodePoint(0x202e)}fdp.exe`;
    const message = await refusalOf(readConfinedFile([inbox], bidi, OPTIONS));
    expect(message).toContain("invisible or control characters");
    expect(message).not.toContain(String.fromCodePoint(0x202e));
  });

  it.each(["\\\\attacker.example\\s\\r.pdf", "//attacker.example/s/r.pdf", "\\\\?\\C:\\x.pdf"])(
    "refuses the network or device path %s before touching the file system",
    async (path) => {
      expect(await refusalOf(readConfinedFile([inbox], path, OPTIONS))).toContain(
        "is a network or device path",
      );
    },
  );

  it("answers the same for an existing and a missing file outside the folders (no oracle)", async () => {
    const existing = await refusalOf(
      readConfinedFile([inbox], join(outside, "token.txt"), OPTIONS),
    );
    const missing = await refusalOf(readConfinedFile([inbox], join(outside, "nope.txt"), OPTIONS));
    expect(existing.replace("token.txt", "X")).toBe(missing.replace("nope.txt", "X"));
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO inside the folder without blocking on it",
    async () => {
      execFileSync("mkfifo", [join(inbox, "pipe.pdf")]);
      expect(await refusalOf(readConfinedFile([inbox], "pipe.pdf", OPTIONS))).toContain(
        "is not a regular file",
      );
    },
  );

  it("says that nothing was sent", async () => {
    expect(await refusalOf(readConfinedFile([inbox], "nope.pdf", OPTIONS))).toMatch(
      /Nothing was sent to sevDesk\.$/,
    );
  });
});

describe("sniffKind", () => {
  it.each([
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["pdf", [...new TextEncoder().encode("junk%PDF-1.4")]],
    ["xml", [0xef, 0xbb, 0xbf, 0x0a, 0x3c, 0x61]],
    ["xml", [0x20, 0x09, 0x3c]],
  ])("recognizes %s", (kind, bytes) => {
    expect(sniffKind(new Uint8Array(bytes))).toBe(kind);
  });

  it("returns undefined for anything else", () => {
    expect(sniffKind(new TextEncoder().encode("hello"))).toBeUndefined();
    expect(sniffKind(new Uint8Array())).toBeUndefined();
  });
});

describe("openedInside: a folder swapped for a link (security review 2026-11, finding 10)", () => {
  it("refuses a file opened through a folder that was replaced after resolving", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-swap-")));
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-elsewhere-")));
    try {
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "sub", "invoice.xml"), XML);
      await writeFile(join(root, "sub", "control.xml"), XML);
      await writeFile(join(elsewhere, "invoice.xml"), XML);
      // `root` is a real path already, so these are the files' real paths. Each path is opened
      // once: the control file before the swap, the target after it.
      const real = join(root, "sub", "invoice.xml");
      const control = join(root, "sub", "control.xml");
      const inRoot = (path: string): boolean => path.startsWith(`${root}/`);

      const before = await open(control, "r");
      try {
        expect(await openedInside(before, control, await before.stat(), inRoot)).toBe(true);
      } finally {
        await before.close();
      }

      // Between resolving and opening, `sub` becomes a link to a folder outside.
      await rename(join(root, "sub"), join(root, "sub-old"));
      await symlink(elsewhere, join(root, "sub"));
      const swapped = await open(real, "r");
      try {
        expect(await openedInside(swapped, real, await swapped.stat(), inRoot)).toBe(false);
      } finally {
        await swapped.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
