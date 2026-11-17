/**
 * Reads the entry list of a ZIP archive from its central directory, without unpacking anything:
 * enough to count what sevDesk put into an export (one PDF per document in the archive exports,
 * D-101; inner ZIPs in the DATEV XML export, D-102) and to check that the body is a whole archive
 * rather than a truncated or foreign one.
 *
 * Only the classic format is read (no ZIP64: archives below 4 GiB with fewer than 65,535 entries,
 * far above this server's download caps). Entry names are sevDesk data (voucher descriptions,
 * invoice numbers): callers count them and match patterns, and never return them to the model.
 */

/** One entry of the central directory. */
export interface ZipEntry {
  /** The stored name (UTF-8 when the archive says so; decoded leniently otherwise). */
  readonly name: string;
  /** Uncompressed size in bytes, as the directory states it. */
  readonly size: number;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_HEADER = 0x02014b50;
const END_RECORD_LENGTH = 22;
const DIRECTORY_HEADER_LENGTH = 46;
/** The end record ends the file, followed by a comment of at most 65,535 bytes. */
const MAX_COMMENT = 0xffff;
/** Markers that the real values are in a ZIP64 record, which this reader does not follow. */
const ZIP64_COUNT = 0xffff;
const ZIP64_OFFSET = 0xffffffff;

/**
 * The entries of a ZIP archive, in directory order, or `undefined` when `bytes` hold no readable
 * classic ZIP: no end record, a directory outside the file, a header that does not match, or a
 * ZIP64 archive. An empty archive gives an empty list.
 */
export function listZipEntries(bytes: Uint8Array): readonly ZipEntry[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);
  if (end === undefined) return undefined;
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === ZIP64_COUNT || directoryOffset === ZIP64_OFFSET) return undefined;
  if (directoryOffset + directorySize > end) return undefined;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntry[] = [];
  let position = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + DIRECTORY_HEADER_LENGTH > end) return undefined;
    if (view.getUint32(position, true) !== DIRECTORY_HEADER) return undefined;
    const size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const nameStart = position + DIRECTORY_HEADER_LENGTH;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > end) return undefined;
    entries.push({ name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)), size });
    position = next;
  }
  return entries;
}

/** Offset of the end-of-central-directory record, searched backwards from the end. */
function findEndRecord(view: DataView): number | undefined {
  const last = view.byteLength - END_RECORD_LENGTH;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_DIRECTORY) continue;
    // The comment length must reach exactly to the end of the file.
    if (offset + END_RECORD_LENGTH + view.getUint16(offset + 20, true) === view.byteLength) {
      return offset;
    }
  }
  return undefined;
}
