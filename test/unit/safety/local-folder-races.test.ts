/**
 * The path check and the folder scan when the file system changes between two of their calls: a
 * folder or file removed or renamed after its real path was read, a name in a folder's listing
 * that the folder no longer holds (`opendir` follows a link, so a folder swapped for a link and
 * back for a moment lists another folder's names). A real race cannot be timed in a test, so
 * `stat` and `lstat` are stubbed to fail at the call in question; each test checks which call that
 * was, so a change in the order of the calls fails the test instead of passing it unnoticed.
 */
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readConfinedFile } from "../../../src/safety/local-files.js";
import { scanConfinedFolder } from "../../../src/safety/local-folder.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

vi.mock("node:fs/promises", { spy: true });

const actual = await vi.importActual<typeof fsp>("node:fs/promises");

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
/** A name that, in the race, came from another folder's listing. */
const FOREIGN = "name-from-elsewhere.pdf";

let base: string;
let first: string;
let second: string;

/** The error a removed path gives. */
function gone(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

beforeAll(async () => {
  base = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "sevdesk-folder-races-")));
  first = join(base, "first");
  second = join(base, "second");
  await actual.mkdir(join(first, "sub"), { recursive: true });
  await actual.mkdir(second);
  await actual.writeFile(join(first, FOREIGN), PDF);
  await actual.writeFile(join(second, "receipt.pdf"), PDF);
});

afterAll(async () => {
  await actual.rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(fsp.stat).mockReset();
  vi.mocked(fsp.lstat).mockReset();
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

const pathsOf = (mock: { readonly mock: { readonly calls: readonly unknown[][] } }): unknown[] =>
  mock.mock.calls.map(([path]) => path);

describe("a path removed after its real path was read", () => {
  it("skips a configured folder removed during the check and scans the others", async () => {
    const stat = vi.mocked(fsp.stat);
    // The real path check of both folders, then `first` is gone when the scan locates it.
    stat
      .mockImplementationOnce(actual.stat)
      .mockImplementationOnce(actual.stat)
      .mockRejectedValueOnce(gone());

    const scan = await scanConfinedFolder([first, second], undefined, { subfolders: false });

    expect(pathsOf(stat).slice(0, 3)).toEqual([first, second, first]);
    expect(scan.folders).toEqual([second]);
    expect(scan.files.map((file) => file.path)).toEqual([join(second, "receipt.pdf")]);
  });

  it("refuses like a missing folder when the only configured folder is removed", async () => {
    const stat = vi.mocked(fsp.stat);
    stat.mockImplementationOnce(actual.stat).mockRejectedValueOnce(gone());

    const message = await refusalOf(scanConfinedFolder([first], undefined, { subfolders: false }));

    expect(pathsOf(stat)).toEqual([first, first]);
    expect(message).toContain("None of the folders in SEVDESK_FILE_DIRS exists");
  });

  it("refuses a requested folder removed after its real path was read, like a missing one", async () => {
    const stat = vi.mocked(fsp.stat);
    // The configured folder, then the folder as written and as its real path (the same here).
    stat
      .mockImplementationOnce(actual.stat)
      .mockRejectedValueOnce(gone())
      .mockRejectedValueOnce(gone());

    const message = await refusalOf(scanConfinedFolder([first], "sub", { subfolders: false }));

    expect(pathsOf(stat)).toEqual([first, join(first, "sub"), join(first, "sub")]);
    expect(message).toContain(
      'The folder "sub" is not a readable folder inside the folders listed in SEVDESK_FILE_DIRS',
    );
  });

  it("refuses a file removed after its real path was read, like a missing one", async () => {
    const stat = vi.mocked(fsp.stat);
    stat
      .mockImplementationOnce(actual.stat)
      .mockRejectedValueOnce(gone())
      .mockRejectedValueOnce(gone());

    const message = await refusalOf(
      readConfinedFile([first], FOREIGN, { maxBytes: 1_000, kinds: ["pdf"] }),
    );

    expect(pathsOf(stat)).toEqual([first, join(first, FOREIGN), join(first, FOREIGN)]);
    expect(message).toContain("is not a readable file inside the folders listed");
  });
});

describe("a listed name the folder no longer holds", () => {
  it("is counted as changed but never named", async () => {
    const lstat = vi.mocked(fsp.lstat);
    // The folder before and after its listing, then the file: gone, as if the listing had read
    // another folder swapped in for a moment.
    lstat
      .mockImplementationOnce(actual.lstat)
      .mockImplementationOnce(actual.lstat)
      .mockRejectedValueOnce(gone());

    const scan = await scanConfinedFolder([first], undefined, { subfolders: false });

    // (Then the subfolder `sub`, which is not read.)
    expect(pathsOf(lstat).slice(0, 3)).toEqual([first, first, join(first, FOREIGN)]);
    expect(scan.files).toEqual([]);
    expect(scan.skipped.changed).toBe(1);
    expect(scan.notChecked).toEqual([]);
    expect(JSON.stringify(scan)).not.toContain(FOREIGN);
  });
});
