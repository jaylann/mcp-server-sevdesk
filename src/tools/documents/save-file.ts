/**
 * Saving document files into `SEVDESK_OUTPUT_DIR`, the only local directory any tool writes to
 * (`sevdesk_document_save`). Writing there changes nothing in sevDesk, which is why that tool
 * stays in the read tier, declared with `localEffects: "writes-files"` and `readOnlyHint: false`.
 *
 * Confinement rules:
 * - the directory must be configured, exist and be a writable directory; its real path (symlinks
 *   resolved once, up front) is the boundary;
 * - the file name must be a plain basename (callers pass `safeFilename` output), so the target
 *   is always a direct child of that real path;
 * - files are created exclusively (`O_CREAT | O_EXCL`): an existing file is never overwritten,
 *   and a symlink planted under the target name is never followed (exclusive creation fails on
 *   any existing directory entry, dangling symlinks included). The next free name gets a numeric
 *   suffix (`RE-1001-1.pdf`, `RE-1001-2.pdf`, …, at most `-99`), which also bounds how many
 *   copies a looping model can pile up per document;
 * - new files get mode 0600: invoices carry personal and business data.
 */
import { constants } from "node:fs";
import { access, type FileHandle, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { openedInside } from "../../safety/local-files.js";
import { SevdeskError } from "../../sevdesk/errors.js";

/** Suffixes tried after the plain name before giving up. */
const MAX_SUFFIX = 99;
const FILE_MODE = 0o600;

/**
 * Resolves and checks the configured output directory before anything is fetched, so a
 * misconfiguration costs no sevDesk request. Returns its real path. Throws a local `validation`
 * {@link SevdeskError} (trusted text naming the setting) when it is unset, missing, not a
 * directory or not writable.
 */
export async function resolveOutputDir(configured: string | undefined): Promise<string> {
  if (configured === undefined) {
    throw refused(
      "saveToDisk needs an output directory, but SEVDESK_OUTPUT_DIR is not set. The user can " +
        "set it to an existing folder in the MCP client configuration and restart the server; " +
        "until then call the tool without saveToDisk",
    );
  }
  let real: string;
  try {
    real = await realpath(configured);
  } catch {
    throw refused(`SEVDESK_OUTPUT_DIR (${configured}) does not exist; the user has to create it`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw refused(`SEVDESK_OUTPUT_DIR (${configured}) is not a directory`);
  }
  try {
    await access(real, constants.W_OK);
  } catch {
    throw refused(`SEVDESK_OUTPUT_DIR (${configured}) is not writable for the server`);
  }
  return real;
}

/**
 * Writes `bytes` to a new file named `filename` (or `<stem>-<n><ext>` when taken) directly inside
 * `directory`, which must be a real path from {@link resolveOutputDir}. Returns the path written.
 * Never overwrites; removes a partly written file when writing fails.
 */
export async function writeNewFile(
  directory: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  if (filename !== basename(filename) || filename === "." || filename === ".." || filename === "") {
    throw new Error("writeNewFile: the file name must be a plain basename.");
  }
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);

  for (let suffix = 0; suffix <= MAX_SUFFIX; suffix += 1) {
    const candidate = suffix === 0 ? filename : `${stem}-${suffix}${extension}`;
    const target = join(directory, candidate);
    if (dirname(target) !== directory) {
      throw new Error("writeNewFile: the target would leave the output directory.");
    }
    let handle: FileHandle;
    try {
      handle = await open(target, "wx", FILE_MODE);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    // Before a byte is written: the output folder (or one above it) may have been replaced by a
    // link elsewhere since it was resolved. The new file stays empty and is not removed: removing
    // it by its path would follow the replaced folder and could delete someone else's file of
    // the same name there (security review 2026-11, wave 2).
    const created = await handle.stat();
    const placed = await openedInside(handle, target, created, (path) => {
      return dirname(path) === directory;
    });
    if (!placed) {
      await handle.close();
      throw refused(
        `SEVDESK_OUTPUT_DIR changed while the file was being created (a folder was replaced); ` +
          `nothing was saved, an empty file named ${candidate} may be left behind. The user ` +
          "should check the folder",
      );
    }
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      // Empty it through the handle (no path involved), then remove it only while its path still
      // names this very file.
      await handle.truncate(0).catch(() => undefined);
      await handle.close();
      const now = await stat(target).catch(() => undefined);
      if (now?.dev === created.dev && now.ino === created.ino) {
        await unlink(target).catch(() => undefined);
      }
      throw error;
    }
    await handle.close();
    return target;
  }
  throw new Error(
    `writeNewFile: ${MAX_SUFFIX + 1} files named like ${filename} already exist in the output directory.`,
  );
}

/**
 * A local refusal before anything is sent to sevDesk: a `validation` {@link SevdeskError}
 * without HTTP status, whose trusted `reason` the tool error says as is.
 */
export function refused(reason: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `${reason}.` });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
