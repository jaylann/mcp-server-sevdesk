/**
 * Reading local files (receipts, e-invoices) for upload or parsing, only from the directories
 * the user listed in `SEVDESK_FILE_DIRS`. The model names the file; it must never be able to make
 * the server read anything else (an SSH key, the token file, `/etc/passwd`) and send it to sevDesk
 * or back into the conversation.
 *
 * Confinement rules:
 * - no configured directory, no reading: tools refuse with a message naming the setting;
 * - every configured directory is resolved to its real path when used (symlinks resolved); a
 *   directory that does not exist is skipped;
 * - the requested path is either absolute or relative to one of the directories (tried in
 *   order). It is checked lexically FIRST, before any file system call: UNC and device paths
 *   (`\\host\share`, `//host/share`, `\\?\…`) are refused outright, and a path that does not
 *   lie inside a configured directory (as written or as its real path) is refused without being
 *   touched, so a hostile path never makes the server open a network share (Windows would send the
 *   user's NTLM hash) or probe whether a file exists elsewhere;
 * - only then is the path resolved; its real path must lie inside one of the real directories,
 *   so `..` segments and symlinks that point elsewhere are refused. "Missing" and "outside" get
 *   the same message (no existence oracle for files outside the folders);
 * - it must be a regular file before it is opened (a FIFO would block the open), and it is opened
 *   non-blocking;
 * - the file is opened with `O_NOFOLLOW` (a symlink swapped in after the check is not followed)
 *   and checked with `fstat` on the open handle: a regular file, the same inode the path check
 *   saw, at most `maxBytes`;
 * - the content must start like one of the allowed kinds (PDF, PNG, JPEG, XML): a renamed binary
 *   or a text file with a `.pdf` name is refused before anything is uploaded.
 *
 * The folder scan (`./local-folder.ts`) locates its folder with the same path check
 * ({@link locateConfinedFolders}; the configured folder itself is a valid target there) and opens
 * every file with the same checks ({@link openChecked}), so there is one confinement, not two.
 *
 * Error messages are trusted text: they never contain file content and name the requested file
 * only by its sanitized base name.
 */
import { constants } from "node:fs";
import { type FileHandle, open, readlink, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { SevdeskError } from "../sevdesk/errors.js";
import { findHiddenCharacters, sanitizeUntrusted } from "./fence.js";

/** The file kinds a tool may accept, recognized by their first bytes. */
export type LocalFileKind = "pdf" | "png" | "jpeg" | "xml";

/** A file read by {@link readConfinedFile}. */
export interface ConfinedFile {
  /** The real path that was read (inside one of the configured directories). */
  readonly path: string;
  /** Base name of the real path, e.g. `Rechnung-4711.pdf`. Local text: sanitize before display. */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly bytes: Uint8Array;
}

export interface ReadConfinedFileOptions {
  /** Largest accepted file in bytes. */
  readonly maxBytes: number;
  /** Kinds the caller can handle; anything else is refused. */
  readonly kinds: readonly LocalFileKind[];
}

/** `O_NOFOLLOW` where the platform has it (not on Windows, where symlinks need privileges). */
const NO_FOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;
/** `O_NONBLOCK` where the platform has it: never wait on a special file. */
const NON_BLOCK: number = (constants as Partial<typeof constants>).O_NONBLOCK ?? 0;
/** UNC (`\\host\share`, `//host/share`) and device (`\\?\`, `\\.\`) paths. */
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}/;
/** The refusal when no configured folder exists (any more). */
const NO_FOLDER_EXISTS =
  "None of the folders in SEVDESK_FILE_DIRS exists; the user has to create them or fix the setting";

/**
 * Reads one file from the configured directories under the rules in the module doc. Throws a
 * local `validation` {@link SevdeskError} with a trusted, actionable message when the file is
 * not allowed, missing, too large or of the wrong kind.
 */
