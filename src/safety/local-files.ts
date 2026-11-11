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
  if (fileDirs.length === 0) {
    throw refusal(
      "Reading local files is off: SEVDESK_FILE_DIRS is not set (in the Claude Desktop " +
        "extension: the setting Receipt folder). The user can list the folders that hold " +
        "receipts and e-invoices in the MCP client configuration and restart the server",
    );
  }
  const shown = displayName(requested);
  if (requested.trim() === "" || requested.includes("\0")) {
    throw refusal("The file path is empty or invalid");
  }
  if (findHiddenCharacters(requested, { allowNewlines: false }).length > 0) {
    throw refusal(`The file path for ${shown} contains invisible or control characters`);
  }

  if (NETWORK_OR_DEVICE_PATH.test(requested.trim())) {
    throw refusal(
      `${shown} is a network or device path; only files inside SEVDESK_FILE_DIRS can be read`,
    );
  }

  const roots = await realDirectories(fileDirs);
  if (roots.length === 0) {
    throw refusal(
      "None of the folders in SEVDESK_FILE_DIRS exists; the user has to create them or fix the " +
        "setting",
    );
  }

  const target = await locate(roots, requested, shown);
  let handle: FileHandle;
  try {
    handle = await open(target.real, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    throw refusal(`${shown} cannot be opened (missing, not readable, or a symbolic link)`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refusal(`${shown} is not a regular file`);
    if (info.ino !== target.ino || info.dev !== target.dev) {
      throw refusal(`${shown} changed while it was being read; try again`);
    }
    const inRoots = (path: string): boolean => roots.some((root) => isInside(root.real, path));
    if (!(await openedInside(handle, target.real, info, inRoots))) {
      throw refusal(`${shown} changed while it was being read; try again`);
    }
    if (info.size > options.maxBytes) {
      throw refusal(
        `${shown} has ${String(info.size)} bytes; the limit is ${String(options.maxBytes)} bytes`,
      );
    }
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

interface Located {
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
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

async function locate(roots: readonly Root[], requested: string, shown: string): Promise<Located> {
  const bounds = roots.flatMap((root) => [root.configured, root.real]);
  // Lexical containment first: nothing outside the folders is ever handed to the file system.
  const candidates = isAbsolute(requested)
    ? [resolve(requested)].filter((path) => bounds.some((bound) => isInside(bound, path)))
    : bounds
        .map((bound) => resolve(bound, requested))
        .filter((path, index) => isInside(bounds[index] ?? "", path));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (!roots.some((root) => isInside(root.real, real))) continue;
    const info = await stat(real);
    if (!info.isFile()) throw refusal(`${shown} is not a regular file`);
    return { real, dev: info.dev, ino: info.ino };
  }
  // One message for "missing" and "outside": no existence oracle for files elsewhere.
  throw refusal(
    `${shown} is not a readable file inside the folders listed in SEVDESK_FILE_DIRS (it is ` +
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

/** The requested file's base name for messages, sanitized and quoted. */
function displayName(requested: string): string {
  const name = sanitizeUntrusted(basename(requested.replaceAll("\\", "/")), 80);
  return name === "" ? "The file" : `The file ${JSON.stringify(name)}`;
}

function refusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
