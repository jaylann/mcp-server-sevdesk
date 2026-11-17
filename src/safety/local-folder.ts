/**
 * Scanning a local receipt folder (for `sevdesk_receipt_folder_check`): which receipt files a
 * folder inside `SEVDESK_FILE_DIRS` holds, and their SHA-256 checksums. Nothing else leaves this
 * module: no file content, only paths, sizes, modification times, kinds and checksums.
 *
 * Confinement, on top of `./local-files.ts`, whose path check locates the folder and whose open
 * checks open every file (one confinement for single files and folders):
 * - the folder is located like a file (lexical containment first, then the real path; "missing"
 *   and "outside" answer alike), but may be a configured folder itself; without one, every
 *   configured folder is scanned;
 * - a folder is checked again right before and right after its entries are read (still a folder
 *   and not a link, the same inode, its real path its own path and inside the configured
 *   folders); when that fails its entries are dropped and counted as `changed`. A name the
 *   listing gave but the folder no longer holds is counted as `changed` and never listed: it may
 *   come from another folder swapped in for a moment (`opendir` follows a link);
 * - entries are taken by their type as the directory reports it (nothing is followed), sorted by
 *   name, and skipped without being opened when the name is hidden (leading dot), the entry is a
 *   symbolic link (files and folders alike: links are never followed), it is neither a regular
 *   file nor a folder, the name holds invisible or control characters or the path is longer than
 *   any tool takes (no tool could be given it), or the extension is not one of a receipt
 *   (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.xml`);
 * - subfolders are read only with `subfolders`, at most `maxDepth` levels below the folder;
 * - every file is opened with `openChecked` (no symlink, a regular file, the inode the listing
 *   saw, still inside, at most `maxFileBytes`), its content must start like a PDF, PNG, JPEG or
 *   XML file (the kinds a voucher receipt or an e-invoice import accepts), and it is hashed in
 *   chunks while it is read: the bytes are never kept;
 * - the work is bounded: `maxFiles` files hashed, `maxTotalBytes` bytes hashed, `maxEntries`
 *   directory entries and `maxFolders` folders read. When a cap is reached, or `stop` says the
 *   time budget ran out, the scan stops and says why (`cut`). A folder with more entries than
 *   are left is cut by name (its names are sorted first), not in the file system's order.
 *
 * Paths returned are real absolute paths inside the configured folders, as the voucher tools take
 * them. They are local data and untrusted: callers show them only as values of their own fields,
 * never in instructions or error messages.
 */
import { createHash } from "node:crypto";
import type { Dir, Dirent } from "node:fs";
import { type FileHandle, lstat, opendir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";

import { SevdeskError } from "../sevdesk/errors.js";
import { findHiddenCharacters } from "./fence.js";
import {
  insideRoots,
  type LocalFileKind,
  locateConfinedFolders,
  type Located,
  openChecked,
  type OpenRefusal,
  sniffKind,
} from "./local-files.js";

/** The bounds of one scan; tests lower them. */
export interface FolderScanLimits {
  /** Files hashed. */
  readonly maxFiles: number;
  /** Bytes hashed over all files. */
  readonly maxTotalBytes: number;
  /** Largest file hashed (the upload limit of a receipt). */
  readonly maxFileBytes: number;
  /** Directory entries read over all folders. */
  readonly maxEntries: number;
  /** Folders read. */
  readonly maxFolders: number;
  /** Levels of subfolders below the folder (with `subfolders`). */
  readonly maxDepth: number;
}

export const FOLDER_SCAN_LIMITS: FolderScanLimits = {
  maxFiles: 500,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxEntries: 5_000,
  maxFolders: 100,
  maxDepth: 3,
};

export interface FolderScanOptions {
  /** Also read subfolders (up to `maxDepth` levels). */
  readonly subfolders: boolean;
  readonly signal?: AbortSignal | undefined;
  /** Asked before every folder and file; `true` stops the scan (cut `time`). */
  readonly stop?: (() => boolean) | undefined;
  readonly limits?: Partial<FolderScanLimits> | undefined;
}

/** File kinds a receipt can have, recognized by content. */
const RECEIPT_KINDS: readonly LocalFileKind[] = ["pdf", "png", "jpeg", "xml"];
/** Extensions of those kinds; other files are not opened. */
const RECEIPT_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".png", ".jpg", ".jpeg", ".xml"]);

