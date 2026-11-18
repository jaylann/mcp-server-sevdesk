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
 * with the call ({@link PrefetchedFiles.dispose}), as the download would never have happened
 * before.
 *
 * At most {@link MAX_ACCOUNT_PREFETCHES} outcome per account waits at a time. The download limits
 * of `./url-files.ts` count only running downloads, but a prefetched file is held in memory until
 * its call gets the lock, and calls queue behind it: without this cap, an account's calls could
 * park one body after another (up to the size limit each) while one call held the lock, and a
 * third link draft sent at once was refused by the per-account download limit instead of waiting
 * (review of #146). A prefetch over the cap downloads nothing; `prepare` then reads the link inside
 * the lock, as before the prefetch existed. With one prefetch and one download inside the lock, an
 * account stays within the two downloads `./url-files.ts` allows it.
 */
import { type FileAccess, type InputFile, isUrlRef, type ReadFileOptions } from "./file-access.js";

/** Untaken prefetches per account (see the module comment). */
const MAX_ACCOUNT_PREFETCHES = 1;

/** Untaken prefetches per account; an account without any has no entry. */
const accountPrefetches = new Map<string, number>();

/** What a tool's `preload` may do with files: start link downloads, nothing else. */
export interface LinkPrefetcher {
  /**
   * Downloads `ref` now when it is a link ({@link isUrlRef}) and keeps the outcome for the next
   * read of `ref` with the same `maxBytes` and `kinds` in this call (see the module comment).
   * Resolves when the download has settled and never rejects: a failed download fails that read,
   * where `prepare` would have met the failure anyway. Any other reference is left alone, and so
   * is a link while the account already has an untaken prefetch ({@link MAX_ACCOUNT_PREFETCHES}).
   */
  prefetch(ref: string, options: ReadFileOptions): Promise<void>;
}

/** The two sides of one call's link prefetching. */
export interface PrefetchedFiles {
  /** For the tool's `preload`, before the locks are taken. */
  readonly prefetcher: LinkPrefetcher;
  /** For `prepare` and `execute`: the call's file access, handing out prefetched downloads. */
  readonly files: FileAccess;
  /**
   * Drops the outcomes no read took and frees their place in the account's cap. Called once the
   * call is done (`runWriteTool`), also when it failed or was refused.
   */
  dispose(): void;
}

/**
 * Link prefetching over `files`, the file access of one tool call, for `account`
 * (`RequestPrincipal.accountScope`), whose untaken prefetches are capped.
 */
export function prefetchLinks(files: FileAccess, account: string): PrefetchedFiles {
  const outcomes = new Map<string, Promise<InputFile>>();
  const free = (key: string): void => {
    if (!outcomes.delete(key)) return;
    const left = (accountPrefetches.get(account) ?? 1) - 1;
    if (left > 0) accountPrefetches.set(account, left);
    else accountPrefetches.delete(account);
  };
  return {
    prefetcher: {
      async prefetch(ref, options) {
        if (!isUrlRef(ref)) return;
        const key = outcomeKey(ref, options);
        if (outcomes.has(key)) return;
        const waiting = accountPrefetches.get(account) ?? 0;
        if (waiting >= MAX_ACCOUNT_PREFETCHES) return;
        const download = files.read(ref, options);
        outcomes.set(key, download);
        accountPrefetches.set(account, waiting + 1);
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
        free(key);
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
    dispose() {
      for (const key of [...outcomes.keys()]) free(key);
    },
  };
}

/** A read matches a prefetch with the same link, size limit and kinds; the signal does not count. */
function outcomeKey(ref: string, options: ReadFileOptions): string {
  return JSON.stringify([ref, options.maxBytes, [...options.kinds]]);
}
