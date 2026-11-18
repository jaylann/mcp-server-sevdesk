/**
 * Downloads from https links that a write tool does before it takes its locks
 * (`WriteToolDefinition.preload`, `src/tools/write-flow.ts`).
 *
 * A lock such as `ACCOUNT_VOUCHER_DRAFTS` serializes every voucher draft call of an account from
 * `prepare` to the end of `execute`, so that a duplicate check and the write it guards do not
 * interleave. Downloading a receipt from a link inside it let one slow host (up to the download
 * timeout of `./url-files.ts`) hold up every other draft call of the account. The download does
 * not depend on anything the lock protects: it reads an outside host, never sevDesk, and its bytes
 * are checked in `prepare` as before (kind, size, `fileSha256`, the preview's SHA-256). So it can
 * run before the lock, as long as `prepare` then works with exactly those bytes:
 *
 * - {@link LinkPrefetcher.prefetch} downloads a link through the call's {@link FileAccess} (same
 *   confinement, limits and cancellation) and keeps the outcome, the file or the error;
 * - the {@link FileAccess} handed to `prepare` and `execute` gives that outcome to the first
 *   {@link FileAccess.read} of the same link with the same `maxBytes` and `kinds`, once. Every other
 *   read (another link, other options, a second read of the link, a local path, an upload) goes to
 *   the call's file access unchanged, so a local file or an upload is still read inside the lock,
 *   and an upload released by an earlier call is still refused there.
 *
 * Nothing outlives the call: the outcomes belong to one tool call, like the bytes of a link always
 * did. An outcome no read takes (a `prepare` that refused before reading the file) is dropped
 * with the call, as the download would never have happened before.
 */
import { type FileAccess, type InputFile, isUrlRef, type ReadFileOptions } from "./file-access.js";

/** What a tool's `preload` may do with files: start link downloads, nothing else. */
export interface LinkPrefetcher {
  /**
   * Downloads `ref` now when it is a link ({@link isUrlRef}) and keeps the outcome for the next
   * read of `ref` with the same `maxBytes` and `kinds` in this call (see the module comment).
   * Resolves when the download has settled and never rejects: a failed download fails that read,
   * where `prepare` would have met the failure anyway. Any other reference is left alone.
   */
  prefetch(ref: string, options: ReadFileOptions): Promise<void>;
}

/** The two sides of one call's link prefetching. */
export interface PrefetchedFiles {
  /** For the tool's `preload`, before the locks are taken. */
  readonly prefetcher: LinkPrefetcher;
  /** For `prepare` and `execute`: the call's file access, handing out prefetched downloads. */
  readonly files: FileAccess;
}

/** Link prefetching over `files`, the file access of one tool call. */
export function prefetchLinks(files: FileAccess): PrefetchedFiles {
  const outcomes = new Map<string, Promise<InputFile>>();
  return {
    prefetcher: {
      async prefetch(ref, options) {
        if (!isUrlRef(ref)) return;
        const key = outcomeKey(ref, options);
        if (outcomes.has(key)) return;
        const download = files.read(ref, options);
        outcomes.set(key, download);
        // The outcome waits for `read`, which rethrows a failure; only settle here.
        await download.then(
          () => undefined,
          () => undefined,
        );
      },
    },
    files: {
      canRead: files.canRead,
      canDeliver: files.canDeliver,
      requestUpload: (purpose) => files.requestUpload(purpose),
      requestUploadBatch: (purpose, count) => files.requestUploadBatch(purpose, count),
      listUploads: (batchId) => files.listUploads(batchId),
      read(ref, options) {
        const key = outcomeKey(ref, options);
        const prefetched = outcomes.get(key);
        if (prefetched === undefined) return files.read(ref, options);
        outcomes.delete(key);
        return prefetched;
      },
      scanFolder: (folder, options) => files.scanFolder(folder, options),
      release: (ref) => {
        files.release(ref);
      },
      deliver: (file) => files.deliver(file),
      checkDelivery: () => files.checkDelivery(),
      describeDelivery: () => files.describeDelivery(),
    },
  };
}

/** A read matches a prefetch with the same link, size limit and kinds; the signal does not count. */
function outcomeKey(ref: string, options: ReadFileOptions): string {
  return JSON.stringify([ref, options.maxBytes, [...options.kinds]]);
}