/** One receipt file of the folder. */
export interface FolderFile {
  /** Real absolute path. Local text, untrusted: show it only as a value. */
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number;
  /** Last modification, milliseconds since the epoch. */
  readonly modifiedMs: number;
  /** Lower-case hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

/** Why an entry was not hashed. */
type FolderSkipReason =
  | "hidden"
  | "link"
  | "special"
  | "unusable_name"
  | "other_type"
  | "wrong_content"
  | "too_large"
  | "unreadable"
  | "changed";

/** The reasons a file with a receipt extension could not be checked (listed by path). */
type NotCheckedReason = "wrong_content" | "too_large" | "unreadable" | "changed";

/** Why a scan stopped early. */
type FolderCut = "files" | "bytes" | "entries" | "folders" | "depth" | "time";

export interface FolderScan {
  /** The folders scanned (real paths). */
  readonly folders: readonly string[];
  /** Receipt files hashed, in scan order (folder by folder, by name). */
  readonly files: readonly FolderFile[];
  /** Entries not hashed, by reason. */
  readonly skipped: Readonly<Record<FolderSkipReason, number>>;
  /** Files with a receipt extension that could not be checked, at most {@link MAX_NOT_CHECKED}. */
  readonly notChecked: readonly { readonly path: string; readonly reason: NotCheckedReason }[];
  readonly foldersRead: number;
  /** Subfolders found but not read (`subfolders` off, or deeper than `maxDepth`). */
  readonly subfoldersNotRead: number;
  /** Why the scan stopped early; empty when it read everything it was asked to. */
  readonly cut: readonly FolderCut[];
}

/** Files listed in `notChecked`; the counts in `skipped` cover all of them. */
const MAX_NOT_CHECKED = 50;
/**
 * Names read from one folder before they are sorted and cut to the entry cap (a few MB of memory
 * at most; the entry cap ends the scan, so only one folder ever reads this many).
 */
const MAX_LISTED = 50_000;
/** Longest path the voucher tools take as `file`. */
const MAX_PATH_LENGTH = 1_000;
const CHUNK_BYTES = 64 * 1024;
/** `sniffKind` looks for a PDF header within the first 1,024 bytes plus the header itself. */
const SNIFF_BYTES = 1_024 + 5;

interface ScanState {
  readonly files: FolderFile[];
  readonly skipped: Record<FolderSkipReason, number>;
  readonly notChecked: { path: string; reason: NotCheckedReason }[];
  readonly cut: Set<FolderCut>;
  readonly seenFiles: Set<string>;
  totalBytes: number;
  entriesRead: number;
  foldersRead: number;
  subfoldersNotRead: number;
}

/**
 * Scans `requested` (or every configured folder) under the rules in the module doc. Throws the
 * local `validation` refusals of the path check (setting off, no folder exists, outside, not a
 * folder, hidden characters, network path) and an `aborted` error when `signal` fires.
 */
export async function scanConfinedFolder(
  fileDirs: readonly string[],
  requested: string | undefined,
  options: FolderScanOptions,
): Promise<FolderScan> {
  const limits: FolderScanLimits = { ...FOLDER_SCAN_LIMITS, ...options.limits };
  const { folders, roots } = await locateConfinedFolders(fileDirs, requested);
  const state: ScanState = {
    files: [],
    skipped: {
      hidden: 0,
      link: 0,
      special: 0,
      unusable_name: 0,
      other_type: 0,
      wrong_content: 0,
      too_large: 0,
      unreadable: 0,
      changed: 0,
    },
    notChecked: [],
    cut: new Set(),
    seenFiles: new Set(),
    totalBytes: 0,
    entriesRead: 0,
    foldersRead: 0,
    subfoldersNotRead: 0,
  };
  const queue: { readonly folder: Located; readonly depth: number }[] = folders.map((folder) => ({
    folder,
    depth: 0,
  }));
  const visited = new Set<string>();
  while (queue.length > 0 && !stopsScan(state.cut)) {
    throwIfAborted(options.signal);
    const next = queue.shift();
    if (next === undefined) break;
    const key = inodeKey(next.folder);
    if (visited.has(key)) continue;
    if (state.foldersRead >= limits.maxFolders) {
      state.cut.add("folders");
      break;
    }
    if (options.stop?.() === true) {
      state.cut.add("time");
      break;
    }
    visited.add(key);
    const listing = await readFolder(next.folder, roots, limits.maxEntries - state.entriesRead);
    if (listing.status !== "ok") {
      state.skipped[listing.status] += 1;
      continue;
    }
    state.foldersRead += 1;
    state.entriesRead += listing.entries.length;

    const subfolders: Located[] = [];
    for (const entry of listing.entries) {
      if (stopsScan(state.cut)) break;
      throwIfAborted(options.signal);
      const path = join(next.folder.real, entry.name);
      const kind = entryKind(entry, path);
      if (kind === "folder") {
        const info = await lstat(path).catch(() => undefined);
        if (info?.isDirectory() === true) {
          subfolders.push({ real: path, dev: info.dev, ino: info.ino });
        } else {
          state.skipped.changed += 1;
        }
        continue;
      }
      if (kind !== "file") {
        state.skipped[kind] += 1;
        continue;
      }
      await scanFile(path, roots, limits, options, state);
    }
    // Only now: the entries read so far are checked, no further folder is read.
    if (listing.cut) state.cut.add("entries");
    if (!options.subfolders) {
      state.subfoldersNotRead += subfolders.length;
    } else if (next.depth + 1 > limits.maxDepth) {
      state.subfoldersNotRead += subfolders.length;
      if (subfolders.length > 0) state.cut.add("depth");
    } else {
      queue.push(...subfolders.map((folder) => ({ folder, depth: next.depth + 1 })));
    }
  }
  return {
    folders: folders.map((folder) => folder.real),
    files: state.files,
    skipped: state.skipped,
    notChecked: state.notChecked,
    foldersRead: state.foldersRead,
    subfoldersNotRead: state.subfoldersNotRead,
    cut: [...state.cut],
  };
}

/** Caps that end the whole scan (the others end only their own part). */
function stopsScan(cut: ReadonlySet<FolderCut>): boolean {
  return cut.has("files") || cut.has("bytes") || cut.has("time") || cut.has("entries");
}

function inodeKey(located: { readonly dev: number; readonly ino: number }): string {
  return `${String(located.dev)}:${String(located.ino)}`;
}

/** What an entry is, from its name and the type the directory reports; nothing is followed. */
function entryKind(
  entry: Dirent,
  path: string,
): "file" | "folder" | "hidden" | "link" | "special" | "unusable_name" | "other_type" {
  if (entry.name.startsWith(".")) return "hidden";
  if (entry.isSymbolicLink()) return "link";
  if (!entry.isFile() && !entry.isDirectory()) return "special";
  if (
    path.length > MAX_PATH_LENGTH ||
    findHiddenCharacters(entry.name, { allowNewlines: false }).length > 0
  ) {
    return "unusable_name";
  }
  if (entry.isDirectory()) return "folder";
  return RECEIPT_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? "file" : "other_type";
}

type Listing =
  | { readonly status: "ok"; readonly entries: readonly Dirent[]; readonly cut: boolean }
  | { readonly status: "changed" | "unreadable" };

/**
 * The first `maxEntries` entries of `folder` by name (code-unit order), `cut` when it holds more.
 * Up to {@link MAX_LISTED} names are read and sorted before the first `maxEntries` are taken, so
 * which entries a cut keeps does not depend on the order the file system lists them in; only a
 * folder with more names than that is cut in listing order. The folder is checked before and after
 * reading (see the module doc); `changed` when that fails, `unreadable` when it cannot be opened.
 */
async function readFolder(
  folder: Located,
  roots: readonly string[],
  maxEntries: number,
): Promise<Listing> {
  if (!(await stillThere(folder, roots))) return { status: "changed" };
  let dir: Dir;
  try {
    dir = await opendir(folder.real);
  } catch {
    return { status: "unreadable" };
  }
  const entries: Dirent[] = [];
  let more = false;
  try {
    // Leaving the loop early closes the directory, so does reaching its end.
    for await (const entry of dir) {
      if (entries.length >= MAX_LISTED) {
        more = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    return { status: "unreadable" };
  }
  if (!(await stillThere(folder, roots))) return { status: "changed" };
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const kept = entries.slice(0, Math.max(0, maxEntries));
  return { status: "ok", entries: kept, cut: more || kept.length < entries.length };
}

/** Whether `folder` is still the folder the scan located: not a link, same inode, inside. */
async function stillThere(folder: Located, roots: readonly string[]): Promise<boolean> {
  const info = await lstat(folder.real).catch(() => undefined);
  if (info?.isDirectory() !== true || info.dev !== folder.dev || info.ino !== folder.ino) {
    return false;
  }
  const real = await realpath(folder.real).catch(() => undefined);
  return real === folder.real && insideRoots(roots, real);
}

const NOT_CHECKED: Readonly<Record<OpenRefusal, NotCheckedReason>> = {
  unopenable: "unreadable",
  not_regular: "changed",
  changed: "changed",
  too_large: "too_large",
};

/** Hashes one file with a receipt extension, or counts why not; may set a cut. */
async function scanFile(
  path: string,
  roots: readonly string[],
  limits: FolderScanLimits,
  options: FolderScanOptions,
  state: ScanState,
): Promise<void> {
  if (state.files.length >= limits.maxFiles) {
    state.cut.add("files");
    return;
  }
  if (options.stop?.() === true) {
    state.cut.add("time");
    return;
  }
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) {
    // The listing named it, but the folder no longer holds it: counted, never listed. `opendir`
    // follows a link, so a folder swapped for a link and back while it was listed hands out the
    // names of another folder, outside perhaps; only a name the folder still holds is shown.
    state.skipped.changed += 1;
    return;
  }
  if (!info.isFile()) {
    notChecked(state, path, "changed");
    return;
  }
  const located: Located = { real: path, dev: info.dev, ino: info.ino };
  // A hard link to a file already hashed is the same file.
  if (state.seenFiles.has(inodeKey(located))) return;
  if (info.size <= limits.maxFileBytes && state.totalBytes + info.size > limits.maxTotalBytes) {
    state.cut.add("bytes");
    return;
  }
  const opened = await openChecked(located, roots, limits.maxFileBytes);
  if (!opened.ok) {
    notChecked(state, path, NOT_CHECKED[opened.reason]);
    return;
  }
  let hashed: { readonly kind: LocalFileKind; readonly sha256: string; readonly read: number };
  try {
    const result = await hashReceipt(opened.handle, limits.maxFileBytes);
    if (result.status !== "ok") {
      notChecked(state, path, result.status);
      return;
    }
    hashed = result;
  } catch {
    notChecked(state, path, "unreadable");
    return;
  } finally {
    await opened.handle.close();
  }
  state.seenFiles.add(inodeKey(located));
  state.totalBytes += hashed.read;
  state.files.push({
    path,
    kind: hashed.kind,
    size: hashed.read,
    modifiedMs: opened.modifiedMs,
    sha256: hashed.sha256,
  });
}

function notChecked(state: ScanState, path: string, reason: NotCheckedReason): void {
  state.skipped[reason] += 1;
  if (state.notChecked.length < MAX_NOT_CHECKED) state.notChecked.push({ path, reason });
}

type HashResult =
  | {
      readonly status: "ok";
      readonly kind: LocalFileKind;
      readonly sha256: string;
      readonly read: number;
    }
  | { readonly status: "wrong_content" | "changed" };

/**
 * Reads `handle` in chunks into the SHA-256: the first bytes decide the kind (a file that does not
 * start like a receipt is not read further), more than `maxBytes` means the file grew.
 */
async function hashReceipt(handle: FileHandle, maxBytes: number): Promise<HashResult> {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(CHUNK_BYTES);
  let read = 0;
  let kind: LocalFileKind | undefined;
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0 && filled === 0) break;
    filled += bytesRead;
    // Fill the first chunk far enough to recognize the kind before hashing it.
    if (kind === undefined && bytesRead > 0 && filled < SNIFF_BYTES && filled < buffer.length) {
      continue;
    }
    if (kind === undefined) {
      kind = sniffKind(buffer.subarray(0, filled));
      if (kind === undefined || !RECEIPT_KINDS.includes(kind)) return { status: "wrong_content" };
    }
    read += filled;
    if (read > maxBytes) return { status: "changed" };
    hash.update(buffer.subarray(0, filled));
    if (bytesRead === 0) break;
    filled = 0;
  }
  if (kind === undefined) return { status: "wrong_content" };
  return { status: "ok", kind, sha256: hash.digest("hex"), read };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
}
