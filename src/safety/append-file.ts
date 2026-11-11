/**
 * Appending whole lines to the server's local state files (the audit log, the grant store), and
 * the ownership rule both apply to what they find on disk.
 *
 * Two things the plain file API leaves open:
 * - `FileHandle.write` may write fewer bytes than asked (a nearly full volume) and still resolve.
 *   A line that matters (an `executing` audit line, a revocation) would then be cut, and a cut
 *   last line is skipped by whoever reads the file next. {@link appendLine} writes every byte or
 *   rejects, and starts on a fresh line when an earlier failure left one unfinished.
 * - Mode bits say nothing about who owns a file, and on macOS an ACL can grant access the mode
 *   does not show. {@link ownedByOtherUser} is the owner check: a file or folder that belongs to
 *   another user can be changed by that user whatever its mode says.
 */
import type { FileHandle } from "node:fs/promises";

/** Writes all of `bytes` through `handle`, or rejects; a write that makes no progress is an error. */
export async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
    if (bytesWritten <= 0) {
      throw Object.assign(new Error("a write made no progress"), { code: "WRITE_NO_PROGRESS" });
    }
    written += bytesWritten;
  }
}

/**
 * Appends `line` (which ends with a line feed) as a line of its own. `handle` must be open for
 * reading and appending (`O_RDWR | O_APPEND`): the last byte is read first, and when it is not a
 * line feed (an earlier append was cut short) the line starts with one, so it stays parseable.
 * Every byte is written, or the call rejects.
 */
export async function appendLine(handle: FileHandle, line: string): Promise<void> {
  const { size } = await handle.stat();
  const last = Buffer.alloc(1);
  const endsLine =
    size === 0 || ((await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] === 0x0a);
  await writeAll(handle, Buffer.from(endsLine ? line : `\n${line}`, "utf8"));
}

/** The user id of this process, where the platform has one (not on Windows). */
export type GetUid = () => number;

/**
 * Whether `info` (a `stat` result) belongs to a user other than the one this process runs as.
 * Always false where the platform has no user ids (Windows); `getuid` is injectable for tests.
 */
export function ownedByOtherUser(
  info: { readonly uid: number },
  getuid: GetUid | undefined = process.getuid?.bind(process),
): boolean {
  return getuid !== undefined && info.uid !== getuid();
}