export async function readConfinedFile(
  fileDirs: readonly string[],
  requested: string,
  options: ReadConfinedFileOptions,
): Promise<ConfinedFile> {
  const shown = displayName(requested, "file");
  const roots = await checkedRoots(fileDirs, requested, "file", shown);
  const target = await locate(roots, requested, shown, "file");
  const opened = await openChecked(
    target,
    roots.map((root) => root.real),
    options.maxBytes,
  );
  if (!opened.ok) {
    switch (opened.reason) {
      case "unopenable":
        throw refusal(`${shown} cannot be opened (missing, not readable, or a symbolic link)`);
      case "not_regular":
        throw refusal(`${shown} is not a regular file`);
      case "changed":
        throw refusal(`${shown} changed while it was being read; try again`);
      case "too_large":
        throw refusal(
          `${shown} has ${String(opened.size)} bytes; the limit is ${String(options.maxBytes)} ` +
            "bytes",
        );
      default: {
        const unreachable: never = opened.reason;
        throw new Error(`readConfinedFile: unknown reason ${String(unreachable)}.`);
      }
    }
  }
  const { handle } = opened;
  try {
    const bytes = await readAtMost(handle, options.maxBytes);
    const kind = sniffKind(bytes);
    if (kind === undefined || !options.kinds.includes(kind)) {
      throw refusal(
        `${shown} is not an accepted file type (accepted: ` +
          `${options.kinds.map((k) => k.toUpperCase()).join(", ")}; checked by content, not by name)`,
      );
    }
    return { path: target.real, name: basename(target.real), kind, bytes };
  } finally {
    await handle.close();
  }
}

/** A path inside the configured folders as the path check saw it (real path and inode). */
export interface Located {
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}

/** The folders a scan reads, located under the rules in the module doc. */
export interface ConfinedFolders {
  /** The folders to scan, in order, each once. */
  readonly folders: readonly Located[];
  /** Real paths of all configured folders that exist: every file read must stay inside one. */
  readonly roots: readonly string[];
}

/**
 * Locates the folder a scan reads: `requested` (absolute, or relative to one of the configured
 * folders, tried in order) under the same rules as a file (lexical containment first, then the
 * real path; "missing" and "outside" answer alike), except that the target must be a folder and
 * may be a configured folder itself. Without `requested`, every configured folder that exists is
 * scanned. Throws the same local `validation` refusals as {@link readConfinedFile}.
 */
export async function locateConfinedFolders(
  fileDirs: readonly string[],
  requested: string | undefined,
): Promise<ConfinedFolders> {
  if (requested === undefined) {
    const roots = await checkedRoots(fileDirs, undefined, "folder", "");
    const folders: Located[] = [];
    for (const root of roots) {
      if (folders.some((folder) => folder.real === root.real)) continue;
      // Removed or renamed since its real path was read: skipped like a folder that is missing.
      const info = await stat(root.real).catch(() => undefined);
      if (info === undefined) continue;
      folders.push({ real: root.real, dev: info.dev, ino: info.ino });
    }
    if (folders.length === 0) throw refusal(NO_FOLDER_EXISTS);
    return { folders, roots: folders.map((folder) => folder.real) };
  }
  const shown = displayName(requested, "folder");
  const roots = await checkedRoots(fileDirs, requested, "folder", shown);
  const folder = await locate(roots, requested, shown, "folder");
  return { folders: [folder], roots: [...new Set(roots.map((root) => root.real))] };
}

/** Whether `path` is one of `roots` or lies inside one (all real, absolute paths). */
export function insideRoots(roots: readonly string[], path: string): boolean {
  return roots.some((root) => root === path || isInside(root, path));
}

/** Why {@link openChecked} did not hand out a file. */
export type OpenRefusal = "unopenable" | "not_regular" | "changed" | "too_large";

/** What {@link openChecked} found: an open handle the caller must close, or why not. */
export type OpenOutcome =
  | {
      readonly ok: true;
      readonly handle: FileHandle;
      readonly size: number;
      /** Last modification, milliseconds since the epoch. */
      readonly modifiedMs: number;
    }
  | { readonly ok: false; readonly reason: OpenRefusal; readonly size?: number | undefined };

/**
 * Opens `target` read-only, without following a symbolic link and without blocking, and checks on
 * the open handle that it is a regular file, the same inode the path check saw, still inside
 * `roots` ({@link openedInside}) and at most `maxBytes`. On success the caller owns the handle and
 * must close it; otherwise the handle is closed here and the reason returned.
 */
export async function openChecked(
  target: Located,
  roots: readonly string[],
  maxBytes: number,
): Promise<OpenOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(target.real, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    return { ok: false, reason: "unopenable" };
  }
  let outcome: OpenOutcome;
  try {
    outcome = await checkOpened(handle, target, roots, maxBytes);
  } catch (error) {
    await handle.close();
    throw error;
  }
  if (!outcome.ok) await handle.close();
  return outcome;
}

async function checkOpened(
  handle: FileHandle,
  target: Located,
  roots: readonly string[],
  maxBytes: number,
): Promise<OpenOutcome> {
  const info = await handle.stat();
  if (!info.isFile()) return { ok: false, reason: "not_regular" };
  if (info.ino !== target.ino || info.dev !== target.dev) return { ok: false, reason: "changed" };
  const inside = (path: string): boolean => roots.some((root) => isInside(root, path));
  if (!(await openedInside(handle, target.real, info, inside))) {
    return { ok: false, reason: "changed" };
  }
  if (info.size > maxBytes) return { ok: false, reason: "too_large", size: info.size };
  return { ok: true, handle, size: info.size, modifiedMs: info.mtimeMs };
}

type TargetKind = "file" | "folder";

/**
 * The checks before any file system call on `requested` (see the module doc), then the configured
 * folders that exist. `requested` is `undefined` when a scan reads every configured folder.
 */
async function checkedRoots(
  fileDirs: readonly string[],
  requested: string | undefined,
  kind: TargetKind,
  shown: string,
): Promise<Root[]> {
  if (fileDirs.length === 0) {
    throw refusal(
      "Reading local files is off: SEVDESK_FILE_DIRS is not set (in the Claude Desktop " +
        "extension: the setting Receipt folder). The user can list the folders that hold " +
        "receipts and e-invoices in the MCP client configuration and restart the server",
    );
  }
  if (requested !== undefined) {
    if (requested.trim() === "" || requested.includes("\0")) {
      throw refusal(`The ${kind} path is empty or invalid`);
    }
    if (findHiddenCharacters(requested, { allowNewlines: false }).length > 0) {
      throw refusal(`The ${kind} path for ${shown} contains invisible or control characters`);
    }
    if (NETWORK_OR_DEVICE_PATH.test(requested.trim())) {
      throw refusal(
        `${shown} is a network or device path; only ${kind}s inside SEVDESK_FILE_DIRS can be read`,
      );
    }
  }
  const roots = await realDirectories(fileDirs);
  if (roots.length === 0) throw refusal(NO_FOLDER_EXISTS);
  return roots;
}

/** Recognizes a file kind by its first bytes; `undefined` when none matches. */
export function sniffKind(bytes: Uint8Array): LocalFileKind | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  // PDF readers accept up to 1,024 bytes of junk before the header; so do we.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1_024 + 5));
  if (head.includes("%PDF-")) return "pdf";
  let offset = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (offset < bytes.length && isXmlSpace(bytes[offset])) offset += 1;
  if (bytes[offset] === 0x3c /* < */) return "xml";
  return undefined;
}

/** A configured directory as written (resolved) and as its real path. */
interface Root {
  readonly configured: string;
  readonly real: string;
}

async function realDirectories(fileDirs: readonly string[]): Promise<Root[]> {
  const roots: Root[] = [];
  for (const dir of fileDirs) {
    try {
      const real = await realpath(dir);
      if ((await stat(real)).isDirectory()) roots.push({ configured: resolve(dir), real });
    } catch {
      // A missing folder is skipped; another configured one may still hold the file.
    }
  }
  return roots;
}

/**
 * Finds `requested` inside `roots`: a file strictly inside a folder, or a folder (a configured
 * folder itself included). Lexical containment first, then the real path.
 */
async function locate(
  roots: readonly Root[],
  requested: string,
  shown: string,
  kind: TargetKind,
): Promise<Located> {
  const bounds = roots.flatMap((root) => [root.configured, root.real]);
  const within =
    kind === "file"
      ? isInside
      : (root: string, path: string): boolean => root === path || isInside(root, path);
  // Lexical containment first: nothing outside the folders is ever handed to the file system.
  const candidates = isAbsolute(requested)
    ? [resolve(requested)].filter((path) => bounds.some((bound) => within(bound, path)))
    : bounds
        .map((bound) => resolve(bound, requested))
        .filter((path, index) => within(bounds[index] ?? "", path));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (!roots.some((root) => within(root.real, real))) continue;
    // Removed or renamed since `realpath`: as missing, so the one refusal below answers.
    const info = await stat(real).catch(() => undefined);
    if (info === undefined) continue;
    if (kind === "file" ? !info.isFile() : !info.isDirectory()) {
      throw refusal(`${shown} is not a ${kind === "file" ? "regular file" : "folder"}`);
    }
    return { real, dev: info.dev, ino: info.ino };
  }
  // One message for "missing" and "outside": no existence oracle for files elsewhere.
  throw refusal(
    `${shown} is not a readable ${kind} inside the folders listed in SEVDESK_FILE_DIRS (it is ` +
      "missing, outside them, or reached through a symbolic link that leads outside). Pass an " +
      "absolute path or a path relative to one of those folders",
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Whether the file `handle` opened (stat `info`) is still the one at `real` inside the allowed
 * folders. `O_NOFOLLOW` guards only the last path component: a folder on the way replaced by a
 * symbolic link between resolving the path and opening it led outside (security review 2026-11,
 * finding 10). On Linux the kernel tells the opened file's path (`/proc/self/fd`), which settles
 * it. Elsewhere (macOS has no such lookup, and Node has no `openat`) the path is resolved again: it
 * must still be `real`, inside, and the same file. That catches a lasting swap; a swap undone in
 * the microseconds between the calls is not caught, and needs someone who can already rename
 * folders inside the allowed ones on the server's machine.
 */
export async function openedInside(
  handle: FileHandle,
  real: string,
  info: { readonly dev: number; readonly ino: number },
  inside: (path: string) => boolean,
): Promise<boolean> {
  const kernelPath = await readlink(`/proc/self/fd/${String(handle.fd)}`).catch(() => undefined);
  if (kernelPath !== undefined && isAbsolute(kernelPath)) return inside(kernelPath);
  const again = await realpath(real).catch(() => undefined);
  if (again !== real || !inside(again)) return false;
  const current = await stat(again).catch(() => undefined);
  return current?.dev === info.dev && current.ino === info.ino;
}

async function readAtMost(handle: FileHandle, maxBytes: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(maxBytes + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
    if (filled > maxBytes) {
      throw refusal(`The file grew beyond the limit of ${String(maxBytes)} bytes while reading`);
    }
  }
  return buffer.slice(0, filled);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isXmlSpace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** The requested file's or folder's base name for messages, sanitized and quoted. */
function displayName(requested: string, kind: TargetKind): string {
  const name = sanitizeUntrusted(basename(requested.replaceAll("\\", "/")), 80);
  return name === "" ? `The ${kind}` : `The ${kind} ${JSON.stringify(name)}`;
}

function refusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
